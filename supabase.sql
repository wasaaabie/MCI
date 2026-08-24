-- MCI Board: Einsätze, Patienten, Mitglieder und Zugriffsregeln
-- Dieses Skript vollständig im Supabase SQL Editor ausführen.
-- Es kann auch bei einer bestehenden Installation erneut ausgeführt werden.

create table if not exists public.mci_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

create table if not exists public.incidents (
  id uuid primary key,
  title text not null,
  location text,
  scene_lead text not null,
  description text,
  status text not null default 'active' check (status in ('active', 'closed')),
  started_at timestamptz not null default now(),
  closed_at timestamptz,
  created_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.patients (
  id uuid primary key,
  incident_id uuid not null references public.incidents(id) on delete restrict,
  data jsonb not null default '{}'::jsonb,
  updated_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.activity_log (
  id bigint generated always as identity primary key,
  incident_id uuid not null references public.incidents(id) on delete restrict,
  patient_id uuid,
  action text not null,
  subject_label text,
  changed_fields text[] not null default '{}'::text[],
  user_id uuid references auth.users(id) on delete set null,
  display_name text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.bulletin_entries (
  id uuid primary key,
  patient_name text not null,
  phone text not null,
  concern text not null,
  status text not null default 'open' check (status in ('open', 'done')),
  created_by uuid not null references auth.users(id),
  created_by_name text not null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  updated_by_name text,
  updated_at timestamptz,
  completed_by uuid references auth.users(id),
  completed_by_name text,
  completed_at timestamptz
);

create table if not exists public.lab_requests (
  id uuid primary key,
  patient_name text not null,
  phone text not null,
  sample_number text,
  note text not null,
  status text not null default 'open' check (status in ('open', 'done')),
  created_by uuid not null references auth.users(id),
  created_by_name text not null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  updated_by_name text,
  updated_at timestamptz,
  completed_by uuid references auth.users(id),
  completed_by_name text,
  completed_at timestamptz
);

create table if not exists public.deceased_records (
  id uuid primary key,
  patient_name text not null,
  date_of_death date not null,
  suspected_circumstances text not null,
  contact_information text,
  burial_date date,
  autopsy_approved boolean not null default false,
  autopsy_report boolean not null default false,
  chamber_occupied boolean not null default false,
  chamber_number smallint,
  created_by uuid not null references auth.users(id),
  created_by_name text not null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  updated_by_name text,
  updated_at timestamptz,
  constraint deceased_records_chamber_number_check check (chamber_number between 1 and 16),
  constraint deceased_records_chamber_state_check check (
    (chamber_occupied and chamber_number is not null)
    or (not chamber_occupied and chamber_number is null)
  )
);

alter table public.bulletin_entries add column if not exists updated_by uuid references auth.users(id);
alter table public.bulletin_entries add column if not exists updated_by_name text;
alter table public.bulletin_entries add column if not exists updated_at timestamptz;

alter table public.incidents add column if not exists scene_lead text;
update public.incidents set scene_lead = 'Unbekannt' where scene_lead is null or btrim(scene_lead) = '';
alter table public.incidents alter column scene_lead set not null;

-- Ergänzt die MCI-Zuordnung bei einer bereits vorhandenen Patiententabelle.
alter table public.patients add column if not exists incident_id uuid;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.patients'::regclass
      and conname = 'patients_incident_id_fkey'
  ) then
    alter table public.patients
      add constraint patients_incident_id_fkey
      foreign key (incident_id) references public.incidents(id) on delete restrict;
  end if;
end $$;

-- Vorhandene gemeinsame Patientendaten werden einmalig in einer abgeschlossenen MCI archiviert.
do $$
declare
  owner_id uuid;
  archive_id uuid;
begin
  if exists (select 1 from public.patients where incident_id is null) then
    select user_id into owner_id from public.mci_members order by created_at limit 1;
    if owner_id is null then
      raise exception 'Vorhandene Patienten gefunden, aber kein Benutzer in mci_members. Zuerst ein Mitglied freigeben.';
    end if;
    archive_id := gen_random_uuid();
    insert into public.incidents (id, title, scene_lead, description, status, started_at, closed_at, created_by)
    values (archive_id, 'Übernommene MCI', 'Unbekannt', 'Automatisch aus der bisherigen gemeinsamen Patientenliste übernommen.', 'closed', now(), now(), owner_id);
    update public.patients set incident_id = archive_id where incident_id is null;
  end if;
end $$;

alter table public.patients alter column incident_id set not null;
create index if not exists patients_incident_id_idx on public.patients (incident_id);
create index if not exists incidents_status_started_idx on public.incidents (status, started_at desc);
create index if not exists activity_log_incident_created_idx on public.activity_log (incident_id, created_at desc);
create index if not exists bulletin_entries_status_created_idx on public.bulletin_entries (status, created_at desc);
create index if not exists lab_requests_status_created_idx on public.lab_requests (status, created_at desc);
create index if not exists deceased_records_death_date_idx on public.deceased_records (date_of_death desc);
create unique index if not exists deceased_records_occupied_chamber_idx
on public.deceased_records (chamber_number) where chamber_occupied;

create or replace function public.log_patient_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  action_name text;
  incident_value uuid;
  patient_value uuid;
  patient_data jsonb;
  subject_value text;
  actor_name text;
  changed_value text[] := '{}'::text[];
begin
  if tg_op = 'INSERT' then
    action_name := 'patient_created'; incident_value := new.incident_id; patient_value := new.id; patient_data := new.data;
  elsif tg_op = 'UPDATE' then
    if old.data is not distinct from new.data then return new; end if;
    action_name := 'patient_updated'; incident_value := new.incident_id; patient_value := new.id; patient_data := new.data;
    select coalesce(array_agg(key order by key), '{}'::text[]) into changed_value
    from (
      select key
      from jsonb_object_keys(coalesce(old.data, '{}'::jsonb) || coalesce(new.data, '{}'::jsonb)) as keys(key)
      where old.data -> key is distinct from new.data -> key
        and key not in ('createdAt', 'updatedAt')
    ) changed;
    if cardinality(changed_value) = 0 then return new; end if;
  else
    action_name := 'patient_deleted'; incident_value := old.incident_id; patient_value := old.id; patient_data := old.data;
  end if;

  subject_value := coalesce(nullif(patient_data ->> 'patientNumber', ''), nullif(patient_data ->> 'name', ''), 'Unbekannt');
  select display_name into actor_name from public.mci_members where user_id = auth.uid();
  actor_name := coalesce(actor_name, 'Unbekannt');
  insert into public.activity_log (incident_id, patient_id, action, subject_label, changed_fields, user_id, display_name)
  values (incident_value, patient_value, action_name, subject_value, changed_value, auth.uid(), actor_name);
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

create or replace function public.log_incident_activity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  action_name text;
  actor_name text;
begin
  if tg_op = 'INSERT' then action_name := 'incident_created';
  elsif old.status = 'active' and new.status = 'closed' then action_name := 'incident_closed';
  else return new;
  end if;
  select display_name into actor_name from public.mci_members where user_id = auth.uid();
  actor_name := coalesce(actor_name, 'Unbekannt');
  insert into public.activity_log (incident_id, action, subject_label, changed_fields, user_id, display_name)
  values (new.id, action_name, new.title, case when action_name = 'incident_closed' then array['status'] else '{}'::text[] end, auth.uid(), actor_name);
  return new;
end;
$$;

create or replace function public.protect_bulletin_entry()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_name text;
begin
  select display_name into actor_name from public.mci_members where user_id = auth.uid();
  actor_name := coalesce(actor_name, 'Unbekannt');
  if tg_op = 'INSERT' then
    new.created_by := auth.uid();
    new.created_by_name := actor_name;
    new.created_at := now();
    new.status := 'open';
    new.updated_by := null; new.updated_by_name := null; new.updated_at := null;
    new.completed_by := null; new.completed_by_name := null; new.completed_at := null;
    return new;
  end if;
  if old.status <> 'open' then
    raise exception 'Erledigte Einträge sind schreibgeschützt.';
  end if;
  new.created_by := old.created_by; new.created_by_name := old.created_by_name; new.created_at := old.created_at;
  if new.status = 'open' then
    new.updated_by := auth.uid(); new.updated_by_name := actor_name; new.updated_at := now();
    new.completed_by := null; new.completed_by_name := null; new.completed_at := null;
    return new;
  end if;
  if new.status <> 'done' then raise exception 'Ungültiger Statuswechsel.'; end if;
  new.patient_name := old.patient_name; new.phone := old.phone; new.concern := old.concern;
  new.updated_by := old.updated_by; new.updated_by_name := old.updated_by_name; new.updated_at := old.updated_at;
  new.completed_by := auth.uid(); new.completed_by_name := actor_name; new.completed_at := now();
  return new;
end;
$$;

create or replace function public.protect_lab_request()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_name text;
begin
  select display_name into actor_name from public.mci_members where user_id = auth.uid();
  actor_name := coalesce(actor_name, 'Unbekannt');
  if tg_op = 'INSERT' then
    new.created_by := auth.uid(); new.created_by_name := actor_name; new.created_at := now();
    new.status := 'open';
    new.updated_by := null; new.updated_by_name := null; new.updated_at := null;
    new.completed_by := null; new.completed_by_name := null; new.completed_at := null;
    return new;
  end if;
  if old.status <> 'open' then raise exception 'Erledigte Labor Requests sind schreibgeschützt.'; end if;
  new.created_by := old.created_by; new.created_by_name := old.created_by_name; new.created_at := old.created_at;
  if new.status = 'open' then
    new.updated_by := auth.uid(); new.updated_by_name := actor_name; new.updated_at := now();
    new.completed_by := null; new.completed_by_name := null; new.completed_at := null;
    return new;
  end if;
  if new.status <> 'done' then raise exception 'Ungültiger Statuswechsel.'; end if;
  new.patient_name := old.patient_name; new.phone := old.phone; new.sample_number := old.sample_number; new.note := old.note;
  new.updated_by := old.updated_by; new.updated_by_name := old.updated_by_name; new.updated_at := old.updated_at;
  new.completed_by := auth.uid(); new.completed_by_name := actor_name; new.completed_at := now();
  return new;
end;
$$;

create or replace function public.protect_deceased_record()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_name text;
begin
  select display_name into actor_name from public.mci_members where user_id = auth.uid();
  actor_name := coalesce(actor_name, 'Unbekannt');
  if new.chamber_occupied then
    if new.chamber_number is null or new.chamber_number < 1 or new.chamber_number > 16 then
      raise exception 'Für ein belegtes Fach muss eine Fachnummer zwischen 1 und 16 gewählt werden.';
    end if;
  else
    new.chamber_number := null;
  end if;
  if new.autopsy_report then new.autopsy_approved := true; end if;
  if tg_op = 'INSERT' then
    new.created_by := auth.uid(); new.created_by_name := actor_name; new.created_at := now();
    new.updated_by := null; new.updated_by_name := null; new.updated_at := null;
    return new;
  end if;
  new.created_by := old.created_by; new.created_by_name := old.created_by_name; new.created_at := old.created_at;
  new.updated_by := auth.uid(); new.updated_by_name := actor_name; new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists patients_activity_trigger on public.patients;
create trigger patients_activity_trigger after insert or update or delete on public.patients
for each row execute function public.log_patient_activity();

drop trigger if exists incidents_activity_trigger on public.incidents;
create trigger incidents_activity_trigger after insert or update on public.incidents
for each row execute function public.log_incident_activity();

drop trigger if exists bulletin_entries_protection_trigger on public.bulletin_entries;
create trigger bulletin_entries_protection_trigger before insert or update on public.bulletin_entries
for each row execute function public.protect_bulletin_entry();

drop trigger if exists lab_requests_protection_trigger on public.lab_requests;
create trigger lab_requests_protection_trigger before insert or update on public.lab_requests
for each row execute function public.protect_lab_request();

drop trigger if exists deceased_records_protection_trigger on public.deceased_records;
create trigger deceased_records_protection_trigger before insert or update on public.deceased_records
for each row execute function public.protect_deceased_record();

revoke execute on function public.log_patient_activity() from public, anon, authenticated;
revoke execute on function public.log_incident_activity() from public, anon, authenticated;
revoke execute on function public.protect_bulletin_entry() from public, anon, authenticated;
revoke execute on function public.protect_lab_request() from public, anon, authenticated;
revoke execute on function public.protect_deceased_record() from public, anon, authenticated;

alter table public.mci_members enable row level security;
alter table public.incidents enable row level security;
alter table public.patients enable row level security;
alter table public.activity_log enable row level security;
alter table public.bulletin_entries enable row level security;
alter table public.lab_requests enable row level security;
alter table public.deceased_records enable row level security;

revoke all on public.mci_members from anon, authenticated;
revoke all on public.incidents from anon, authenticated;
revoke all on public.patients from anon, authenticated;
revoke all on public.activity_log from anon, authenticated;
revoke all on public.bulletin_entries from anon, authenticated;
revoke all on public.lab_requests from anon, authenticated;
revoke all on public.deceased_records from anon, authenticated;
grant select on public.mci_members to authenticated;
grant select, insert, update on public.incidents to authenticated;
grant select, insert, update, delete on public.patients to authenticated;
grant select on public.activity_log to authenticated;
grant select, insert, update on public.bulletin_entries to authenticated;
grant select, insert, update on public.lab_requests to authenticated;
grant select, insert, update on public.deceased_records to authenticated;

drop policy if exists "Mitglied sieht eigene Freigabe" on public.mci_members;
create policy "Mitglied sieht eigene Freigabe"
on public.mci_members for select to authenticated
using (user_id = auth.uid());

drop policy if exists "Mitglieder lesen Protokoll" on public.activity_log;
create policy "Mitglieder lesen Protokoll"
on public.activity_log for select to authenticated
using (exists (select 1 from public.mci_members m where m.user_id = auth.uid()));

drop policy if exists "Mitglieder lesen Schwarzes Brett" on public.bulletin_entries;
create policy "Mitglieder lesen Schwarzes Brett"
on public.bulletin_entries for select to authenticated
using (exists (select 1 from public.mci_members m where m.user_id = auth.uid()));

drop policy if exists "Mitglieder erstellen Brett-Einträge" on public.bulletin_entries;
create policy "Mitglieder erstellen Brett-Einträge"
on public.bulletin_entries for insert to authenticated
with check (
  created_by = auth.uid() and status = 'open'
  and exists (select 1 from public.mci_members m where m.user_id = auth.uid())
);

drop policy if exists "Mitglieder erledigen Brett-Einträge" on public.bulletin_entries;
create policy "Mitglieder erledigen Brett-Einträge"
on public.bulletin_entries for update to authenticated
using (
  status = 'open'
  and exists (select 1 from public.mci_members m where m.user_id = auth.uid())
)
with check (
  exists (select 1 from public.mci_members m where m.user_id = auth.uid())
  and (
    (status = 'open' and updated_by = auth.uid() and completed_by is null)
    or (status = 'done' and completed_by = auth.uid())
  )
);

drop policy if exists "Mitglieder lesen Labor Requests" on public.lab_requests;
create policy "Mitglieder lesen Labor Requests"
on public.lab_requests for select to authenticated
using (exists (select 1 from public.mci_members m where m.user_id = auth.uid()));

drop policy if exists "Mitglieder erstellen Labor Requests" on public.lab_requests;
create policy "Mitglieder erstellen Labor Requests"
on public.lab_requests for insert to authenticated
with check (
  created_by = auth.uid() and status = 'open'
  and exists (select 1 from public.mci_members m where m.user_id = auth.uid())
);

drop policy if exists "Mitglieder bearbeiten Labor Requests" on public.lab_requests;
create policy "Mitglieder bearbeiten Labor Requests"
on public.lab_requests for update to authenticated
using (
  status = 'open'
  and exists (select 1 from public.mci_members m where m.user_id = auth.uid())
)
with check (
  exists (select 1 from public.mci_members m where m.user_id = auth.uid())
  and (
    (status = 'open' and updated_by = auth.uid() and completed_by is null)
    or (status = 'done' and completed_by = auth.uid())
  )
);

drop policy if exists "Mitglieder lesen Totenübersicht" on public.deceased_records;
create policy "Mitglieder lesen Totenübersicht"
on public.deceased_records for select to authenticated
using (exists (select 1 from public.mci_members m where m.user_id = auth.uid()));

drop policy if exists "Mitglieder erstellen Einträge der Totenübersicht" on public.deceased_records;
create policy "Mitglieder erstellen Einträge der Totenübersicht"
on public.deceased_records for insert to authenticated
with check (
  created_by = auth.uid()
  and exists (select 1 from public.mci_members m where m.user_id = auth.uid())
);

drop policy if exists "Mitglieder bearbeiten Einträge der Totenübersicht" on public.deceased_records;
create policy "Mitglieder bearbeiten Einträge der Totenübersicht"
on public.deceased_records for update to authenticated
using (exists (select 1 from public.mci_members m where m.user_id = auth.uid()))
with check (
  updated_by = auth.uid()
  and exists (select 1 from public.mci_members m where m.user_id = auth.uid())
);

drop policy if exists "Mitglieder lesen MCIs" on public.incidents;
create policy "Mitglieder lesen MCIs"
on public.incidents for select to authenticated
using (exists (select 1 from public.mci_members m where m.user_id = auth.uid()));

drop policy if exists "Mitglieder erstellen MCIs" on public.incidents;
create policy "Mitglieder erstellen MCIs"
on public.incidents for insert to authenticated
with check (
  created_by = auth.uid()
  and exists (select 1 from public.mci_members m where m.user_id = auth.uid())
);

drop policy if exists "Mitglieder schließen MCIs" on public.incidents;
create policy "Mitglieder schließen MCIs"
on public.incidents for update to authenticated
using (
  status = 'active'
  and exists (select 1 from public.mci_members m where m.user_id = auth.uid())
)
with check (
  status = 'closed'
  and exists (select 1 from public.mci_members m where m.user_id = auth.uid())
);

drop policy if exists "Mitglieder lesen Patienten" on public.patients;
create policy "Mitglieder lesen Patienten"
on public.patients for select to authenticated
using (exists (select 1 from public.mci_members m where m.user_id = auth.uid()));

drop policy if exists "Mitglieder erstellen Patienten" on public.patients;
create policy "Mitglieder erstellen Patienten"
on public.patients for insert to authenticated
with check (
  updated_by = auth.uid()
  and exists (select 1 from public.mci_members m where m.user_id = auth.uid())
  and exists (select 1 from public.incidents i where i.id = incident_id and i.status = 'active')
);

drop policy if exists "Mitglieder ändern Patienten" on public.patients;
create policy "Mitglieder ändern Patienten"
on public.patients for update to authenticated
using (
  exists (select 1 from public.mci_members m where m.user_id = auth.uid())
  and exists (select 1 from public.incidents i where i.id = incident_id and i.status = 'active')
)
with check (
  updated_by = auth.uid()
  and exists (select 1 from public.mci_members m where m.user_id = auth.uid())
  and exists (select 1 from public.incidents i where i.id = incident_id and i.status = 'active')
);

drop policy if exists "Mitglieder löschen Patienten" on public.patients;
create policy "Mitglieder löschen Patienten"
on public.patients for delete to authenticated
using (
  exists (select 1 from public.mci_members m where m.user_id = auth.uid())
  and exists (select 1 from public.incidents i where i.id = incident_id and i.status = 'active')
);

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'patients'
  ) then
    alter publication supabase_realtime add table public.patients;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'incidents'
  ) then
    alter publication supabase_realtime add table public.incidents;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'activity_log'
  ) then
    alter publication supabase_realtime add table public.activity_log;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'bulletin_entries'
  ) then
    alter publication supabase_realtime add table public.bulletin_entries;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'lab_requests'
  ) then
    alter publication supabase_realtime add table public.lab_requests;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'deceased_records'
  ) then
    alter publication supabase_realtime add table public.deceased_records;
  end if;
end $$;

-- Weitere Benutzer nach dem Anlegen unter Authentication → Users freigeben:
-- insert into public.mci_members (user_id, display_name)
-- select id, 'Anzeigename' from auth.users where email = 'name@example.com'
-- on conflict (user_id) do update set display_name = excluded.display_name;

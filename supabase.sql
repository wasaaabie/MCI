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

drop trigger if exists patients_activity_trigger on public.patients;
create trigger patients_activity_trigger after insert or update or delete on public.patients
for each row execute function public.log_patient_activity();

drop trigger if exists incidents_activity_trigger on public.incidents;
create trigger incidents_activity_trigger after insert or update on public.incidents
for each row execute function public.log_incident_activity();

revoke execute on function public.log_patient_activity() from public, anon, authenticated;
revoke execute on function public.log_incident_activity() from public, anon, authenticated;

alter table public.mci_members enable row level security;
alter table public.incidents enable row level security;
alter table public.patients enable row level security;
alter table public.activity_log enable row level security;

revoke all on public.mci_members from anon, authenticated;
revoke all on public.incidents from anon, authenticated;
revoke all on public.patients from anon, authenticated;
revoke all on public.activity_log from anon, authenticated;
grant select on public.mci_members to authenticated;
grant select, insert, update on public.incidents to authenticated;
grant select, insert, update, delete on public.patients to authenticated;
grant select on public.activity_log to authenticated;

drop policy if exists "Mitglied sieht eigene Freigabe" on public.mci_members;
create policy "Mitglied sieht eigene Freigabe"
on public.mci_members for select to authenticated
using (user_id = auth.uid());

drop policy if exists "Mitglieder lesen Protokoll" on public.activity_log;
create policy "Mitglieder lesen Protokoll"
on public.activity_log for select to authenticated
using (exists (select 1 from public.mci_members m where m.user_id = auth.uid()));

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
end $$;

-- Weitere Benutzer nach dem Anlegen unter Authentication → Users freigeben:
-- insert into public.mci_members (user_id, display_name)
-- select id, 'Anzeigename' from auth.users where email = 'name@example.com'
-- on conflict (user_id) do update set display_name = excluded.display_name;

-- MCI Board: Einsätze, Patienten, Mitglieder und Zugriffsregeln
-- Dieses Skript vollständig im Supabase SQL Editor ausführen.
-- Es kann auch bei einer bestehenden Installation erneut ausgeführt werden.

create table if not exists public.mci_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  can_delete_history boolean not null default false,
  can_manage_users boolean not null default false,
  can_access_psychology boolean not null default false,
  can_access_physiology boolean not null default false,
  can_access_fire_investigation boolean not null default false,
  created_at timestamptz not null default now()
);

alter table public.mci_members add column if not exists can_delete_history boolean not null default false;
alter table public.mci_members add column if not exists can_manage_users boolean not null default false;
alter table public.mci_members add column if not exists can_access_psychology boolean not null default false;
alter table public.mci_members add column if not exists can_access_physiology boolean not null default false;
alter table public.mci_members add column if not exists can_access_fire_investigation boolean not null default false;

-- Bei der erstmaligen Migration erhält das älteste freigegebene Konto die Benutzerverwaltung.
-- So bleibt die Funktion nach dem Update erreichbar, ohne pauschal alle Mitglieder hochzustufen.
update public.mci_members
set can_manage_users = true
where user_id = (
  select user_id from public.mci_members order by created_at, user_id limit 1
)
and not exists (select 1 from public.mci_members where can_manage_users);

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

create table if not exists public.normal_patient_handoffs (
  id uuid primary key,
  data jsonb not null default '{}'::jsonb,
  search_text text generated always as (coalesce(data ->> 'name', '') || ' ' || coalesce(data ->> 'unitOnSite', '') || ' ' || coalesce(data ->> 'destinationHospital', '') || ' ' || coalesce(data ->> 'physician', '') || ' ' || coalesce(data ->> 'treatmentArea', '')) stored,
  status text not null default 'active' check (status in ('active', 'closed')),
  updated_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_by uuid references auth.users(id),
  closed_by_name text,
  closed_at timestamptz
);

alter table public.normal_patient_handoffs add column if not exists search_text text generated always as (coalesce(data ->> 'name', '') || ' ' || coalesce(data ->> 'unitOnSite', '') || ' ' || coalesce(data ->> 'destinationHospital', '') || ' ' || coalesce(data ->> 'physician', '') || ' ' || coalesce(data ->> 'treatmentArea', '')) stored;
alter table public.normal_patient_handoffs add column if not exists status text not null default 'active' check (status in ('active', 'closed'));
alter table public.normal_patient_handoffs add column if not exists closed_by uuid references auth.users(id);
alter table public.normal_patient_handoffs add column if not exists closed_by_name text;
alter table public.normal_patient_handoffs add column if not exists closed_at timestamptz;

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
  department text,
  handled_by text,
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

create table if not exists public.psychology_records (
  id uuid primary key,
  file_number text not null,
  patient_name text not null,
  birth_date date,
  phone text,
  treating_staff text not null,
  general_notes text,
  status text not null default 'active' check (status in ('active', 'paused', 'closed')),
  created_by uuid not null references auth.users(id),
  created_by_name text not null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  updated_by_name text,
  updated_at timestamptz,
  closed_by uuid references auth.users(id),
  closed_by_name text,
  closed_at timestamptz
);

create table if not exists public.psychology_sessions (
  id uuid primary key,
  record_id uuid not null references public.psychology_records(id) on delete restrict,
  session_at timestamptz not null,
  treating_staff text not null,
  reason text not null,
  notes text not null,
  assessment text,
  measures text,
  next_appointment timestamptz,
  internal_note text,
  created_by uuid not null references auth.users(id),
  created_by_name text not null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  updated_by_name text,
  updated_at timestamptz
);

create table if not exists public.physiology_records (
  id uuid primary key,
  file_number text not null,
  patient_name text not null,
  birth_date date,
  phone text,
  treating_staff text not null,
  general_notes text,
  status text not null default 'active' check (status in ('active', 'paused', 'closed')),
  created_by uuid not null references auth.users(id),
  created_by_name text not null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  updated_by_name text,
  updated_at timestamptz,
  closed_by uuid references auth.users(id),
  closed_by_name text,
  closed_at timestamptz
);

create table if not exists public.physiology_sessions (
  id uuid primary key,
  record_id uuid not null references public.physiology_records(id) on delete restrict,
  session_at timestamptz not null,
  treating_staff text not null,
  reason text not null,
  notes text not null,
  assessment text,
  measures text,
  next_appointment timestamptz,
  internal_note text,
  created_by uuid not null references auth.users(id),
  created_by_name text not null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  updated_by_name text,
  updated_at timestamptz
);

create table if not exists public.fire_investigations (
  id uuid primary key,
  case_number text not null,
  status text not null default 'open' check (status in ('open', 'investigation', 'lab_pending', 'closed')),
  incident_date timestamptz not null,
  reported_at timestamptz,
  location text not null,
  lead_investigator text not null,
  involved_staff text,
  summary text,
  object_name text not null,
  object_type text,
  owner_operator text,
  origin_area text,
  damages text,
  scene_condition text,
  protection_systems text,
  protection_defects text,
  cause_status text not null default 'unknown' check (cause_status in ('unknown', 'suspected', 'confirmed')),
  cause_classification text not null default 'undetermined' check (cause_classification in ('technical', 'negligent', 'intentional', 'natural', 'undetermined')),
  ignition_source text,
  fuel_load text,
  cause_reasoning text,
  linked_incident_id uuid references public.incidents(id) on delete restrict,
  created_by uuid not null references auth.users(id),
  created_by_name text not null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  updated_by_name text,
  updated_at timestamptz,
  closed_by uuid references auth.users(id),
  closed_by_name text,
  closed_at timestamptz
);

create table if not exists public.fire_investigation_people (
  id uuid primary key,
  investigation_id uuid not null references public.fire_investigations(id) on delete restrict,
  person_name text not null,
  phone text,
  person_role text not null check (person_role in ('owner', 'resident', 'witness', 'injured', 'suspect', 'other')),
  statement text,
  contact_status text,
  created_by uuid not null references auth.users(id),
  created_by_name text not null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  updated_by_name text,
  updated_at timestamptz
);

create table if not exists public.fire_investigation_evidence (
  id uuid primary key,
  investigation_id uuid not null references public.fire_investigations(id) on delete restrict,
  evidence_number text not null,
  evidence_type text not null,
  found_location text,
  collected_at timestamptz,
  collected_by text,
  lab_status text not null default 'not_sent' check (lab_status in ('not_sent', 'sent', 'processing', 'completed')),
  lab_number text,
  result text,
  chain_of_custody text,
  created_by uuid not null references auth.users(id),
  created_by_name text not null,
  created_at timestamptz not null default now(),
  updated_by uuid references auth.users(id),
  updated_by_name text,
  updated_at timestamptz,
  unique (investigation_id, evidence_number)
);

create table if not exists public.fire_investigation_log (
  id uuid primary key,
  investigation_id uuid not null references public.fire_investigations(id) on delete restrict,
  entry_at timestamptz not null,
  entry_type text not null check (entry_type in ('investigation', 'interview', 'evidence', 'lab', 'handoff', 'cause', 'note')),
  description text not null,
  created_by uuid not null references auth.users(id),
  created_by_name text not null,
  created_at timestamptz not null default now()
);

alter table public.bulletin_entries add column if not exists updated_by uuid references auth.users(id);
alter table public.bulletin_entries add column if not exists updated_by_name text;
alter table public.bulletin_entries add column if not exists updated_at timestamptz;
alter table public.bulletin_entries add column if not exists department text;
alter table public.bulletin_entries add column if not exists handled_by text;

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
create index if not exists normal_patient_handoffs_updated_idx on public.normal_patient_handoffs (updated_at desc);
create index if not exists normal_patient_handoffs_history_idx on public.normal_patient_handoffs (closed_at desc) where status = 'closed';
create index if not exists incidents_status_started_idx on public.incidents (status, started_at desc);
create index if not exists incidents_history_idx on public.incidents (closed_at desc) where status = 'closed';
create index if not exists activity_log_incident_created_idx on public.activity_log (incident_id, created_at desc);
create index if not exists bulletin_entries_status_created_idx on public.bulletin_entries (status, created_at desc);
create index if not exists bulletin_entries_history_idx on public.bulletin_entries (completed_at desc) where status = 'done';
create index if not exists lab_requests_status_created_idx on public.lab_requests (status, created_at desc);
create index if not exists lab_requests_history_idx on public.lab_requests (completed_at desc) where status = 'done';
create index if not exists deceased_records_death_date_idx on public.deceased_records (date_of_death desc);
create index if not exists deceased_records_history_idx on public.deceased_records (updated_at desc) where autopsy_report;
create unique index if not exists deceased_records_occupied_chamber_idx
on public.deceased_records (chamber_number) where chamber_occupied;
create unique index if not exists psychology_records_file_number_idx on public.psychology_records (lower(file_number));
create index if not exists psychology_records_status_updated_idx on public.psychology_records (status, updated_at desc nulls last, created_at desc);
create index if not exists psychology_sessions_record_date_idx on public.psychology_sessions (record_id, session_at desc);
create unique index if not exists physiology_records_file_number_idx on public.physiology_records (lower(file_number));
create index if not exists physiology_records_status_updated_idx on public.physiology_records (status, updated_at desc nulls last, created_at desc);
create index if not exists physiology_sessions_record_date_idx on public.physiology_sessions (record_id, session_at desc);
create unique index if not exists fire_investigations_case_number_idx on public.fire_investigations (lower(case_number));
create index if not exists fire_investigations_status_date_idx on public.fire_investigations (status, incident_date desc);
create index if not exists fire_people_investigation_idx on public.fire_investigation_people (investigation_id, created_at);
create index if not exists fire_evidence_investigation_idx on public.fire_investigation_evidence (investigation_id, created_at);
create index if not exists fire_log_investigation_date_idx on public.fire_investigation_log (investigation_id, entry_at desc);

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
  new.patient_name := old.patient_name; new.phone := old.phone; new.department := old.department; new.handled_by := old.handled_by; new.concern := old.concern;
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
  if tg_op = 'UPDATE' and old.autopsy_report then
    if auth.uid() is not null then
      raise exception 'Abgeschlossene Einträge der Totenübersicht sind schreibgeschützt.';
    end if;
    new.created_by := old.created_by; new.created_by_name := old.created_by_name; new.created_at := old.created_at;
    new.updated_by := old.updated_by; new.updated_by_name := old.updated_by_name; new.updated_at := old.updated_at;
    return new;
  end if;
  if new.autopsy_report then
    new.autopsy_approved := true;
    new.chamber_occupied := false;
    new.chamber_number := null;
  elsif new.chamber_occupied then
    if new.chamber_number is null or new.chamber_number < 1 or new.chamber_number > 16 then
      raise exception 'Für ein belegtes Fach muss eine Fachnummer zwischen 1 und 16 gewählt werden.';
    end if;
  else
    new.chamber_number := null;
  end if;
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

create or replace function public.protect_psychology_record()
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
    new.updated_by := null; new.updated_by_name := null; new.updated_at := null;
    new.closed_by := null; new.closed_by_name := null; new.closed_at := null;
    if new.status = 'closed' then raise exception 'Neue Akten können nicht abgeschlossen angelegt werden.'; end if;
    return new;
  end if;
  if old.status = 'closed' then raise exception 'Abgeschlossene Psychologie-Akten sind schreibgeschützt.'; end if;
  new.created_by := old.created_by; new.created_by_name := old.created_by_name; new.created_at := old.created_at;
  new.updated_by := auth.uid(); new.updated_by_name := actor_name; new.updated_at := now();
  if new.status = 'closed' then
    new.closed_by := auth.uid(); new.closed_by_name := actor_name; new.closed_at := now();
  else
    new.closed_by := null; new.closed_by_name := null; new.closed_at := null;
  end if;
  return new;
end;
$$;

create or replace function public.protect_psychology_session()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_name text;
  target_record uuid;
begin
  target_record := case when tg_op = 'DELETE' then old.record_id else new.record_id end;
  if not exists (select 1 from public.psychology_records where id = target_record and status <> 'closed') then
    raise exception 'Sitzungen können nur in aktiven oder pausierten Akten geändert werden.';
  end if;
  select display_name into actor_name from public.mci_members where user_id = auth.uid();
  actor_name := coalesce(actor_name, 'Unbekannt');
  if tg_op = 'INSERT' then
    new.created_by := auth.uid(); new.created_by_name := actor_name; new.created_at := now();
    new.updated_by := null; new.updated_by_name := null; new.updated_at := null;
    return new;
  end if;
  new.record_id := old.record_id;
  new.created_by := old.created_by; new.created_by_name := old.created_by_name; new.created_at := old.created_at;
  new.updated_by := auth.uid(); new.updated_by_name := actor_name; new.updated_at := now();
  return new;
end;
$$;

create or replace function public.protect_physiology_record()
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
    new.updated_by := null; new.updated_by_name := null; new.updated_at := null;
    new.closed_by := null; new.closed_by_name := null; new.closed_at := null;
    if new.status = 'closed' then raise exception 'Neue Akten können nicht abgeschlossen angelegt werden.'; end if;
    return new;
  end if;
  if old.status = 'closed' then raise exception 'Abgeschlossene Physiologie-Akten sind schreibgeschützt.'; end if;
  new.created_by := old.created_by; new.created_by_name := old.created_by_name; new.created_at := old.created_at;
  new.updated_by := auth.uid(); new.updated_by_name := actor_name; new.updated_at := now();
  if new.status = 'closed' then
    new.closed_by := auth.uid(); new.closed_by_name := actor_name; new.closed_at := now();
  else
    new.closed_by := null; new.closed_by_name := null; new.closed_at := null;
  end if;
  return new;
end;
$$;

create or replace function public.protect_physiology_session()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_name text;
  target_record uuid;
begin
  target_record := case when tg_op = 'DELETE' then old.record_id else new.record_id end;
  if not exists (select 1 from public.physiology_records where id = target_record and status <> 'closed') then
    raise exception 'Sitzungen können nur in aktiven oder pausierten Akten geändert werden.';
  end if;
  select display_name into actor_name from public.mci_members where user_id = auth.uid();
  actor_name := coalesce(actor_name, 'Unbekannt');
  if tg_op = 'INSERT' then
    new.created_by := auth.uid(); new.created_by_name := actor_name; new.created_at := now();
    new.updated_by := null; new.updated_by_name := null; new.updated_at := null;
    return new;
  end if;
  new.record_id := old.record_id;
  new.created_by := old.created_by; new.created_by_name := old.created_by_name; new.created_at := old.created_at;
  new.updated_by := auth.uid(); new.updated_by_name := actor_name; new.updated_at := now();
  return new;
end;
$$;

create or replace function public.protect_fire_investigation()
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
    new.updated_by := null; new.updated_by_name := null; new.updated_at := null;
    new.closed_by := null; new.closed_by_name := null; new.closed_at := null;
    if new.status = 'closed' then raise exception 'Neue Ermittlungsakten können nicht abgeschlossen angelegt werden.'; end if;
    return new;
  end if;
  if old.status = 'closed' then raise exception 'Abgeschlossene Ermittlungsakten sind schreibgeschützt.'; end if;
  new.created_by := old.created_by; new.created_by_name := old.created_by_name; new.created_at := old.created_at;
  new.updated_by := auth.uid(); new.updated_by_name := actor_name; new.updated_at := now();
  if new.status = 'closed' then
    new.closed_by := auth.uid(); new.closed_by_name := actor_name; new.closed_at := now();
  else
    new.closed_by := null; new.closed_by_name := null; new.closed_at := null;
  end if;
  return new;
end;
$$;

create or replace function public.protect_fire_investigation_child()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_name text;
begin
  if not exists (select 1 from public.fire_investigations where id = new.investigation_id and status <> 'closed') then
    raise exception 'Einträge können nur in offenen Ermittlungsakten geändert werden.';
  end if;
  select display_name into actor_name from public.mci_members where user_id = auth.uid();
  actor_name := coalesce(actor_name, 'Unbekannt');
  if tg_op = 'INSERT' then
    new.created_by := auth.uid(); new.created_by_name := actor_name; new.created_at := now();
    new.updated_by := null; new.updated_by_name := null; new.updated_at := null;
    return new;
  end if;
  new.investigation_id := old.investigation_id;
  new.created_by := old.created_by; new.created_by_name := old.created_by_name; new.created_at := old.created_at;
  new.updated_by := auth.uid(); new.updated_by_name := actor_name; new.updated_at := now();
  return new;
end;
$$;

create or replace function public.protect_fire_investigation_log()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_name text;
begin
  if not exists (select 1 from public.fire_investigations where id = new.investigation_id and status <> 'closed') then
    raise exception 'Verlaufseinträge können nur in offenen Ermittlungsakten angelegt werden.';
  end if;
  select display_name into actor_name from public.mci_members where user_id = auth.uid();
  new.created_by := auth.uid(); new.created_by_name := coalesce(actor_name, 'Unbekannt'); new.created_at := now();
  return new;
end;
$$;

-- Bereinigt bestehende abgeschlossene Einträge, ohne deren Protokolldaten zu verändern.
update public.deceased_records
set chamber_occupied = false, chamber_number = null
where autopsy_report and (chamber_occupied or chamber_number is not null);

create or replace function public.protect_normal_patient_handoff()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  actor_name text;
begin
  select display_name into actor_name from public.mci_members where user_id = auth.uid();
  if tg_op = 'INSERT' then
    new.status := 'active';
    new.created_at := now();
    new.closed_by := null; new.closed_by_name := null; new.closed_at := null;
  elsif old.status = 'closed' then
    raise exception 'Abgeschlossene Behandlungen sind schreibgeschützt.';
  elsif new.status = 'closed' then
    new.closed_by := auth.uid(); new.closed_by_name := coalesce(actor_name, 'Unbekannt'); new.closed_at := now();
  else
    new.status := 'active';
    new.closed_by := null; new.closed_by_name := null; new.closed_at := null;
  end if;
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.delete_history_entry(p_entry_type text, p_entry_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from public.mci_members
    where user_id = auth.uid() and can_delete_history
  ) then
    raise exception 'Keine Berechtigung zum endgültigen Löschen von Historieneinträgen.' using errcode = '42501';
  end if;

  case p_entry_type
    when 'incident' then
      if not exists (select 1 from public.incidents where id = p_entry_id and status = 'closed') then
        raise exception 'Abgeschlossene MCI nicht gefunden.';
      end if;
      delete from public.patients where incident_id = p_entry_id;
      -- Patientenlöschungen erzeugen noch Protokolleinträge; deshalb danach das Protokoll entfernen.
      delete from public.activity_log where incident_id = p_entry_id;
      delete from public.incidents where id = p_entry_id and status = 'closed';
    when 'bulletin' then
      delete from public.bulletin_entries where id = p_entry_id and status = 'done';
      if not found then raise exception 'Historischer Brett-Eintrag nicht gefunden.'; end if;
    when 'lab' then
      delete from public.lab_requests where id = p_entry_id and status = 'done';
      if not found then raise exception 'Historischer Labor Request nicht gefunden.'; end if;
    when 'deceased' then
      delete from public.deceased_records where id = p_entry_id and autopsy_report;
      if not found then raise exception 'Historischer Eintrag der Totenübersicht nicht gefunden.'; end if;
    when 'normal_handoff' then
      delete from public.normal_patient_handoffs where id = p_entry_id and status = 'closed';
      if not found then raise exception 'Abgeschlossene Patientenübergabe nicht gefunden.'; end if;
    when 'psychology' then
      if not exists (select 1 from public.psychology_records where id = p_entry_id and status = 'closed') then
        raise exception 'Abgeschlossene Psychologie-Akte nicht gefunden.';
      end if;
      delete from public.psychology_sessions where record_id = p_entry_id;
      delete from public.psychology_records where id = p_entry_id and status = 'closed';
    when 'physiology' then
      if not exists (select 1 from public.physiology_records where id = p_entry_id and status = 'closed') then
        raise exception 'Abgeschlossene Physiologie-Akte nicht gefunden.';
      end if;
      delete from public.physiology_sessions where record_id = p_entry_id;
      delete from public.physiology_records where id = p_entry_id and status = 'closed';
    when 'fire_investigation' then
      if not exists (select 1 from public.fire_investigations where id = p_entry_id and status = 'closed') then
        raise exception 'Abgeschlossene Brandermittlungsakte nicht gefunden.';
      end if;
      delete from public.fire_investigation_log where investigation_id = p_entry_id;
      delete from public.fire_investigation_evidence where investigation_id = p_entry_id;
      delete from public.fire_investigation_people where investigation_id = p_entry_id;
      delete from public.fire_investigations where id = p_entry_id and status = 'closed';
    else
      raise exception 'Unbekannter Historientyp.';
  end case;
end;
$$;

-- Verhindert auch bei parallelen Admin-Anfragen, dass die letzte Benutzerverwaltung entfernt wird.
create or replace function public.protect_last_user_manager()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  removes_permission boolean := false;
begin
  if old.can_manage_users then
    if tg_op = 'DELETE' then removes_permission := true;
    elsif not new.can_manage_users then removes_permission := true;
    end if;
  end if;
  if removes_permission then
    perform pg_advisory_xact_lock(1296255305);
    if not exists (
      select 1 from public.mci_members
      where user_id <> old.user_id and can_manage_users
    ) then
      raise exception 'Mindestens eine Person muss Benutzer verwalten dürfen.' using errcode = '23514';
    end if;
  end if;
  if tg_op = 'DELETE' then return old; else return new; end if;
end;
$$;

drop trigger if exists patients_activity_trigger on public.patients;
create trigger patients_activity_trigger after insert or update or delete on public.patients
for each row execute function public.log_patient_activity();

drop trigger if exists normal_patient_handoffs_protection_trigger on public.normal_patient_handoffs;
create trigger normal_patient_handoffs_protection_trigger before insert or update on public.normal_patient_handoffs
for each row execute function public.protect_normal_patient_handoff();

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

drop trigger if exists psychology_records_protection_trigger on public.psychology_records;
create trigger psychology_records_protection_trigger before insert or update on public.psychology_records
for each row execute function public.protect_psychology_record();

drop trigger if exists psychology_sessions_protection_trigger on public.psychology_sessions;
create trigger psychology_sessions_protection_trigger before insert or update on public.psychology_sessions
for each row execute function public.protect_psychology_session();

drop trigger if exists physiology_records_protection_trigger on public.physiology_records;
create trigger physiology_records_protection_trigger before insert or update on public.physiology_records
for each row execute function public.protect_physiology_record();

drop trigger if exists physiology_sessions_protection_trigger on public.physiology_sessions;
create trigger physiology_sessions_protection_trigger before insert or update on public.physiology_sessions
for each row execute function public.protect_physiology_session();

drop trigger if exists fire_investigations_protection_trigger on public.fire_investigations;
create trigger fire_investigations_protection_trigger before insert or update on public.fire_investigations
for each row execute function public.protect_fire_investigation();

drop trigger if exists fire_people_protection_trigger on public.fire_investigation_people;
create trigger fire_people_protection_trigger before insert or update on public.fire_investigation_people
for each row execute function public.protect_fire_investigation_child();

drop trigger if exists fire_evidence_protection_trigger on public.fire_investigation_evidence;
create trigger fire_evidence_protection_trigger before insert or update on public.fire_investigation_evidence
for each row execute function public.protect_fire_investigation_child();

drop trigger if exists fire_log_protection_trigger on public.fire_investigation_log;
create trigger fire_log_protection_trigger before insert on public.fire_investigation_log
for each row execute function public.protect_fire_investigation_log();

drop trigger if exists mci_members_last_manager_trigger on public.mci_members;
create trigger mci_members_last_manager_trigger before update or delete on public.mci_members
for each row execute function public.protect_last_user_manager();

revoke execute on function public.log_patient_activity() from public, anon, authenticated;
revoke execute on function public.protect_normal_patient_handoff() from public, anon, authenticated;
revoke execute on function public.log_incident_activity() from public, anon, authenticated;
revoke execute on function public.protect_bulletin_entry() from public, anon, authenticated;
revoke execute on function public.protect_lab_request() from public, anon, authenticated;
revoke execute on function public.protect_deceased_record() from public, anon, authenticated;
revoke execute on function public.protect_psychology_record() from public, anon, authenticated;
revoke execute on function public.protect_psychology_session() from public, anon, authenticated;
revoke execute on function public.protect_physiology_record() from public, anon, authenticated;
revoke execute on function public.protect_physiology_session() from public, anon, authenticated;
revoke execute on function public.protect_fire_investigation() from public, anon, authenticated;
revoke execute on function public.protect_fire_investigation_child() from public, anon, authenticated;
revoke execute on function public.protect_fire_investigation_log() from public, anon, authenticated;
revoke execute on function public.protect_last_user_manager() from public, anon, authenticated;
revoke execute on function public.delete_history_entry(text, uuid) from public, anon, authenticated;
grant execute on function public.delete_history_entry(text, uuid) to authenticated;

alter table public.mci_members enable row level security;
alter table public.incidents enable row level security;
alter table public.patients enable row level security;
alter table public.normal_patient_handoffs enable row level security;
alter table public.activity_log enable row level security;
alter table public.bulletin_entries enable row level security;
alter table public.lab_requests enable row level security;
alter table public.deceased_records enable row level security;
alter table public.psychology_records enable row level security;
alter table public.psychology_sessions enable row level security;
alter table public.physiology_records enable row level security;
alter table public.physiology_sessions enable row level security;
alter table public.fire_investigations enable row level security;
alter table public.fire_investigation_people enable row level security;
alter table public.fire_investigation_evidence enable row level security;
alter table public.fire_investigation_log enable row level security;

revoke all on public.mci_members from anon, authenticated;
revoke all on public.incidents from anon, authenticated;
revoke all on public.patients from anon, authenticated;
revoke all on public.normal_patient_handoffs from anon, authenticated;
revoke all on public.activity_log from anon, authenticated;
revoke all on public.bulletin_entries from anon, authenticated;
revoke all on public.lab_requests from anon, authenticated;
revoke all on public.deceased_records from anon, authenticated;
revoke all on public.psychology_records from anon, authenticated;
revoke all on public.psychology_sessions from anon, authenticated;
revoke all on public.physiology_records from anon, authenticated;
revoke all on public.physiology_sessions from anon, authenticated;
revoke all on public.fire_investigations from anon, authenticated;
revoke all on public.fire_investigation_people from anon, authenticated;
revoke all on public.fire_investigation_evidence from anon, authenticated;
revoke all on public.fire_investigation_log from anon, authenticated;
grant select on public.mci_members to authenticated;
grant select, insert, update on public.incidents to authenticated;
grant select, insert, update, delete on public.patients to authenticated;
grant select, insert, update on public.normal_patient_handoffs to authenticated;
grant select on public.activity_log to authenticated;
grant select, insert, update on public.bulletin_entries to authenticated;
grant select, insert, update on public.lab_requests to authenticated;
grant select, insert, update on public.deceased_records to authenticated;
grant select, insert, update on public.psychology_records to authenticated;
grant select, insert, update on public.psychology_sessions to authenticated;
grant select, insert, update on public.physiology_records to authenticated;
grant select, insert, update on public.physiology_sessions to authenticated;
grant select, insert, update on public.fire_investigations to authenticated;
grant select, insert, update on public.fire_investigation_people to authenticated;
grant select, insert, update on public.fire_investigation_evidence to authenticated;
grant select, insert on public.fire_investigation_log to authenticated;

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

drop policy if exists "Psychologie liest Akten" on public.psychology_records;
create policy "Psychologie liest Akten"
on public.psychology_records for select to authenticated
using (exists (
  select 1 from public.mci_members m
  where m.user_id = auth.uid() and m.can_access_psychology
));

drop policy if exists "Psychologie erstellt Akten" on public.psychology_records;
create policy "Psychologie erstellt Akten"
on public.psychology_records for insert to authenticated
with check (
  created_by = auth.uid()
  and exists (select 1 from public.mci_members m where m.user_id = auth.uid() and m.can_access_psychology)
);

drop policy if exists "Psychologie bearbeitet Akten" on public.psychology_records;
create policy "Psychologie bearbeitet Akten"
on public.psychology_records for update to authenticated
using (
  status <> 'closed'
  and exists (select 1 from public.mci_members m where m.user_id = auth.uid() and m.can_access_psychology)
)
with check (
  updated_by = auth.uid()
  and exists (select 1 from public.mci_members m where m.user_id = auth.uid() and m.can_access_psychology)
);

drop policy if exists "Psychologie liest Sitzungen" on public.psychology_sessions;
create policy "Psychologie liest Sitzungen"
on public.psychology_sessions for select to authenticated
using (exists (
  select 1 from public.mci_members m
  where m.user_id = auth.uid() and m.can_access_psychology
));

drop policy if exists "Psychologie erstellt Sitzungen" on public.psychology_sessions;
create policy "Psychologie erstellt Sitzungen"
on public.psychology_sessions for insert to authenticated
with check (
  created_by = auth.uid()
  and exists (select 1 from public.mci_members m where m.user_id = auth.uid() and m.can_access_psychology)
  and exists (select 1 from public.psychology_records r where r.id = record_id and r.status <> 'closed')
);

drop policy if exists "Psychologie bearbeitet Sitzungen" on public.psychology_sessions;
create policy "Psychologie bearbeitet Sitzungen"
on public.psychology_sessions for update to authenticated
using (
  exists (select 1 from public.mci_members m where m.user_id = auth.uid() and m.can_access_psychology)
  and exists (select 1 from public.psychology_records r where r.id = record_id and r.status <> 'closed')
)
with check (
  updated_by = auth.uid()
  and exists (select 1 from public.mci_members m where m.user_id = auth.uid() and m.can_access_psychology)
  and exists (select 1 from public.psychology_records r where r.id = record_id and r.status <> 'closed')
);

drop policy if exists "Physiologie liest Akten" on public.physiology_records;
create policy "Physiologie liest Akten"
on public.physiology_records for select to authenticated
using (exists (
  select 1 from public.mci_members m
  where m.user_id = auth.uid() and m.can_access_physiology
));

drop policy if exists "Physiologie erstellt Akten" on public.physiology_records;
create policy "Physiologie erstellt Akten"
on public.physiology_records for insert to authenticated
with check (
  created_by = auth.uid()
  and exists (select 1 from public.mci_members m where m.user_id = auth.uid() and m.can_access_physiology)
);

drop policy if exists "Physiologie bearbeitet Akten" on public.physiology_records;
create policy "Physiologie bearbeitet Akten"
on public.physiology_records for update to authenticated
using (
  status <> 'closed'
  and exists (select 1 from public.mci_members m where m.user_id = auth.uid() and m.can_access_physiology)
)
with check (
  updated_by = auth.uid()
  and exists (select 1 from public.mci_members m where m.user_id = auth.uid() and m.can_access_physiology)
);

drop policy if exists "Physiologie liest Sitzungen" on public.physiology_sessions;
create policy "Physiologie liest Sitzungen"
on public.physiology_sessions for select to authenticated
using (exists (
  select 1 from public.mci_members m
  where m.user_id = auth.uid() and m.can_access_physiology
));

drop policy if exists "Physiologie erstellt Sitzungen" on public.physiology_sessions;
create policy "Physiologie erstellt Sitzungen"
on public.physiology_sessions for insert to authenticated
with check (
  created_by = auth.uid()
  and exists (select 1 from public.mci_members m where m.user_id = auth.uid() and m.can_access_physiology)
  and exists (select 1 from public.physiology_records r where r.id = record_id and r.status <> 'closed')
);

drop policy if exists "Physiologie bearbeitet Sitzungen" on public.physiology_sessions;
create policy "Physiologie bearbeitet Sitzungen"
on public.physiology_sessions for update to authenticated
using (
  exists (select 1 from public.mci_members m where m.user_id = auth.uid() and m.can_access_physiology)
  and exists (select 1 from public.physiology_records r where r.id = record_id and r.status <> 'closed')
)
with check (
  updated_by = auth.uid()
  and exists (select 1 from public.mci_members m where m.user_id = auth.uid() and m.can_access_physiology)
  and exists (select 1 from public.physiology_records r where r.id = record_id and r.status <> 'closed')
);

drop policy if exists "Fire Investigation liest Akten" on public.fire_investigations;
create policy "Fire Investigation liest Akten" on public.fire_investigations for select to authenticated
using (exists (select 1 from public.mci_members m where m.user_id = auth.uid() and m.can_access_fire_investigation));

drop policy if exists "Fire Investigation erstellt Akten" on public.fire_investigations;
create policy "Fire Investigation erstellt Akten" on public.fire_investigations for insert to authenticated
with check (created_by = auth.uid() and exists (select 1 from public.mci_members m where m.user_id = auth.uid() and m.can_access_fire_investigation));

drop policy if exists "Fire Investigation bearbeitet Akten" on public.fire_investigations;
create policy "Fire Investigation bearbeitet Akten" on public.fire_investigations for update to authenticated
using (status <> 'closed' and exists (select 1 from public.mci_members m where m.user_id = auth.uid() and m.can_access_fire_investigation))
with check (updated_by = auth.uid() and exists (select 1 from public.mci_members m where m.user_id = auth.uid() and m.can_access_fire_investigation));

drop policy if exists "Fire Investigation liest Personen" on public.fire_investigation_people;
create policy "Fire Investigation liest Personen" on public.fire_investigation_people for select to authenticated
using (exists (select 1 from public.mci_members m where m.user_id = auth.uid() and m.can_access_fire_investigation));

drop policy if exists "Fire Investigation erstellt Personen" on public.fire_investigation_people;
create policy "Fire Investigation erstellt Personen" on public.fire_investigation_people for insert to authenticated
with check (
  created_by = auth.uid()
  and exists (select 1 from public.mci_members m where m.user_id = auth.uid() and m.can_access_fire_investigation)
  and exists (select 1 from public.fire_investigations f where f.id = investigation_id and f.status <> 'closed')
);

drop policy if exists "Fire Investigation bearbeitet Personen" on public.fire_investigation_people;
create policy "Fire Investigation bearbeitet Personen" on public.fire_investigation_people for update to authenticated
using (
  exists (select 1 from public.mci_members m where m.user_id = auth.uid() and m.can_access_fire_investigation)
  and exists (select 1 from public.fire_investigations f where f.id = investigation_id and f.status <> 'closed')
)
with check (updated_by = auth.uid() and exists (select 1 from public.mci_members m where m.user_id = auth.uid() and m.can_access_fire_investigation));

drop policy if exists "Fire Investigation liest Beweismittel" on public.fire_investigation_evidence;
create policy "Fire Investigation liest Beweismittel" on public.fire_investigation_evidence for select to authenticated
using (exists (select 1 from public.mci_members m where m.user_id = auth.uid() and m.can_access_fire_investigation));

drop policy if exists "Fire Investigation erstellt Beweismittel" on public.fire_investigation_evidence;
create policy "Fire Investigation erstellt Beweismittel" on public.fire_investigation_evidence for insert to authenticated
with check (
  created_by = auth.uid()
  and exists (select 1 from public.mci_members m where m.user_id = auth.uid() and m.can_access_fire_investigation)
  and exists (select 1 from public.fire_investigations f where f.id = investigation_id and f.status <> 'closed')
);

drop policy if exists "Fire Investigation bearbeitet Beweismittel" on public.fire_investigation_evidence;
create policy "Fire Investigation bearbeitet Beweismittel" on public.fire_investigation_evidence for update to authenticated
using (
  exists (select 1 from public.mci_members m where m.user_id = auth.uid() and m.can_access_fire_investigation)
  and exists (select 1 from public.fire_investigations f where f.id = investigation_id and f.status <> 'closed')
)
with check (updated_by = auth.uid() and exists (select 1 from public.mci_members m where m.user_id = auth.uid() and m.can_access_fire_investigation));

drop policy if exists "Fire Investigation liest Verlauf" on public.fire_investigation_log;
create policy "Fire Investigation liest Verlauf" on public.fire_investigation_log for select to authenticated
using (exists (select 1 from public.mci_members m where m.user_id = auth.uid() and m.can_access_fire_investigation));

drop policy if exists "Fire Investigation erstellt Verlauf" on public.fire_investigation_log;
create policy "Fire Investigation erstellt Verlauf" on public.fire_investigation_log for insert to authenticated
with check (
  created_by = auth.uid()
  and exists (select 1 from public.mci_members m where m.user_id = auth.uid() and m.can_access_fire_investigation)
  and exists (select 1 from public.fire_investigations f where f.id = investigation_id and f.status <> 'closed')
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

drop policy if exists "Mitglieder lesen normale Übergaben" on public.normal_patient_handoffs;
create policy "Mitglieder lesen normale Übergaben"
on public.normal_patient_handoffs for select to authenticated
using (exists (select 1 from public.mci_members m where m.user_id = auth.uid()));

drop policy if exists "Mitglieder erstellen normale Übergaben" on public.normal_patient_handoffs;
create policy "Mitglieder erstellen normale Übergaben"
on public.normal_patient_handoffs for insert to authenticated
with check (
  updated_by = auth.uid()
  and exists (select 1 from public.mci_members m where m.user_id = auth.uid())
);

drop policy if exists "Mitglieder ändern normale Übergaben" on public.normal_patient_handoffs;
create policy "Mitglieder ändern normale Übergaben"
on public.normal_patient_handoffs for update to authenticated
using (
  status = 'active'
  and exists (select 1 from public.mci_members m where m.user_id = auth.uid())
)
with check (
  updated_by = auth.uid()
  and status in ('active', 'closed')
  and exists (select 1 from public.mci_members m where m.user_id = auth.uid())
);

drop policy if exists "Mitglieder löschen normale Übergaben" on public.normal_patient_handoffs;

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
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'normal_patient_handoffs'
  ) then
    alter publication supabase_realtime add table public.normal_patient_handoffs;
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
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'psychology_records'
  ) then
    alter publication supabase_realtime add table public.psychology_records;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'psychology_sessions'
  ) then
    alter publication supabase_realtime add table public.psychology_sessions;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'physiology_records'
  ) then
    alter publication supabase_realtime add table public.physiology_records;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'physiology_sessions'
  ) then
    alter publication supabase_realtime add table public.physiology_sessions;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'fire_investigations') then
    alter publication supabase_realtime add table public.fire_investigations;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'fire_investigation_people') then
    alter publication supabase_realtime add table public.fire_investigation_people;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'fire_investigation_evidence') then
    alter publication supabase_realtime add table public.fire_investigation_evidence;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'fire_investigation_log') then
    alter publication supabase_realtime add table public.fire_investigation_log;
  end if;
end $$;

-- Weitere Benutzer nach dem Anlegen unter Authentication → Users freigeben:
-- insert into public.mci_members (user_id, display_name)
-- select id, 'Anzeigename' from auth.users where email = 'name@example.com'
-- on conflict (user_id) do update set display_name = excluded.display_name;
-- Recht zum endgültigen Löschen sämtlicher Historien vergeben:
-- update public.mci_members set can_delete_history = true
-- where user_id = (select id from auth.users where email = 'name@example.com');
-- Recht zur Benutzerverwaltung vergeben (mindestens eine Person muss es besitzen):
-- update public.mci_members set can_manage_users = true
-- where user_id = (select id from auth.users where email = 'name@example.com');

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
    insert into public.incidents (id, title, description, status, started_at, closed_at, created_by)
    values (archive_id, 'Übernommene MCI', 'Automatisch aus der bisherigen gemeinsamen Patientenliste übernommen.', 'closed', now(), now(), owner_id);
    update public.patients set incident_id = archive_id where incident_id is null;
  end if;
end $$;

alter table public.patients alter column incident_id set not null;
create index if not exists patients_incident_id_idx on public.patients (incident_id);
create index if not exists incidents_status_started_idx on public.incidents (status, started_at desc);

alter table public.mci_members enable row level security;
alter table public.incidents enable row level security;
alter table public.patients enable row level security;

revoke all on public.mci_members from anon, authenticated;
revoke all on public.incidents from anon, authenticated;
revoke all on public.patients from anon, authenticated;
grant select on public.mci_members to authenticated;
grant select, insert, update on public.incidents to authenticated;
grant select, insert, update, delete on public.patients to authenticated;

drop policy if exists "Mitglied sieht eigene Freigabe" on public.mci_members;
create policy "Mitglied sieht eigene Freigabe"
on public.mci_members for select to authenticated
using (user_id = auth.uid());

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
end $$;

-- Weitere Benutzer nach dem Anlegen unter Authentication → Users freigeben:
-- insert into public.mci_members (user_id, display_name)
-- select id, 'Anzeigename' from auth.users where email = 'name@example.com'
-- on conflict (user_id) do update set display_name = excluded.display_name;

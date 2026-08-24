-- MCI Board: Datenbank, Mitgliederfreigabe und Zugriffsregeln
-- Dieses Skript einmal vollständig im Supabase SQL Editor ausführen.

create table if not exists public.mci_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);

create table if not exists public.patients (
  id uuid primary key,
  data jsonb not null default '{}'::jsonb,
  updated_by uuid not null references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.mci_members enable row level security;
alter table public.patients enable row level security;

revoke all on public.mci_members from anon, authenticated;
revoke all on public.patients from anon, authenticated;
grant select on public.mci_members to authenticated;
grant select, insert, update, delete on public.patients to authenticated;

drop policy if exists "Mitglied sieht eigene Freigabe" on public.mci_members;
create policy "Mitglied sieht eigene Freigabe"
on public.mci_members for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "Mitglieder lesen Patienten" on public.patients;
create policy "Mitglieder lesen Patienten"
on public.patients for select
to authenticated
using (exists (select 1 from public.mci_members m where m.user_id = auth.uid()));

drop policy if exists "Mitglieder erstellen Patienten" on public.patients;
create policy "Mitglieder erstellen Patienten"
on public.patients for insert
to authenticated
with check (
  updated_by = auth.uid()
  and exists (select 1 from public.mci_members m where m.user_id = auth.uid())
);

drop policy if exists "Mitglieder ändern Patienten" on public.patients;
create policy "Mitglieder ändern Patienten"
on public.patients for update
to authenticated
using (exists (select 1 from public.mci_members m where m.user_id = auth.uid()))
with check (
  updated_by = auth.uid()
  and exists (select 1 from public.mci_members m where m.user_id = auth.uid())
);

drop policy if exists "Mitglieder löschen Patienten" on public.patients;
create policy "Mitglieder löschen Patienten"
on public.patients for delete
to authenticated
using (exists (select 1 from public.mci_members m where m.user_id = auth.uid()));

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'patients'
  ) then
    alter publication supabase_realtime add table public.patients;
  end if;
end $$;

-- NACH dem Anlegen eines Benutzers dessen E-Mail hier einsetzen und diese Zeile ausführen:
-- insert into public.mci_members (user_id, display_name)
-- select id, 'Anzeigename' from auth.users where email = 'name@example.com'
-- on conflict (user_id) do update set display_name = excluded.display_name;

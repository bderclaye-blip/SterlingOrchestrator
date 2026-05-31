-- Capture pipeline schema (Phase 1 — the capture spine)
-- Run this in Supabase: Dashboard → SQL Editor → New query
-- (or `supabase db push` once the CLI is linked to this project).
--
-- Project: hkgjybzinahwminzfgwg (STERLING ORCHESTRATOR). NOT Bar Deco.
--
-- This is the capture stream: voice → Edge Function → captures → mirrored to the vault.
-- Safe to re-run (idempotent).

-- Captures: the raw voice-capture stream. Machines write here; the vault mirrors out of it.
create table if not exists captures (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  pillar          text not null check (pillar in ('bardeco','noosawood','aios','lcd','personal')),
  type            text not null check (type in ('idea','task','update','fix','decision','log')),
  title           text,
  content         text not null,
  source          text not null default 'voice',
  status          text not null default 'raw',
  synced_to_vault boolean not null default false
);

-- Lock the table down. The Edge Function and mirror worker use the service-role key,
-- which bypasses RLS; nothing with the public anon key gets at the capture stream.
-- RLS-on with no policies = anon denied, service role allowed.
alter table captures enable row level security;

-- Enable Realtime so the Mac Mini mirror worker can subscribe to INSERTs.
-- Guarded so re-running doesn't error if the table is already in the publication.
do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'captures'
  ) then
    alter publication supabase_realtime add table captures;
  end if;
end
$$;

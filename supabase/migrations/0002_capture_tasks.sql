-- Capture pipeline schema (Phase 2 — task promotion)
-- Run this in Supabase: Dashboard → SQL Editor → New query
-- (or `supabase db push` once the CLI is linked to this project).
--
-- Project: hkgjybzinahwminzfgwg (STERLING ORCHESTRATOR). NOT Bar Deco.
--
-- NOTE ON THE NAME: this project shares its Supabase database with the older
-- STERLING-RASQUALLE-OS app, which ALREADY owns a `tasks` table (text ids, bucket/
-- completed/priority columns, old hyphenated pillars like 'bar-deco', real data in it).
-- The two systems are kept separate for now, so the orchestrator namespaces its own table
-- as `capture_tasks` — tasks distilled from the capture stream. Do NOT touch `tasks`.
--
-- The capture stream (`captures`) is the raw log of everything spoken. This table is the
-- OPERATIONAL state: when a capture is type='task', the mirror worker promotes it into a row
-- here and rebuilds a per-pillar open-tasks note in the vault. Safe to re-run (idempotent).

create table if not exists capture_tasks (
  id                uuid primary key default gen_random_uuid(),
  created_at        timestamptz not null default now(),
  pillar            text not null check (pillar in ('bardeco','noosawood','aios','lcd','personal')),
  title             text not null,
  detail            text,
  status            text not null default 'open' check (status in ('open','doing','done','dropped')),
  done_at           timestamptz,
  -- The capture this task was promoted from. UNIQUE so promotion is idempotent: if the
  -- worker reprocesses the same capture (a retry / backfill), the upsert is a no-op
  -- instead of creating a duplicate task.
  source_capture_id uuid unique references captures(id) on delete set null
);

-- Service-role only, same as captures: RLS on with no policies = anon denied, service
-- role (Edge Function + worker) allowed. Nothing with the public anon key gets at it.
alter table capture_tasks enable row level security;

-- Open tasks per pillar, newest last — the worker's task-list rebuild query, and the
-- natural read path for any future task UI.
create index if not exists capture_tasks_pillar_open_idx
  on capture_tasks (pillar, created_at)
  where status = 'open';

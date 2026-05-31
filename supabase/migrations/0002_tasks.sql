-- Capture pipeline schema (Phase 2 — task-table promotion)
-- Run this in Supabase: Dashboard → SQL Editor → New query
-- (or `supabase db push` once the CLI is linked to this project).
--
-- Project: hkgjybzinahwminzfgwg (STERLING ORCHESTRATOR). NOT Bar Deco.
--
-- The capture stream (`captures`) is the raw log of everything spoken. This table is the
-- OPERATIONAL state the doc reserves for Supabase: when a capture is type='task', the
-- mirror worker promotes it into a row here and rebuilds a per-pillar open-tasks note in
-- the vault. Captures = the stream; tasks = the actionable subset distilled out of it.
-- Safe to re-run (idempotent).

create table if not exists tasks (
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
-- role (Edge Function + worker) allowed. Nothing with the public anon key gets at tasks.
alter table tasks enable row level security;

-- Open tasks per pillar, newest last — the worker's task-list rebuild query, and the
-- natural read path for any future task UI.
create index if not exists tasks_pillar_open_idx
  on tasks (pillar, created_at)
  where status = 'open';

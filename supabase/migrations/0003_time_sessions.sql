-- Capture pipeline schema (Track A — time tracking)
-- Run this in Supabase: Dashboard → SQL Editor → New query.
--
-- Project: hkgjybzinahwminzfgwg (STERLING ORCHESTRATOR). NOT Bar Deco.
--
-- Voice-driven per-pillar time tracking: "I'm off to the bank for Bar Deco" opens a session,
-- "I'm back" closes it. This is OPERATIONAL/analytical data — it lives here in Supabase and is
-- viewed in the dashboard app; it is NOT mirrored to Obsidian. Safe to re-run (idempotent).

create table if not exists time_sessions (
  id          uuid primary key default gen_random_uuid(),
  pillar      text not null check (pillar in ('bardeco','noosawood','aios','lcd','personal')),
  activity    text,                          -- the short "what": 'bank', 'supplier run'
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  status      text not null default 'open' check (status in ('open','closed','auto_closed')),
  source      text not null default 'voice',
  -- Derived, never stored stale. NULL until the session closes.
  duration_seconds integer generated always as (
    case when ended_at is not null
         then extract(epoch from (ended_at - started_at))::int end
  ) stored
);

-- Service-role only, same lockdown as captures/capture_tasks. The dashboard reads via a
-- server-side route using the service-role key, never the public anon key.
alter table time_sessions enable row level security;

create index if not exists time_sessions_open_idx on time_sessions (status) where status = 'open';
create index if not exists time_sessions_pillar_day_idx on time_sessions (pillar, started_at);

-- Per-pillar rollups for the analytics page.
create or replace view time_by_pillar_day as
  select pillar,
         date_trunc('day', started_at) as day,
         sum(duration_seconds)         as seconds,
         count(*)                      as sessions
  from time_sessions
  where ended_at is not null
  group by pillar, date_trunc('day', started_at);

create or replace view time_by_pillar_week as
  select pillar,
         date_trunc('week', started_at) as week,
         sum(duration_seconds)          as seconds,
         count(*)                       as sessions
  from time_sessions
  where ended_at is not null
  group by pillar, date_trunc('week', started_at);

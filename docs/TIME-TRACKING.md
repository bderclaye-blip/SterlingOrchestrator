# Time Tracking — Build Spec (Track A)

Voice-driven per-pillar time tracking. Henry says *"I'm off to the bank for Bar Deco"* → a
live session opens; *"I'm back"* → it closes and the duration is logged. Goal: analyse how
much time goes to each pillar, daily/weekly. See `ROADMAP.md` (Track A) for the why.

**Read this before writing code. Decisions below are settled — don't re-litigate them.**

---

## Settled architecture

**Supabase-only. No Obsidian, no Mac Mini worker.** Time data is structured operational/
analytical data — rows you sum and chart — not knowledge notes. It lives in Supabase (source
of truth) and is viewed in the dashboard app. The capture pipeline's vault mirror is NOT
involved here. (Obsidian = ideas/notes/tasks; Supabase + app = time/calendar/analytics.)

**Same hub as captures.** The ElevenLabs "Sterling" agent decides *when* to call the tools;
all writes happen server-side via an Edge Function with the shared secret. Same five pillars
(`bardeco/noosawood/aios/lcd/personal`).

**Viewing = the existing dashboard.** `STERLING-RASQUALLE-OS` already has `time-log/` and
`analytics/` pages (built UI, currently on mock data). Track A feeds them real data — it does
not build new screens. This is the start of the "one app" convergence.

---

## 1. Data — `time_sessions`

```sql
create table time_sessions (
  id          uuid primary key default gen_random_uuid(),
  pillar      text not null check (pillar in ('bardeco','noosawood','aios','lcd','personal')),
  activity    text,                       -- the short "what": 'bank', 'supplier run'
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  status      text not null default 'open' check (status in ('open','closed','auto_closed')),
  source      text not null default 'voice',
  -- duration is derived, never stored stale:
  duration_seconds integer generated always as (
    case when ended_at is not null
         then extract(epoch from (ended_at - started_at))::int end
  ) stored
);
alter table time_sessions enable row level security;
create index if not exists time_sessions_open_idx on time_sessions (status) where status = 'open';
create index if not exists time_sessions_pillar_day_idx on time_sessions (pillar, started_at);
```

Service-role-only (RLS on, no policies), like `captures`/`capture_tasks`. The dashboard reads
via a server-side route using the service-role key (not the public anon key).

---

## 2. The three rules (settled)

1. **One active session at a time.** `start_session` first closes any currently-open session
   (sets `ended_at = now()`), then opens the new one. You can't be in two places at once.
2. **Forgotten clock-out.** Any session open longer than **8 hours** is auto-closed with
   `status = 'auto_closed'` (so a forgotten "I'm back" can't log a 14-hour bank run). Enforced
   on each new `start`/`end`, and by a periodic sweep (pg_cron or on worker idle — TBD, cheap).
3. **Activity label.** `start_session` captures a short free-text `activity` alongside the
   pillar, so time can be sliced finer than per-pillar.

---

## 3. Edge Function — `time-session`

One endpoint, an `action` field. Shared-secret auth via `x-capture-secret` (reuses the
existing `CAPTURE_SECRET` — no new secret).

- `{ action: "start", pillar, activity }` → close any open session, insert a new open one.
- `{ action: "end" }` → close the most recent open session, stamp `ended_at`.
- Returns a one-line result the agent can voice ("Started — Bar Deco." / "Logged 48 minutes.").

Deploy: `supabase functions deploy time-session --no-verify-jwt` (external caller, same as
`capture-thought`).

---

## 4. Analytics — SQL views

```sql
-- per-pillar totals per day
create view time_by_pillar_day as
  select pillar, date_trunc('day', started_at) as day,
         sum(duration_seconds) as seconds, count(*) as sessions
  from time_sessions where ended_at is not null
  group by pillar, day;
-- per-pillar totals per ISO week
create view time_by_pillar_week as
  select pillar, date_trunc('week', started_at) as week,
         sum(duration_seconds) as seconds, count(*) as sessions
  from time_sessions where ended_at is not null
  group by pillar, week;
```

The dashboard's `analytics` page reads these; `time-log` reads raw `time_sessions`.

---

## 5. Agent tools (ElevenLabs)

Two webhook tools on the Sterling agent, both → the `time-session` endpoint with the
`x-capture-secret` header:

- `start_session(pillar, activity)` — "log that I'm starting something / heading out."
- `end_session()` — "log that I'm back / done."

Plus a system-prompt snippet teaching *when* to fire them (depart/return phrasing) and to read
back a one-line confirmation. **Needs ElevenLabs access to configure** (fresh API key or
dashboard) — the backend is fully testable without it by calling the endpoint directly.

---

## 6. Surfacing in the dashboard (`STERLING-RASQUALLE-OS`)

- `time-log/` page → list/edit raw sessions from `time_sessions`.
- `analytics/` page → charts off `time_by_pillar_day` / `_week`.
- Reads go through a Next server route using the **service-role key** (data is RLS-locked).
- Reconciliation carried in alongside: map old pillar names (`bar-deco` → `bardeco`) and point
  the `tasks` page at `capture_tasks`.

---

## Acceptance test

1. `POST time-session {action:'start', pillar:'bardeco', activity:'bank'}` → an open row.
2. `POST time-session {action:'start', pillar:'noosawood', activity:'cnc'}` → the bardeco row
   auto-closes, a new noosawood row opens (rule 1).
3. `POST time-session {action:'end'}` → noosawood row closes, `duration_seconds` populated.
4. `time_by_pillar_day` shows both pillars with summed seconds.
5. Dashboard `time-log` + `analytics` render the same data.

When all five pass (backend via direct calls, then the agent tools wired), Track A is live.

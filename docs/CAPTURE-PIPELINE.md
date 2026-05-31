# Capture Pipeline — Build Spec (Phase 1)

This is the persistent context for building Sterling's voice-capture spine.
**Read this fully before writing any code. The decisions below are settled — do not re-litigate them.**

---

## What this is

Sterling is the voice orchestrator over Henry's whole system. This doc specs the **capture spine**: speak a thought → it gets routed to the right pillar → lands as a note in Supabase → mirrors into the Obsidian vault.

**Done means:** Henry talks to Sterling, and the note appears in his Obsidian inbox within a few seconds.

---

## Settled architecture decisions

**Data ownership (do not blur these):**
- **Supabase** = the capture stream + operational state (tasks). This is where machines write and query.
- **Obsidian** = synthesised, human-authored knowledge. The capture stream mirrors *into* it.
- **pgvector** = recall index for Sterling's memory. **Phase 3 — not built now.**

**Conductor / worker boundary:**
- The **ElevenLabs Agent** (with Claude as its native LLM) is the conductor. It decides WHICH pillar a thought belongs to and voices the reply. It NEVER writes to the DB or vault directly.
- The **backend** (Supabase Edge Functions + a Mac Mini worker) does the actual filing.
- ElevenLabs can only *decide to call a tool*. All writes happen server-side.

**Project boundaries:**
- This is the **STERLING ORCHESTRATOR** codebase, on Supabase project `hkgjybzinahwminzfgwg`.
- It is kept **separate** from `STERLING-RASQUALLE-OS` (the earlier time-management app) for now. Same Supabase project; distinct codebases. They may interconnect in a later phase — not yet.
- **NOT** Bar Deco OS (`uagyjejjtalwqnikqnek`). Do not touch Bar Deco anything.

**The five pillars:** `bardeco`, `noosawood`, `aios`, `lcd`, `personal`.

**Sync direction:** capture is **Supabase-first**, mirrored one-way OUT to markdown. No bidirectional sync — ever.

---

## Phase 1 scope — build ONLY this

1. `captures` table + Realtime enabled
2. `capture-thought` Edge Function (the webhook the agent calls)
3. ElevenLabs webhook tool config (manual, in the dashboard — instructions below)
4. Mac Mini mirror worker (subscribes to Realtime, writes markdown into the vault inbox)

**Explicitly NOT in Phase 1:** per-pillar worker logic, pgvector / recall, the time-management app. Those are later phases. Stop after the spine works.

---

## 1. Database

See [`supabase/migrations/0001_captures.sql`](../supabase/migrations/0001_captures.sql). Schema:

```sql
create table captures (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz default now(),
  pillar text not null check (pillar in ('bardeco','noosawood','aios','lcd','personal')),
  type text not null check (type in ('idea','task','update','fix','decision','log')),
  title text,
  content text not null,
  source text default 'voice',
  status text default 'raw',
  synced_to_vault boolean default false
);

alter publication supabase_realtime add table captures;
```

RLS is enabled with no policies, so only the service-role key (Edge Function + worker) can touch the stream.

---

## 2. Edge Function — `capture-thought`

The webhook target. Enforces a shared secret because it must be publicly reachable.
Implementation: [`supabase/functions/capture-thought/index.ts`](../supabase/functions/capture-thought/index.ts).

**Deploy:**
```bash
supabase link --project-ref hkgjybzinahwminzfgwg
supabase secrets set CAPTURE_SECRET=<your-long-random-string>
# SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are available to functions by default
supabase functions deploy capture-thought --no-verify-jwt
```

`--no-verify-jwt` is required: ElevenLabs is an external caller with no Supabase JWT. We secure the endpoint ourselves with the `x-capture-secret` header instead. (`verify_jwt = false` is also set in `supabase/config.toml`.)

---

## 3. ElevenLabs webhook tool (manual, in the dashboard)

**First:** set the agent's LLM to Claude in the Language Model dropdown (native option — do not use Custom LLM).

**Then:** Agent → Add Tool → Webhook.

| Field | Value |
|---|---|
| Name | `capture_thought` |
| Description | `Logs an idea, comment, task, fix or update into Henry's system, routed to the correct pillar. Call whenever Henry shares something to remember, do, or note — not for general chat.` |
| Method | `POST` |
| URL | `https://hkgjybzinahwminzfgwg.supabase.co/functions/v1/capture-thought` |
| Header (store as ElevenLabs secret) | `x-capture-secret: <same value as CAPTURE_SECRET>` |

**Body parameters:**
- `pillar` — string, one of: bardeco / noosawood / aios / lcd / personal
- `type` — string, one of: idea / task / update / fix / decision / log
- `title` — string, a 3–6 word summary
- `content` — string, the thought verbatim

**Append to the agent's system prompt** (this drives *when* the tool fires):

```
When Henry shares anything to capture — idea, comment, task, fix, update — call capture_thought.
Pillars:
  bardeco    → Bar Deco restaurant: ops, staff, menu, finances, marketing
  noosawood  → Noosa Wood: CNC, timber, fabrication, quotes, jobs
  aios       → the AI/OS build itself: Sterling, Rasqualle, dashboards, automations
  lcd        → Luxury Coastal Destinations: STR, cleaning, linen, bookings
  personal   → family, health, property maintenance, personal ideas
Pass the thought verbatim as content; write a 3-6 word title.
If the pillar is genuinely ambiguous, ask ONE short question. Otherwise route silently
and confirm in one line. Capture first, refine later — never interrogate.
```

---

## 4. Mac Mini mirror worker

A long-running process **on the Mac Mini** (it has the vault on its filesystem). Subscribes to Realtime inserts on `captures` and writes a markdown note into the inbox.
Implementation: [`worker/vault-mirror.mjs`](../worker/vault-mirror.mjs).

**Run it under `launchd`** so it restarts on reboot — template at [`worker/com.rasqualle.vault-mirror.plist`](../worker/com.rasqualle.vault-mirror.plist). `pg_cron` polling `synced_to_vault = false` is an acceptable fallback if Realtime is flaky — same pattern as the existing Xero pipeline.

---

## Env / secrets summary

| Secret | Used by |
|---|---|
| `SUPABASE_URL` | Edge Function + worker |
| `SUPABASE_SERVICE_ROLE_KEY` | Edge Function + worker |
| `CAPTURE_SECRET` | Edge Function env + ElevenLabs tool header (must match) |
| `VAULT_INBOX` | worker (path to `00-Inbox` on the Mac Mini) |

---

## Acceptance test

Speak to Sterling: *"Log an idea — spindle bogging on hardwood passes, try lowering feed rate before blaming the VFD. Noosa Wood."*

Expect:
1. A row in `captures` with `pillar = 'noosawood'`, `type = 'idea'`.
2. A new `.md` file in the Obsidian inbox within a few seconds, with correct frontmatter.
3. `synced_to_vault` flips to `true` on the row.

If all three happen, the spine is live. Stop there — Phase 2 (per-pillar workers) is a separate session.

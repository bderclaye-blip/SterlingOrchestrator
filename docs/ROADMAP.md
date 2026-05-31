# Sterling Orchestrator — Roadmap (beyond the capture pipeline)

What's built, and the tracks ahead. This is the "written down so we don't re-derive it"
doc. Settled details for shipped work live in `CAPTURE-PIPELINE.md` (Phase 1) and
`CAPTURE-PIPELINE-PHASE2.md` (Phase 2).

---

## Done — the capture pipeline (Phases 1–2)

Speak → routed by pillar → enriched → filed. Live on the always-on Mac Mini.

- **Phase 1 — spine:** voice → `capture-thought` Edge Function → `captures` table → Mac Mini
  worker mirrors a markdown note into the Obsidian vault.
- **Phase 2 — per-pillar router:** notes route into per-pillar folders; `type='task'` captures
  promote into the `capture_tasks` table + a rolling `_Tasks.md`; a Haiku enrichment pass adds
  a clean title, `summary`, and `urgency` to each note.

**Architecture recap (don't blur these):** the ElevenLabs "Sterling" agent (Claude Opus) is
the conductor — it talks and decides *which tool to call*; all writes happen server-side
(Supabase Edge Functions + the Mac Mini worker). Supabase is the cloud hub: the phone never
talks to the Mini directly — the Mini subscribes to Supabase Realtime and pulls captures down.
The vault is a folder of `.md` files on the Mini.

---

## Track A — Time tracking (a main original goal)

Voice-driven **per-pillar time tracking**, so Henry can analyse how his time is actually
spent. This is the headline feature of the original Sterling vision, not an add-on.

**The flow:**
- *"I'm off to the bank for Bar Deco"* → Sterling opens a **live session** (pillar=`bardeco`,
  activity=`bank`, `started_at`=now).
- *"I'm back home"* → Sterling **closes** the open session, computes the duration, logs it.
- Closed sessions roll up into **per-pillar totals** (daily/weekly) and render as **calendar
  events**.

**Why it's its own thing:** a time session is an *interval* (start + end + duration) — a
different shape from `captures` (point-in-time notes) and `capture_tasks` (to-dos). It reuses
everything else: same Sterling agent, same Supabase-hub pattern, same per-pillar tagging.

**Shape (to be specced):**
- New table `time_sessions (id, pillar, activity, started_at, ended_at, duration, status, source)`.
- Two new agent tools: `start_session(pillar, activity)` and `end_session()` → new Edge
  Function action(s).
- The Mac Mini worker can mirror closed sessions to the vault and/or the calendar.
- A per-pillar rollup query/view for the analytics ("X hours on Bar Deco this week").

**Open design decisions (resolve when building):**
1. **One active session at a time?** If a new "I'm off to…" arrives while one's open, auto-close
   the previous, or warn/ask? (Leaning: one active session; a new start auto-closes the prior.)
2. **Forgotten close** — if Henry never says "I'm back," the session lingers open. Needs a
   max-duration auto-close and/or an easy "fix that last one" path.
3. **Activity label** — capture a free-text activity ("bank", "supplier run") alongside the
   pillar, for finer analysis.
4. **Where analytics surface** — the STERLING OS calendar/dashboard (see Track C) vs a
   standalone view.

---

## Track B — Phase 3: recall (Sterling's memory)

Give the *voice agent* the ability to **read back** what's been captured — "what did I say
about the CNC jig last week?" — instead of every conversation starting cold.

- Index the capture stream with **pgvector / embeddings** (the recall index the original spec
  reserved for Phase 3).
- Add a recall tool to the Sterling agent so it can pull relevant past captures (and, later,
  time sessions) into a conversation.
- This is what turns Sterling from "a witty assistant that files notes" into "an assistant
  that knows my whole life." Today it *writes* to memory; Phase 3 lets it *read*.

---

## Track C — Integration with the STERLING-RASQUALLE-OS app

Surface the orchestrator's data in Henry's existing **time-management + calendar app**, and let
Sterling touch the calendar. The two systems are deliberately on the **same Supabase project**
so this is a *merge*, not a rebuild — but there are real reconciliation calls:

- **Two task tables** — the old app's `tasks` (text ids, `bucket/completed/priority`) vs the
  new `capture_tasks` (uuid, `status/done_at`). Decide: unify into one, or bridge them.
- **Pillar-naming mismatch** — old app: `bar-deco / noosa-wood / rasqualle / property /
  personal`; pipeline: `bardeco / noosawood / aios / lcd / personal`. Needs a mapping/migration.
- **Calendar surface** — closed **time sessions** (Track A) and **tasks** should render in the
  app's calendar/task views.
- **Sterling calendar tools** — give the agent read/write tools for the calendar ("what's on
  today?", "block 2pm for the dentist"). Today its only tool is capture.

Time tracking (Track A) is the strongest driver here: those sessions are exactly what the
calendar view is for.

---

## Suggested sequencing

Not fixed — Henry prioritises. Tracks are largely independent, but a sensible order:

1. **Track A (time tracking)** — self-contained, immediately useful, delivers the per-pillar
   analysis Henry wanted from day one. Highest bang-for-buck next.
2. **Track B (recall)** — makes Sterling conversationally smart; independent of the app.
3. **Track C (integration)** — ties sessions + tasks into the calendar app; naturally follows
   A (there's something worth putting on the calendar) and benefits from the schema decisions
   surfaced along the way.

Each track gets its own settled-decisions spec doc (like the Phase 1/2 docs) before any code.

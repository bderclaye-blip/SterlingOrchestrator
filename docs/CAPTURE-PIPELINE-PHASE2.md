# Capture Pipeline — Build Spec (Phase 2: the per-pillar router)

Continuation of [`CAPTURE-PIPELINE.md`](CAPTURE-PIPELINE.md). Phase 1 (the capture spine)
is live: voice → `capture-thought` → `captures` → Mac Mini worker mirrors markdown.
**Read Phase 1 first.** The decisions below are settled — do not re-litigate them.

---

## What Phase 2 is

Phase 1 dumped every capture, regardless of pillar, into one shared `00-Inbox` folder as
`status: raw`. Useful for proving the spine; useless for actually finding anything. The
captures were inert and undifferentiated.

Phase 2 makes the worker **pillar-aware**: each capture is routed to the pillar it belongs
to and handled accordingly. **Step 1 of Phase 2 (this build) = per-pillar vault foldering.**

**Done means:** a captured thought lands in its own pillar folder in the vault within a few
seconds — Bar Deco notes in `10-BarDeco`, Noosa Wood in `20-NoosaWood`, and so on.

---

## Settled architecture decisions

**One router, not five workers.** "Per-pillar workers" is implemented as a *single
pillar-aware worker* — a `switch (pillar)` inside the existing `vault-mirror` process — NOT
five separate processes/launchd services. One service, one log, one thing to keep alive on
the Mini. The literal five-process design was considered and rejected: 5× the ops surface
for differences that are currently tiny.

**Everything hangs off one per-pillar config map.** All per-pillar behaviour lives in the
`PILLARS` map in [`worker/vault-mirror.mjs`](../worker/vault-mirror.mjs). Today each pillar
only declares its `folder`. Later phases grow this object (`taskList`, `enrich`, `actions`,
…) **without** touching the routing or write path. This is the explicit "not double work"
guarantee: foldering first, the rest bolts on.

**Routing is by pillar, foldering is physical.** The note frontmatter already carries
`pillar:`, so Obsidian can also organise by metadata — the folders are the physical layer on
top, so the vault is navigable without any plugin.

**Carries forward unchanged from Phase 1:** Supabase-first, one-way mirror OUT to markdown
(never the reverse); Supabase owns the capture stream + operational state; the ElevenLabs
agent only decides which pillar — all writes are server/worker-side.

---

## Phase 2 scope — what is and isn't in THIS build

**In (step 1):**
1. Per-pillar vault folders. The worker routes each capture into a folder under the vault
   root instead of one shared inbox.
2. `VAULT_INBOX` → `VAULT_ROOT`. The worker now needs the vault *root* (the folder that holds
   the per-pillar folders), and `mkdir -p`s each pillar folder on demand.

**Deferred (later steps of Phase 2, NOT built now — each is additive on the `PILLARS` map):**
- **Promote tasks to a table** — `type = 'task'` captures → a `tasks` operational table +
  a per-pillar task list note. (Add an `if (type === 'task')` branch.)
- **Claude enrichment** — a Claude pass per capture: clean title, 1-line summary, urgency
  flag, duplicate detection. (Add one step before the write.)
- **Pillar-specific actions** — e.g. noosawood quote/job stub, bardeco urgent-ops flag.
  (Fill in per-pillar `actions` in the config map.)

Still out (later phases entirely): pgvector / recall (Phase 3), the time-management app.

---

## The pillar → folder map

| Pillar      | Folder         | What it is                                                    |
|-------------|----------------|--------------------------------------------------------------|
| `bardeco`   | `10-BarDeco`   | Bar Deco restaurant: ops, staff, menu, finances, marketing   |
| `noosawood` | `20-NoosaWood` | Noosa Wood: CNC, timber, fabrication, quotes, jobs           |
| `aios`      | `30-AI-OS`     | the AI/OS build itself: Sterling, Rasqualle, dashboards      |
| `lcd`       | `40-LCD`       | Luxury Coastal Destinations: STR, cleaning, linen, bookings  |
| `personal`  | `50-Personal`  | family, health, property maintenance, personal ideas         |
| _(unknown)_ | `00-Inbox`     | fallback — a pillar not in the map never silently vanishes    |

Folders are numbered so they sort predictably in Obsidian. `00-Inbox` is retained as the
safety net (and is where Phase 1's notes already sit).

---

## Env / secrets change

| Was (Phase 1)        | Now (Phase 2)      | Notes                                                        |
|----------------------|--------------------|-------------------------------------------------------------|
| `VAULT_INBOX` = `…/00-Inbox` | `VAULT_ROOT` = `…/RASQUALLE-VAULT` | the worker derives the per-pillar folders under the root |

**Back-compat:** the worker and the deploy script both accept the old `VAULT_INBOX` and use
its parent directory as the root. So a plain `git pull` on the Mini keeps working even before
the plist is re-rendered — but **re-running the deploy script switches it to `VAULT_ROOT`
cleanly** (recommended).

---

## Deploy

On the Mac Mini (idempotent — same script as Phase 1, now prompts for the vault root):

```bash
cd ~/SterlingOrchestrator/worker
VAULT_ROOT="/Users/rasqualle_server/RASQUALLE-VAULT" bash deploy-on-mac-mini.sh
```

This pulls the latest code, re-renders the plist with `VAULT_ROOT`, and reloads the worker.

---

## Acceptance test

Speak to Sterling: *"Log an idea — spindle bogging on hardwood passes, try lowering feed rate
before blaming the VFD. Noosa Wood."*

Expect:
1. A row in `captures` with `pillar = 'noosawood'`.
2. A new `.md` file in **`20-NoosaWood/`** (not `00-Inbox`) within a few seconds.
3. `synced_to_vault` flips to `true`.

Then a `personal` capture should land in `50-Personal/`, a `bardeco` one in `10-BarDeco/`,
etc. If notes sort into their pillar folders, step 1 of Phase 2 is live.

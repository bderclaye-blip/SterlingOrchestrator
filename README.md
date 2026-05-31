# Sterling Orchestrator — Capture Pipeline

Voice-driven thought capture for Henry's system. Speak a thought → it routes to the
right pillar → lands in Supabase → mirrors into the Obsidian vault.

This is a **separate** project from `STERLING-RASQUALLE-OS` (the earlier time-management app).
Same Supabase project (`hkgjybzinahwminzfgwg`), distinct codebases — they may interconnect later.

Full spec and settled decisions:
[`docs/CAPTURE-PIPELINE.md`](docs/CAPTURE-PIPELINE.md) (Phase 1, the spine) and
[`docs/CAPTURE-PIPELINE-PHASE2.md`](docs/CAPTURE-PIPELINE-PHASE2.md) (Phase 2, the per-pillar router).

## Layout

```
supabase/
  config.toml                         # project ref + verify_jwt=false for capture-thought
  migrations/0001_captures.sql        # captures table + RLS + Realtime
  migrations/0002_capture_tasks.sql   # capture_tasks operational table (Phase 2 step 2)
  functions/capture-thought/index.ts  # the webhook ElevenLabs calls
worker/
  vault-mirror.mjs                    # Mac Mini Realtime → markdown mirror (Phase 2: pillar router)
  package.json
  com.rasqualle.vault-mirror.plist    # launchd template
docs/
  CAPTURE-PIPELINE.md                 # Phase 1 build spec (read this first)
  CAPTURE-PIPELINE-PHASE2.md          # Phase 2 build spec (per-pillar router)
.env.example                          # required secrets
```

## Phase 1 deploy checklist

1. **Database** — run `supabase/migrations/0001_captures.sql` in the Supabase SQL Editor
   (or `supabase db push` once the CLI is linked).
2. **Edge Function** — install the [Supabase CLI](https://supabase.com/docs/guides/cli)
   (`brew install supabase/tap/supabase`), then:
   ```bash
   supabase link --project-ref hkgjybzinahwminzfgwg
   supabase secrets set CAPTURE_SECRET=<long-random-string>
   supabase functions deploy capture-thought --no-verify-jwt
   ```
3. **ElevenLabs tool** — add the `capture_thought` webhook tool in the dashboard
   (URL, header, body params, system-prompt snippet all in the spec, §3).
4. **Mac Mini worker** — on the Mac Mini (one idempotent script does clone/pull, deps,
   config, and installs the launchd service so it runs 24/7 and restarts on reboot):
   ```bash
   git clone https://github.com/bderclaye-blip/SterlingOrchestrator.git ~/SterlingOrchestrator  # first time
   cd ~/SterlingOrchestrator/worker
   VAULT_ROOT="/absolute/path/to/RASQUALLE-VAULT" bash deploy-on-mac-mini.sh   # prompts for the service_role key
   ```
   Re-run the last line anytime to pull the latest code and reload the worker.
5. **Acceptance test** — speak the test phrase in the spec (§ Acceptance test) and confirm
   the row, the `.md` file, and `synced_to_vault = true`.

## Phase 2 — the per-pillar router (current)

The worker now routes each capture into its own pillar folder (`10-BarDeco`, `20-NoosaWood`,
`30-AI-OS`, `40-LCD`, `50-Personal`; unknown → `00-Inbox`) instead of one shared inbox. It's a
single pillar-aware worker, not five processes. Redeploy with the `VAULT_ROOT` line above.

**Step 2 — task promotion:** a `type='task'` capture is also promoted into the `capture_tasks`
operational table and surfaced as a rolling `_Tasks.md` open-tasks note in its pillar folder.
(Named `capture_tasks`, not `tasks`, because the old RASQUALLE-OS app already owns a `tasks`
table in this shared database.) One-time setup: run `supabase/migrations/0002_capture_tasks.sql`
in the Supabase SQL Editor.
Spec: [`docs/CAPTURE-PIPELINE-PHASE2.md`](docs/CAPTURE-PIPELINE-PHASE2.md).

Still later phases: Claude enrichment, pillar-specific actions (both additive on the worker's
`PILLARS` config), then pgvector recall and the time app.

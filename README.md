# Sterling Orchestrator — Capture Pipeline

Voice-driven thought capture for Henry's system. Speak a thought → it routes to the
right pillar → lands in Supabase → mirrors into the Obsidian vault.

This is a **separate** project from `STERLING-RASQUALLE-OS` (the earlier time-management app).
Same Supabase project (`hkgjybzinahwminzfgwg`), distinct codebases — they may interconnect later.

Full spec and settled decisions: [`docs/CAPTURE-PIPELINE.md`](docs/CAPTURE-PIPELINE.md).

## Layout

```
supabase/
  config.toml                         # project ref + verify_jwt=false for capture-thought
  migrations/0001_captures.sql        # captures table + RLS + Realtime
  functions/capture-thought/index.ts  # the webhook ElevenLabs calls
worker/
  vault-mirror.mjs                    # Mac Mini Realtime → markdown mirror
  package.json
  com.rasqualle.vault-mirror.plist    # launchd template
docs/CAPTURE-PIPELINE.md              # the build spec (read this first)
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
4. **Mac Mini worker** — on the Mac Mini:
   ```bash
   cd worker && npm install
   cp ../.env.example .env   # fill in SERVICE_ROLE_KEY + VAULT_INBOX
   npm run dev               # smoke test
   # then install the launchd plist for auto-restart (see the .plist header)
   ```
5. **Acceptance test** — speak the test phrase in the spec (§ Acceptance test) and confirm
   the row, the `.md` file, and `synced_to_vault = true`.

Stop after the spine works. Per-pillar workers, pgvector recall, and the time app are later phases.

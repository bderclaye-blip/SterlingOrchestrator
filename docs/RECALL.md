# Recall — Build Spec (Phase 3, v1 full-text)

The read side of the second brain. Sterling can answer *"what have I thought / said about X?"*
by searching the capture stream. Captures write to `captures`; recall reads from it.

**Read this before changing recall. Decisions below are settled.**

---

## Settled decisions

**v1 is full-text, not embeddings.** Postgres native full-text search over `captures`
(title + content) — no embeddings provider, no API key, no per-query cost. Justified now
because the library is real (~60+ captures) but small enough that keyword search is plenty.

**Semantic is the upgrade, not the start.** When the library is large enough that "by meaning"
beats "by keyword", add a pgvector embedding column + a semantic `search_captures` variant
(needs an embeddings key — Voyage/OpenAI). The Edge Function + agent tool stay the same; only
the SQL behind `search_captures()` changes. Don't take on the embeddings dependency early.

**Same hub + auth as everything else.** A `recall` Edge Function, shared-secret (`x-capture-secret`)
auth, service-role DB access. Sterling decides *when* to recall; the search runs server-side.

**The agent synthesises; the function just retrieves.** `recall` returns ranked raw matches;
Claude (Sterling) reads/summarises them into a spoken answer. No summarisation in the function.

---

## Pieces

- **`0004_recall.sql`** — a stored, GIN-indexed `fts` tsvector on `captures`, plus
  `search_captures(q, pillar_filter, max_results)` returning ranked matches
  (`websearch_to_tsquery`, optional pillar filter, capped at 25).
- **`functions/recall`** — POST `{query, pillar?, max_results?}` → `rpc('search_captures')` →
  `{ ok, count, results[], message }`. Validates query; ignores a bogus pillar.
- **Agent tool `recall`** (added in the ElevenLabs dashboard when credits allow) — webhook to
  the `recall` endpoint, `x-capture-secret` header, params `query` (required) + `pillar`
  (optional). Plus a system-prompt line: when Henry asks what he's thought/said/decided about
  something, call `recall` and answer from the results.

---

## Acceptance test

Backend (no voice / credits needed) — call the rpc directly with the service-role key:
1. `rpc search_captures {q:"CNC"}` → returns the CNC-related captures, ranked.
2. `rpc search_captures {q:"epoxy", pillar_filter:"noosawood"}` → only noosawood matches.
3. `recall` endpoint without the secret → 401; with it → the same results as the rpc.

Live (when ElevenLabs credits return): ask Sterling *"what have I thought about the CNC
breaker?"* → it calls `recall` and answers from your real captures.

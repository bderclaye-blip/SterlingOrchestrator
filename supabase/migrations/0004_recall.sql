-- Capture pipeline schema (Phase 3 — recall, v1 full-text)
-- Run in Supabase SQL Editor or via Management API. Project hkgjybzinahwminzfgwg. Idempotent.
--
-- v1 recall = Postgres full-text search over the capture stream — NO embeddings, no external
-- key, no cost. Sterling calls the `recall` Edge Function → search_captures() → ranked matches,
-- then synthesises a spoken answer. Upgrade path (later, once the library is large): add a
-- pgvector embedding column + semantic search so retrieval works "by meaning", not keyword.

-- A stored, indexed full-text vector over each capture's title + content.
alter table captures
  add column if not exists fts tsvector
  generated always as (
    to_tsvector('english', coalesce(title, '') || ' ' || coalesce(content, ''))
  ) stored;

create index if not exists captures_fts_idx on captures using gin (fts);

-- Ranked full-text search, with an optional pillar filter. websearch_to_tsquery lets Henry's
-- phrasing ("CNC breaker tripping") be used directly as a natural query.
create or replace function search_captures(
  q text,
  pillar_filter text default null,
  max_results int default 8
)
returns table (
  id uuid,
  created_at timestamptz,
  pillar text,
  type text,
  title text,
  content text,
  rank real
)
language sql
stable
as $$
  select c.id, c.created_at, c.pillar, c.type, c.title, c.content,
         ts_rank(c.fts, websearch_to_tsquery('english', q)) as rank
  from captures c
  where c.fts @@ websearch_to_tsquery('english', q)
    and (pillar_filter is null or c.pillar = pillar_filter)
  order by rank desc, c.created_at desc
  limit greatest(1, least(coalesce(max_results, 8), 25));
$$;

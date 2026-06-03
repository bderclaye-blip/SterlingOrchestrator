-- Vault sync (DB → Obsidian on edit/delete, not just insert)
-- Run in Supabase SQL Editor or via the Management API. Project hkgjybzinahwminzfgwg. Idempotent.
--
-- The vault-mirror worker now reacts to UPDATE/DELETE on captures and to all changes on
-- capture_tasks, so edits made in the OS app (Supabase = source of truth) are reflected in the
-- Obsidian vault. Two things are needed for that:
--   1. capture_tasks must emit realtime change events (captures already does — migration 0001).
--   2. DELETE events must carry the full old row (id + pillar) so the worker can find and remove
--      the right note / rebuild the right pillar's task list — that needs REPLICA IDENTITY FULL
--      (the default only ships the primary key).

-- 1. Add capture_tasks to the realtime publication (guarded so re-running doesn't error).
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'capture_tasks'
  ) then
    alter publication supabase_realtime add table capture_tasks;
  end if;
end
$$;

-- 2. Ship the full old row on UPDATE/DELETE for both tables.
alter table captures      replica identity full;
alter table capture_tasks replica identity full;

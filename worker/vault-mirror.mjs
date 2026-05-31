#!/usr/bin/env node
// vault-mirror — the Mac Mini mirror worker (Phase 1).
//
// Long-running process on the Mac Mini (it has the Obsidian vault on its filesystem).
// Subscribes to Realtime INSERTs on `captures` and writes each one as a markdown note
// into the vault inbox, then flips synced_to_vault = true.
//
// Sync is one-way OUT: Supabase → markdown. Never the reverse.
//
// Required env (see .env.example):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VAULT_INBOX
//
// Run under launchd (see com.rasqualle.vault-mirror.plist) so it restarts on reboot.
// Local test:  node --env-file=.env worker/vault-mirror.mjs

import { createClient } from "@supabase/supabase-js";
import { writeFile, access } from "node:fs/promises";

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VAULT_INBOX } = process.env;

for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VAULT_INBOX })) {
  if (!v) {
    console.error(`[vault-mirror] missing required env: ${k}`);
    process.exit(1);
  }
}

// Fail fast if the inbox isn't reachable, rather than silently dropping notes.
try {
  await access(VAULT_INBOX);
} catch {
  console.error(`[vault-mirror] VAULT_INBOX not accessible: ${VAULT_INBOX}`);
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function noteFor(c) {
  const slug = (c.title ?? c.content)
    .slice(0, 40)
    .replace(/\W+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  const stamp = c.created_at.slice(0, 16).replace(/[:T]/g, "-");
  // Suffix the row id so two captures in the same minute can't overwrite each other.
  const filename = `${stamp}-${slug || "note"}-${c.id.slice(0, 8)}.md`;
  const md = `---
created: ${c.created_at}
pillar: ${c.pillar}
type: ${c.type}
status: raw
source: ${c.source}
---
# ${c.title ?? "Captured"}

${c.content}
`;
  return { filename, md };
}

async function mirror(c) {
  try {
    const { filename, md } = noteFor(c);
    await writeFile(`${VAULT_INBOX}/${filename}`, md);
    await sb.from("captures").update({ synced_to_vault: true }).eq("id", c.id);
    console.log(`[vault-mirror] wrote ${filename} (${c.pillar}/${c.type})`);
  } catch (err) {
    // Leave synced_to_vault = false so a backfill / pg_cron fallback can retry.
    console.error(`[vault-mirror] failed to mirror ${c.id}:`, err);
  }
}

sb.channel("captures")
  .on(
    "postgres_changes",
    { event: "INSERT", schema: "public", table: "captures" },
    ({ new: c }) => mirror(c),
  )
  .subscribe((status) => {
    console.log(`[vault-mirror] realtime: ${status}`);
  });

console.log(`[vault-mirror] up. inbox: ${VAULT_INBOX}`);

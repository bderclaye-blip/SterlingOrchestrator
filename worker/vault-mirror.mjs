#!/usr/bin/env node
// vault-mirror — the Mac Mini mirror worker.
//
// Long-running process on the Mac Mini (it has the Obsidian vault on its filesystem).
// Subscribes to Realtime INSERTs on `captures` and writes each one as a markdown note
// into the vault, then flips synced_to_vault = true.
//
// Phase 1: every note landed in one shared inbox.
// Phase 2 (the router): each note is routed into a per-pillar folder. This is a single
// pillar-aware worker (a switch on pillar), NOT five processes. Future per-pillar logic
// (task promotion, Claude enrichment, custom actions) hangs off the PILLARS config map
// below, so adding it is additive — no rewrite of the routing or write path.
//
// Sync is one-way OUT: Supabase → markdown. Never the reverse.
//
// Required env (see .env.example):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VAULT_ROOT
//   (VAULT_INBOX is still accepted for back-compat — its parent dir is used as the root.)
//
// Run under launchd (see com.rasqualle.vault-mirror.plist) so it restarts on reboot.
// Local test:  node --env-file=.env worker/vault-mirror.mjs

import { createClient } from "@supabase/supabase-js";
import { writeFile, access, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

const { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } = process.env;

// Vault root = the folder that holds the per-pillar folders. Prefer VAULT_ROOT; fall
// back to the parent of the old VAULT_INBOX so a plain `git pull` on the Mini (whose
// plist still sets VAULT_INBOX=.../00-Inbox) keeps working until it's re-deployed.
const VAULT_ROOT =
  process.env.VAULT_ROOT ??
  (process.env.VAULT_INBOX ? dirname(process.env.VAULT_INBOX) : undefined);

// The router's per-pillar config. Today each pillar only declares its vault folder;
// later phases grow this object (e.g. taskList, enrich, actions) WITHOUT touching the
// routing or write path below. This map is the single place per-pillar behaviour lives.
const PILLARS = {
  bardeco: { folder: "10-BarDeco" },
  noosawood: { folder: "20-NoosaWood" },
  aios: { folder: "30-AI-OS" },
  lcd: { folder: "40-LCD" },
  personal: { folder: "50-Personal" },
};
// Unknown/missing pillar should never silently vanish — park it where it's visible.
const FALLBACK_FOLDER = "00-Inbox";

const folderFor = (pillar) => PILLARS[pillar]?.folder ?? FALLBACK_FOLDER;

for (const [k, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VAULT_ROOT })) {
  if (!v) {
    console.error(`[vault-mirror] missing required env: ${k === "VAULT_ROOT" ? "VAULT_ROOT (or VAULT_INBOX)" : k}`);
    process.exit(1);
  }
}

// Fail fast if the vault root isn't reachable, rather than silently dropping notes.
try {
  await access(VAULT_ROOT);
} catch {
  console.error(`[vault-mirror] VAULT_ROOT not accessible: ${VAULT_ROOT}`);
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
    const folder = folderFor(c.pillar);
    const dir = `${VAULT_ROOT}/${folder}`;
    // mkdir -p the pillar folder on demand so a new vault (or a new pillar) just works.
    await mkdir(dir, { recursive: true });
    await writeFile(`${dir}/${filename}`, md);
    await sb.from("captures").update({ synced_to_vault: true }).eq("id", c.id);
    console.log(`[vault-mirror] wrote ${folder}/${filename} (${c.pillar}/${c.type})`);
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

console.log(`[vault-mirror] up. routing per-pillar under: ${VAULT_ROOT}`);

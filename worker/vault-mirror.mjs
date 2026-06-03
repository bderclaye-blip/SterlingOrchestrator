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
// (Claude enrichment, custom actions) hangs off the PILLARS config map below, so adding
// it is additive — no rewrite of the routing or write path.
// Phase 2 step 2 (task promotion): a type='task' capture is ALSO inserted into the
// `capture_tasks` table (named to avoid colliding with the old RASQUALLE-OS app's `tasks`
// table in the same shared database) and surfaced as a per-pillar open-tasks note.
// Best-effort: it never blocks the mirror (the core guarantee), so a not-yet-migrated
// table just logs and the note still lands.
// Phase 2 step 3 (Claude enrichment): before writing, a fast Claude (Haiku) pass cleans the
// title, writes a one-line summary, and flags urgency, folded into the note's frontmatter
// and the promoted task's title. Also best-effort with a tight timeout: no ANTHROPIC_API_KEY,
// an API error, or a timeout just falls back to the raw note — enrichment never blocks a capture.
//
// Sync is one-way OUT: Supabase → markdown. Supabase is the source of truth; the vault is
// never read back. The worker reacts to INSERT, UPDATE and DELETE on `captures` (so an edit
// or deletion in the app/DB is reflected in the vault, not just new captures), and to changes
// on `capture_tasks` (to keep each pillar's _Tasks.md fresh).
//
// Required env (see .env.example):
//   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, VAULT_ROOT
//   (VAULT_INBOX is still accepted for back-compat — its parent dir is used as the root.)
// Optional env:
//   ANTHROPIC_API_KEY — enables Claude enrichment (unset = enrichment disabled, raw notes)
//   ENRICH_MODEL      — override the enrichment model (default claude-haiku-4-5)
//
// Run under launchd (see com.rasqualle.vault-mirror.plist) so it restarts on reboot.
// Local test:  node --env-file=.env worker/vault-mirror.mjs

import { createClient } from "@supabase/supabase-js";
import { writeFile, readFile, readdir, unlink, access, mkdir } from "node:fs/promises";
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
  bardeco: { folder: "10-BarDeco", name: "Bar Deco" },
  noosawood: { folder: "20-NoosaWood", name: "Noosa Wood" },
  aios: { folder: "30-AI-OS", name: "AI / OS" },
  lcd: { folder: "40-LCD", name: "Luxury Coastal Destinations" },
  personal: { folder: "50-Personal", name: "Personal" },
};
// Unknown/missing pillar should never silently vanish — park it where it's visible.
const FALLBACK_FOLDER = "00-Inbox";
// The rolling open-tasks note kept in each pillar folder. Leading underscore so Obsidian
// pins it near the top of the folder, above the dated capture notes.
const TASK_LIST_FILE = "_Tasks.md";

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

// --- Claude enrichment (optional, best-effort) ---------------------------------------
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
// `||` not `??`: an empty-string env (e.g. a blank plist value) must fall back to the default.
const ENRICH_MODEL = process.env.ENRICH_MODEL || "claude-haiku-4-5";
const ENRICH_TIMEOUT_MS = 8000;

// A forced tool call guarantees structured output — no prose-parsing.
const ENRICH_TOOL = {
  name: "record_enrichment",
  description: "Record cleaned-up filing metadata for a captured thought.",
  input_schema: {
    type: "object",
    properties: {
      title: { type: "string", description: "A clean 3–6 word title in Title Case, no trailing punctuation." },
      summary: { type: "string", description: "One concise sentence (≤20 words) capturing the thought." },
      urgency: { type: "string", enum: ["low", "normal", "high"], description: "How time-sensitive it is to act on." },
    },
    required: ["title", "summary", "urgency"],
  },
};

// Returns { title, summary, urgency } or null (disabled / error / timeout). Never throws.
async function enrich(c) {
  if (!ANTHROPIC_API_KEY) return null;
  const conf = PILLARS[c.pillar];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ENRICH_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: ENRICH_MODEL,
        max_tokens: 300,
        tools: [ENRICH_TOOL],
        tool_choice: { type: "tool", name: "record_enrichment" },
        messages: [{
          role: "user",
          content: `Pillar: ${conf?.name ?? c.pillar}. Capture type: ${c.type}.\n` +
            `Captured thought (verbatim):\n"""${c.content}"""\n\n` +
            `Clean this up for filing. Keep the owner's meaning; don't invent specifics.`,
        }],
      }),
    });
    if (!res.ok) throw new Error(`anthropic ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = await res.json();
    const block = data.content?.find((b) => b.type === "tool_use");
    const out = block?.input;
    if (!out?.title || !out?.summary) return null;
    return { title: out.title, summary: out.summary, urgency: out.urgency ?? "normal" };
  } catch (err) {
    console.error(`[vault-mirror] enrichment skipped for ${c.id}: ${err.message ?? err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Double-quote a value so it's a safe single-line YAML scalar (handles colons, quotes, etc).
const yaml = (v) => JSON.stringify(String(v));

// The note filename = the clean title, so Obsidian shows a readable name in the sidebar.
// The capture date lives in the `created` frontmatter (sort the explorer by it if you want
// chronological order) — it's no longer crammed into the filename. Strip filesystem- and
// Obsidian-reserved characters and cap the length.
function fileBaseFor(c, enr) {
  const raw = (enr?.title ?? c.title ?? c.content ?? "Captured").trim();
  const cleaned = raw
    .replace(/[\/\\:*?"<>|#^[\]]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80)
    .trim();
  return cleaned || "Captured";
}

// Pick a filename that won't clobber an existing note: "Title.md", then "Title 2.md", …
async function uniqueName(dir, base) {
  let name = `${base}.md`;
  for (let i = 2; ; i++) {
    try {
      await access(`${dir}/${name}`);
      name = `${base} ${i}.md`; // exists → try the next suffix
    } catch {
      return name; // free
    }
  }
}

function noteFor(c, enr) {
  const title = enr?.title ?? c.title ?? "Captured";
  // Prefer the row's own columns (set by app edits) over the one-shot enrichment, so a
  // manual edit in the app is honoured rather than overwritten on a re-mirror.
  const urgency = c.urgency ?? enr?.urgency;
  const fm = [
    `id: ${c.id}`, // lets the worker locate this note again on later edits/deletes
    `created: ${c.created_at}`,
    `pillar: ${c.pillar}`,
    `type: ${c.type}`,
    `status: ${c.status ?? "raw"}`,
    `source: ${c.source}`,
  ];
  if (enr?.summary) fm.push(`summary: ${yaml(enr.summary)}`);
  if (urgency) fm.push(`urgency: ${urgency}`);
  if (Array.isArray(c.tags) && c.tags.length) {
    fm.push(`tags: [${c.tags.map(yaml).join(", ")}]`);
  }
  return `---
${fm.join("\n")}
---
# ${title}

${c.content}
`;
}

// Locate an existing note by the `id:` stamped in its frontmatter, scanning the pillar
// folders (+ inbox). Lets a re-mirror or delete find the right file even after the title
// or pillar changed. Returns the full path or null.
async function findNoteById(id) {
  if (!id) return null;
  const folders = [...new Set([...Object.values(PILLARS).map((p) => p.folder), FALLBACK_FOLDER])];
  for (const folder of folders) {
    const dir = `${VAULT_ROOT}/${folder}`;
    let names;
    try {
      names = await readdir(dir);
    } catch {
      continue; // folder doesn't exist yet
    }
    for (const name of names) {
      if (!name.endsWith(".md") || name === TASK_LIST_FILE) continue;
      try {
        const text = await readFile(`${dir}/${name}`, "utf8");
        if (text.includes(`id: ${id}`)) return `${dir}/${name}`;
      } catch {
        /* unreadable — skip */
      }
    }
  }
  return null;
}

async function removeNoteById(id) {
  const path = await findNoteById(id);
  if (path) {
    await unlink(path);
    console.log(`[vault-mirror] removed ${path}`);
  }
}

// Reflect an edited capture: drop any existing note for this id (handles title/pillar change),
// then write a fresh one from the current row. No re-enrichment — the row is authoritative now.
async function reMirror(c) {
  await removeNoteById(c.id);
  const folder = folderFor(c.pillar);
  const dir = `${VAULT_ROOT}/${folder}`;
  await mkdir(dir, { recursive: true });
  const filename = await uniqueName(dir, fileBaseFor(c, null));
  await writeFile(`${dir}/${filename}`, noteFor(c, null));
  console.log(`[vault-mirror] re-mirrored ${folder}/${filename} (edit)`);
}

// Rebuild a pillar's open-tasks note from the tasks table. Regenerated wholesale (not
// appended) so it's always an honest snapshot of operational state — consistent with the
// one-way-OUT rule: this note is machine-owned. Ticking a box in Obsidian won't sync back
// and would be overwritten on the next rebuild; status changes belong in the DB.
async function rebuildTaskList(pillar) {
  const conf = PILLARS[pillar];
  if (!conf) return; // unknown pillar has no task list
  const { data: tasks, error } = await sb
    .from("capture_tasks")
    .select("id, title, created_at")
    .eq("pillar", pillar)
    .eq("status", "open")
    .order("created_at", { ascending: true });
  if (error) throw error;

  const dir = `${VAULT_ROOT}/${conf.folder}`;
  await mkdir(dir, { recursive: true });
  const lines = (tasks ?? []).map((t) => `- [ ] ${t.title}  <!-- task:${t.id} -->`);
  const md = `---
type: task-list
pillar: ${pillar}
---
# ${conf.name} — Open Tasks

${lines.length ? lines.join("\n") : "_No open tasks._"}
`;
  await writeFile(`${dir}/${TASK_LIST_FILE}`, md);
  return tasks?.length ?? 0;
}

// Promote a type='task' capture into the tasks table, then refresh its pillar's task list.
// Uses the enriched title when available. Idempotent via the unique source_capture_id:
// reprocessing the same capture is a no-op.
async function promoteTask(c, enr) {
  const title = (enr?.title ?? c.title ?? c.content.split("\n")[0]).slice(0, 80).trim();
  const { error } = await sb
    .from("capture_tasks")
    .upsert(
      { pillar: c.pillar, title, detail: c.content, source_capture_id: c.id },
      { onConflict: "source_capture_id", ignoreDuplicates: true },
    );
  if (error) throw error;
  const open = await rebuildTaskList(c.pillar);
  console.log(`[vault-mirror] promoted task → ${c.pillar} (${open} open)`);
}

async function mirror(c) {
  // Enrichment runs before the write so it can shape the note + task. Best-effort: null on
  // disabled/error/timeout, in which case everything below falls back to the raw capture.
  const enr = await enrich(c);

  try {
    const md = noteFor(c, enr);
    const folder = folderFor(c.pillar);
    const dir = `${VAULT_ROOT}/${folder}`;
    // mkdir -p the pillar folder on demand so a new vault (or a new pillar) just works.
    await mkdir(dir, { recursive: true });
    const filename = await uniqueName(dir, fileBaseFor(c, enr));
    await writeFile(`${dir}/${filename}`, md);
    await sb.from("captures").update({ synced_to_vault: true }).eq("id", c.id);
    console.log(`[vault-mirror] wrote ${folder}/${filename} (${c.pillar}/${c.type})${enr ? " [enriched]" : ""}`);
  } catch (err) {
    // Leave synced_to_vault = false so a backfill / pg_cron fallback can retry.
    console.error(`[vault-mirror] failed to mirror ${c.id}:`, err);
    return;
  }

  // Task promotion is additive and best-effort: the note above already mirrored (the core
  // guarantee), so a promotion failure (e.g. tasks table not migrated yet) is logged but
  // never re-fails the capture.
  if (c.type === "task") {
    try {
      await promoteTask(c, enr);
    } catch (err) {
      console.error(`[vault-mirror] task promotion failed for ${c.id} (is the tasks table migrated?):`, err.message ?? err);
    }
  }
}

// A capture changed. INSERT → mirror (with enrichment). UPDATE → re-mirror the edited row
// (no enrichment, so app edits stick). DELETE → remove the note. Each is best-effort.
async function onCaptureChange(payload) {
  try {
    if (payload.eventType === "DELETE") {
      await removeNoteById(payload.old?.id);
    } else if (payload.eventType === "INSERT") {
      await mirror(payload.new);
    } else {
      await reMirror(payload.new);
    }
  } catch (err) {
    console.error(`[vault-mirror] capture ${payload.eventType} failed:`, err.message ?? err);
  }
}

// A task changed (created/edited/completed/deleted in the app) → rebuild that pillar's
// _Tasks.md so the vault rollup stays honest. Needs the pillar from the row; on DELETE that
// requires REPLICA IDENTITY FULL (see migration 0005).
async function onTaskChange(payload) {
  const pillar = payload.new?.pillar ?? payload.old?.pillar;
  if (!pillar) return;
  try {
    const open = await rebuildTaskList(pillar);
    console.log(`[vault-mirror] tasks ${payload.eventType} → ${pillar} (${open} open)`);
  } catch (err) {
    console.error(`[vault-mirror] task-list rebuild failed for ${pillar}:`, err.message ?? err);
  }
}

// Separate channel per table: bundling two postgres_changes bindings on ONE channel makes a
// failure in either binding tear down the whole channel (a TIMED_OUT/CHANNEL_ERROR loop that
// silently stops delivering everything). Isolated channels keep captures syncing even if the
// capture_tasks binding has trouble. Log the error detail so failures are diagnosable.
const subLogger = (name) => (status, err) =>
  console.log(`[vault-mirror] realtime[${name}]: ${status}${err ? ` — ${err.message ?? err}` : ""}`);

sb.channel("captures-sync")
  .on("postgres_changes", { event: "*", schema: "public", table: "captures" }, onCaptureChange)
  .subscribe(subLogger("captures"));

sb.channel("tasks-sync")
  .on("postgres_changes", { event: "*", schema: "public", table: "capture_tasks" }, onTaskChange)
  .subscribe(subLogger("tasks"));

console.log(`[vault-mirror] up. routing per-pillar under: ${VAULT_ROOT}`);

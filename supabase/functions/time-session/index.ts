// time-session — the webhook Sterling calls to start/stop a time-tracking session.
//
// "I'm off to the bank for Bar Deco" -> {action:'start', pillar:'bardeco', activity:'bank'}
// "I'm back"                          -> {action:'end'}
//
// Time data is operational state: it lives in Supabase, NOT the vault. The agent only decides
// when to call this; all writes happen here with the service-role key.
//
// Publicly reachable, so it authenticates with the same shared secret as capture-thought.
// Deploy:  supabase functions deploy time-session --no-verify-jwt
//
// Rules (see docs/TIME-TRACKING.md):
//  1. One active session at a time — starting closes any open session first.
//  2. A session open > 8h is closed as 'auto_closed' (forgotten clock-out, duration uncertain).
//  3. start captures a short free-text activity alongside the pillar.

import { createClient } from "jsr:@supabase/supabase-js@2";

const PILLARS = ["bardeco", "noosawood", "aios", "lcd", "personal"];
const EIGHT_HOURS_MS = 8 * 60 * 60 * 1000;

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  if (req.headers.get("x-capture-secret") !== Deno.env.get("CAPTURE_SECRET")) {
    return new Response("unauthorized", { status: 401 });
  }

  let body: { action?: string; pillar?: string; activity?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }
  const { action, pillar, activity } = body;

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  // Close every open session. Sessions open longer than 8h are flagged auto_closed (their
  // duration is unreliable). Returns the most recently-started one we closed (for reporting).
  async function closeOpen() {
    const { data: open, error } = await sb
      .from("time_sessions")
      .select("id, started_at")
      .eq("status", "open")
      .order("started_at", { ascending: false });
    if (error) throw error;
    const now = Date.now();
    for (const s of open ?? []) {
      const stale = now - new Date(s.started_at).getTime() > EIGHT_HOURS_MS;
      await sb
        .from("time_sessions")
        .update({ ended_at: new Date().toISOString(), status: stale ? "auto_closed" : "closed" })
        .eq("id", s.id);
    }
    return open?.[0] ?? null;
  }

  try {
    if (action === "start") {
      if (!pillar || !PILLARS.includes(pillar)) {
        return Response.json(
          { ok: false, error: `pillar must be one of: ${PILLARS.join(", ")}` },
          { status: 400 },
        );
      }
      await closeOpen(); // rule 1: one active session at a time
      const { error } = await sb
        .from("time_sessions")
        .insert({ pillar, activity: activity ?? null, source: "voice" })
        .select("id")
        .single();
      if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });
      return Response.json({
        ok: true,
        message: `Started — ${pillar}${activity ? ` (${activity})` : ""}.`,
      });
    }

    if (action === "end") {
      const closed = await closeOpen();
      if (!closed) return Response.json({ ok: true, message: "Nothing was running." });
      const { data: row } = await sb
        .from("time_sessions")
        .select("pillar, duration_seconds")
        .eq("id", closed.id)
        .single();
      const mins = row?.duration_seconds ? Math.round(row.duration_seconds / 60) : 0;
      return Response.json({ ok: true, message: `Logged ${mins} min on ${row?.pillar}.` });
    }

    return Response.json({ ok: false, error: "action must be 'start' or 'end'" }, { status: 400 });
  } catch (err) {
    return Response.json({ ok: false, error: String((err as Error).message ?? err) }, { status: 500 });
  }
});

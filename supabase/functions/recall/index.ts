// recall — the webhook Sterling calls to search Henry's past captures (Phase 3, v1 full-text).
//
// "What have I thought about the CNC breaker?" -> {query:"CNC breaker", pillar?:"noosawood"}
//
// Runs full-text search over the capture stream via search_captures() and returns the ranked
// matches for Sterling (Claude) to read back / synthesise a spoken answer. This is the read
// side of the second brain: captures write here, recall reads from here.
//
// Same shared-secret auth as the other functions. Deploy:
//   supabase functions deploy recall --no-verify-jwt

import { createClient } from "jsr:@supabase/supabase-js@2";

const PILLARS = ["bardeco", "noosawood", "aios", "lcd", "personal"];

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("method not allowed", { status: 405 });

  if (req.headers.get("x-capture-secret") !== Deno.env.get("CAPTURE_SECRET")) {
    return new Response("unauthorized", { status: 401 });
  }

  let body: { query?: string; pillar?: string; max_results?: number };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const { query, pillar } = body;
  if (!query || typeof query !== "string" || query.trim() === "") {
    return Response.json({ ok: false, error: "query is required" }, { status: 400 });
  }
  // Only honour a pillar filter if it's a real pillar; otherwise search across everything.
  const pillarFilter = pillar && PILLARS.includes(pillar) ? pillar : null;

  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { data, error } = await sb.rpc("search_captures", {
    q: query,
    pillar_filter: pillarFilter,
    max_results: typeof body.max_results === "number" ? body.max_results : 8,
  });
  if (error) return Response.json({ ok: false, error: error.message }, { status: 500 });

  const results = (data ?? []).map((r: Record<string, unknown>) => ({
    title: r.title,
    content: r.content,
    pillar: r.pillar,
    type: r.type,
    created_at: r.created_at,
  }));

  return Response.json({
    ok: true,
    count: results.length,
    results,
    // A one-line hint the agent can lead with before reading the matches.
    message: results.length
      ? `Found ${results.length} related note${results.length > 1 ? "s" : ""}.`
      : "Nothing captured on that yet.",
  });
});

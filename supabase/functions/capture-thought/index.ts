// capture-thought — the webhook the ElevenLabs agent calls to file a thought.
//
// The agent (conductor) only DECIDES to call this tool and which pillar a thought
// belongs to. All writes happen here, server-side, with the service-role key.
//
// Publicly reachable, so it authenticates with a shared secret header instead of a
// Supabase JWT. Deploy with --no-verify-jwt (ElevenLabs has no Supabase JWT):
//
//   supabase secrets set CAPTURE_SECRET=<your-long-random-string>
//   supabase functions deploy capture-thought --no-verify-jwt
//
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected into functions by default.

import { createClient } from "jsr:@supabase/supabase-js@2";

const PILLARS = ["bardeco", "noosawood", "aios", "lcd", "personal"];
const TYPES = ["idea", "task", "update", "fix", "decision", "log"];

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("method not allowed", { status: 405 });
  }

  // Shared-secret auth. The same value lives in the ElevenLabs tool header.
  if (req.headers.get("x-capture-secret") !== Deno.env.get("CAPTURE_SECRET")) {
    return new Response("unauthorized", { status: 401 });
  }

  let body: { pillar?: string; type?: string; title?: string; content?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ ok: false, error: "invalid JSON body" }, { status: 400 });
  }

  const { pillar, type, title, content } = body;

  // Validate up front so a bad route returns a clear 400 instead of an opaque
  // 500 from the DB check constraints.
  if (!pillar || !PILLARS.includes(pillar)) {
    return Response.json(
      { ok: false, error: `pillar must be one of: ${PILLARS.join(", ")}` },
      { status: 400 },
    );
  }
  if (!type || !TYPES.includes(type)) {
    return Response.json(
      { ok: false, error: `type must be one of: ${TYPES.join(", ")}` },
      { status: 400 },
    );
  }
  if (!content || typeof content !== "string" || content.trim() === "") {
    return Response.json({ ok: false, error: "content is required" }, { status: 400 });
  }

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const { error } = await supabase
    .from("captures")
    .insert({ pillar, type, title: title ?? null, content, source: "voice" })
    .select("id")
    .single();

  if (error) {
    return Response.json({ ok: false, error: error.message }, { status: 500 });
  }

  // The agent can speak this back, e.g. "Logged to Noosa Wood."
  return Response.json({ ok: true, pillar });
});

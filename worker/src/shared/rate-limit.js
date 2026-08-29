import { hashIp } from "./runtime.js";

// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: rate guard
// Protects the /chat pipeline (Phase D: 2 Anthropic calls on every completed
// turn — main reply + Scoring Agent — plus the async quality evaluator when a
// session_id is present) from a traffic spike or abuse pattern generating an
// unexpected bill before Ed notices. Backed by a KV namespace (RATE_LIMIT_KV).
//
// PLACEHOLDER LIMITS — flagged per Phase A instructions, not based on real
// traffic data. As of 2026-08-24, /chat has effectively zero visitor traffic.
// Revisit these numbers once real usage is observed; they exist to catch a
// runaway script or bot hitting the endpoint, not to meter legitimate use.
//
// KV counting here is eventually consistent, not atomic — under a genuine
// burst, two near-simultaneous requests in different Cloudflare datacenters
// could both read the pre-increment count. That's an accepted tradeoff for
// an abuse/cost-runaway guard: it caps traffic roughly, not to the exact
// request, which is the right shape for this job. A second, independent
// backstop (a Cloudflare dashboard Rate Limiting rule on api.frontframe.co
// /chat) is documented separately as this mechanism's fallback.
// ════════════════════════════════════════════════════════════════════════════

export const IP_LIMIT_PER_MINUTE   = 8;    // per visitor — catches a single script/bot hammering the endpoint
export const GLOBAL_LIMIT_PER_HOUR = 100;  // site-wide — catches distributed abuse or a traffic spike from any source

// Shown to visitors when a limit is hit. Draft copy — Ed's edit, not final.
export const RATE_LIMITED_MESSAGE =
  "We're experiencing high demand right now. Please try again in a few minutes.";

async function incrementAndCheck(env, key, limit, ttlSeconds) {
  const current = await env.RATE_LIMIT_KV.get(key);
  const count   = current ? parseInt(current, 10) : 0;
  if (count >= limit) return { allowed: false, count };
  // expirationTtl auto-expires the key — no cleanup job needed.
  await env.RATE_LIMIT_KV.put(key, String(count + 1), { expirationTtl: ttlSeconds });
  return { allowed: true, count: count + 1 };
}

// Returns { allowed: boolean, reason?: "ip" | "global" }.
// Call this before any Supabase content lookup or Anthropic call in the
// chat pipeline, so a blocked request costs nothing beyond one or two KV ops.
export async function checkChatRateLimit(env, request) {
  if (!env.RATE_LIMIT_KV) {
	// KV binding not yet provisioned — fail open rather than break /chat.
	console.error("RATE_LIMIT_KV binding missing — rate guard is not active");
	return { allowed: true };
  }

  const ip           = request.headers.get("cf-connecting-ip") || "unknown";
  const hashedIp      = await hashIp(ip);
  const minuteBucket  = Math.floor(Date.now() / 60000);
  const hourBucket    = Math.floor(Date.now() / 3600000);

  const ipResult = await incrementAndCheck(
	env, `chat_ip:${hashedIp}:${minuteBucket}`, IP_LIMIT_PER_MINUTE, 120);
  if (!ipResult.allowed) return { allowed: false, reason: "ip" };

  const globalResult = await incrementAndCheck(
	env, `chat_global:${hourBucket}`, GLOBAL_LIMIT_PER_HOUR, 7200);
  if (!globalResult.allowed) return { allowed: false, reason: "global" };

  return { allowed: true };
}


// ════════════════════════════════════════════════════════════════════════════
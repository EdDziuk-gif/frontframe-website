/**
 * FrontFrame Operational Worker
 * Cloudflare Worker — src/index.js
 *
 * Architecture: single-file modular layout
 *   § CONSTANTS & PATTERNS
 *   § RESPONSE HELPERS
 *   § SUPABASE DATA ACCESS
 *   § ANTHROPIC
 *   § DOMAIN: auth
 *   § DOMAIN: chat
 *   § DOMAIN: notify
 *   § DOMAIN: inquiry
 *   § DOMAIN: qa
 *   § DOMAIN: proposal
 *   § DOMAIN: podcast-episodes
 *   § DOMAIN: rss-proxy
 *   § DOMAIN: config
 *   § DOMAIN: defects
 *   § DOMAIN: feedback
 *   § DOMAIN: changelog
 *   § DOMAIN: leads
 *   § DOMAIN: lead-alerts
 *   § DOMAIN: agreements
 *   § DOMAIN: system-prompt
 *   § DOMAIN: reviewers
 *   § DOMAIN: marketing-log
 *   § DOMAIN: problem-statements
 *   § DOMAIN: deliverables
 *   § DOMAIN: subscriptions
 *   § DOMAIN: payments
 *   § DOMAIN: vault
 *   § DOMAIN: office-hours
 *   § DOMAIN: rd-log
 *   § DOMAIN: outreach
 *   § DOMAIN: review-queue
 *   § DOMAIN: webhooks
 *   § DOMAIN: sms (Surge)
 *   § DOMAIN: email (Resend)
 *   § DOMAIN: docuseal
 *   § DOMAIN: stripe
 *   § UTILITY: ip hash, phoenix timezone
 *   § DOMAIN: debug  ← empty in production; populated only during a debug episode
 *   § ROUTER
 *
 * Debugging protocol:
 *   1. Form a defect theory precise enough to know what to log.
 *   2. Write a targeted handler in the DEBUG section below.
 *   3. Add one entry to DEBUG_ROUTES pointing to that handler.
 *   4. Deploy: npx wrangler deploy --config ~/Development_Assets/FrontFrame_Website_CoWork/frontframe-worker/wrangler.jsonc --no-bundle
 *   5. Observe via: npx wrangler tail --config ~/Development_Assets/FrontFrame_Website_CoWork/frontframe-worker/wrangler.jsonc
 *   6. Trigger the suspect condition; read the log.
 *   7. Remove the debug handler and its DEBUG_ROUTES entry before next production deploy.
 *
 * Secrets: SUPABASE_SERVICE_ROLE_KEY, ANTHROPIC_API_KEY, SURGE_API_KEY,
 *          DOCUSEAL_API_KEY, STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
 *          RESEND_API_KEY
 *          (VAULT_ENCRYPTION_KEY retired 2026-07-03 — vault encryption is
 *          now handled by Supabase's own Vault, not a Worker secret)
 */


// ════════════════════════════════════════════════════════════════════════════
// § CONSTANTS & PATTERNS
// ════════════════════════════════════════════════════════════════════════════

const ANTHROPIC_MODEL      = "claude-sonnet-4-6";
const ANTHROPIC_MAX_TOKENS = 1024;

const SURGE_ACCOUNT_ID = "acct_01krevy9esf46rgm7ym1e66k8k";
const SURGE_TO_NUMBER  = "+14803600069";

const RESEND_FROM  = "FrontFrame LLC <ed@frontframe.co>";
const ADMIN_EMAIL  = "ed@frontframe.co";
const ADMIN_URL    = "https://frontframe.co/admin";

const STRIPE_PRICE_IDS = {
  due_diligence_deposit:               "price_1TSiPFAdkI41hYTRVam5PmPW",
  standard_implementation_deposit:     "price_1TSiLOAdkI41hYTR7kO86MP0",
  professional_implementation_deposit: "price_1TSikEAdkI41hYTRVta0cQ7G",
  standard_completion:                 "price_1TSiUdAdkI41hYTRzr9naeqQ",
  professional_completion:             "price_1TSin8AdkI41hYTRCyqIdSF7",
};

const DAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

const ESCALATION_PATTERN = /\{[^{}]*"_escalate"\s*:\s*true[^{}]*\}/s;
const DEFECT_PATTERN     = /\{[^{}]*"_defect"\s*:\s*true[^{}]*\}/s;
const RESEARCH_PATTERN   = /\{[^{}]*"_research"\s*:\s*true[^{}]*\}/s;

const GAP_SIGNAL = "I do not have a strong answer to that yet";

const TESTING_LAYER = `

---

TESTING MODE — You are operating in a pre-launch testing environment. Real prospects
are not present. Testers are FrontFrame staff, contractors, or designated client reviewers.

If you do not have a confident answer to a question, say so directly:
"I do not have a strong answer to that yet. What do you think the right answer is?"

Do not simulate confidence you do not have. Honest gaps found in testing are valuable.
Gaps found by a real prospect are not.`;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin":  "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};


// ════════════════════════════════════════════════════════════════════════════
// § RESPONSE HELPERS
// ════════════════════════════════════════════════════════════════════════════

function jsonResponse(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function extractJwt(request) {
  const match = (request.headers.get("Authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

// Non-/admin/* routes that are still staff-only tools (office hours schedule
// management, R&D log) and therefore still need the reviewer gate below.
// Everything under /admin/* is covered automatically by the prefix check in
// fetch(); this Set only exists for the handful of exceptions.
const ADMIN_EXTRA_PROTECTED_PATHS = new Set([
  "/api/office-hours/schedule",
  "/api/office-hours/schedule/:day",
  "/api/office-hours/overrides",
  "/api/office-hours/overrides/:date",
  "/api/rd-log",
  "/api/rd-log/:id",
]);

// Added 2026-07-24 -- see docs/stack.md "Admin Access Control Decision" for
// why this is an app-layer gate rather than Postgres RLS.
//
// Validates the caller's bearer token against Supabase Auth itself (so a
// forged/expired/signed-out token is rejected even though this Worker never
// signed it), then checks the corresponding row in `reviewers` has an
// allowed role and is active. Mirrors the same role pair already enforced
// at the database layer via is_reviewer() for tables that have RLS.
async function requireReviewer(request, env, allowedRoles = ["frontframe_admin", "frontframe_staff"]) {
  const jwt = extractJwt(request);
  if (!jwt) return { ok: false, status: 401, error: "Missing Authorization header" };

  const userRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { "apikey": env.SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${jwt}` },
  });
  if (!userRes.ok) return { ok: false, status: 401, error: "Invalid or expired session" };

  const user  = await userRes.json();
  const email = user?.email;
  if (!email) return { ok: false, status: 401, error: "Invalid session" };

  const rows = await supabaseFetch(env, "reviewers",
    `?select=role,active&email=eq.${encodeURIComponent(email)}`);
  const reviewer = rows?.[0];
  if (!reviewer || reviewer.active === false)
    return { ok: false, status: 403, error: "Not an active reviewer" };
  if (allowedRoles && !allowedRoles.includes(reviewer.role))
    return { ok: false, status: 403, error: "Insufficient role" };

  return { ok: true, email, role: reviewer.role };
}


// ════════════════════════════════════════════════════════════════════════════
// § SUPABASE DATA ACCESS
// ════════════════════════════════════════════════════════════════════════════

function supabaseHeaders(env) {
  return {
    "Content-Type":  "application/json",
    "apikey":        env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Prefer":        "return=representation",
  };
}

async function supabaseFetch(env, table, query = "", _userJwt = null) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}${query}`,
    { method: "GET", headers: supabaseHeaders(env) });
  if (!res.ok) throw new Error(`Supabase GET ${table} failed: ${await res.text()}`);
  return res.json();
}

async function supabasePost(env, table, payload, _userJwt = null) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`,
    { method: "POST", headers: supabaseHeaders(env), body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`Supabase POST ${table} failed: ${await res.text()}`);
  return res.json();
}

async function supabasePatch(env, table, id, payload, _userJwt = null) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`,
    { method: "PATCH", headers: supabaseHeaders(env), body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`Supabase PATCH ${table} failed: ${await res.text()}`);
  return res.json();
}

async function supabasePatchByField(env, table, field, value, payload) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/${table}?${field}=eq.${encodeURIComponent(value)}`,
    { method: "PATCH", headers: supabaseHeaders(env), body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`Supabase PATCH ${table} by ${field} failed: ${await res.text()}`);
  return res.json();
}

async function supabaseUpsert(env, table, payload, _userJwt = null) {
  const headers = { ...supabaseHeaders(env), "Prefer": "return=representation,resolution=merge-duplicates" };
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`,
    { method: "POST", headers, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`Supabase UPSERT ${table} failed: ${await res.text()}`);
  return res.json();
}

async function supabaseDelete(env, table, id, _userJwt = null) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`,
    { method: "DELETE", headers: supabaseHeaders(env) });
  if (!res.ok) throw new Error(`Supabase DELETE ${table} failed: ${await res.text()}`);
}

async function supabaseRpc(env, fnName, params = {}) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fnName}`,
    { method: "POST", headers: supabaseHeaders(env), body: JSON.stringify(params) });
  if (!res.ok) throw new Error(`Supabase RPC ${fnName} failed: ${await res.text()}`);
  return res.json();
}


// ════════════════════════════════════════════════════════════════════════════
// § ANTHROPIC
// ════════════════════════════════════════════════════════════════════════════

async function callAnthropic(env, systemPrompt, messages) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model:      ANTHROPIC_MODEL,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      system:     systemPrompt,
      messages,
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API call failed: ${await res.text()}`);
  return (await res.json()).content?.[0]?.text ?? "";
}

function buildSystemPrompt(systemPromptContent, qaPairs) {
  let prompt = systemPromptContent ?? "";
  if (qaPairs?.length)
    prompt += `\n\n---\n\nKnowledge Base:\n\n${qaPairs.map(r => `Q: ${r.question}\nA: ${r.answer}`).join("\n\n")}`;
  return prompt;
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: auth
// ════════════════════════════════════════════════════════════════════════════

async function handleSendOtp(request, env, corsHeaders) {
  const { email } = await request.json().catch(() => ({}));
  if (!email) return jsonResponse({ error: "email is required" }, 400, corsHeaders);
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/otp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": env.SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ email, create_user: false }),
  });
  if (!res.ok) {
    console.error("OTP send failed:", await res.text());
    return jsonResponse({ error: "Failed to send code." }, res.status, corsHeaders);
  }
  return jsonResponse({ sent: true }, 200, corsHeaders);
}

async function handleVerifyOtp(request, env, corsHeaders) {
  const { email, token } = await request.json().catch(() => ({}));
  if (!email || !token) return jsonResponse({ error: "email and token are required" }, 400, corsHeaders);
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": env.SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ email, token, type: "email" }),
  });
  if (!res.ok) {
    console.error("OTP verify failed:", await res.text());
    return jsonResponse({ error: "Invalid or expired code." }, 401, corsHeaders);
  }
  const data = await res.json();
  return jsonResponse({ access_token: data.access_token, refresh_token: data.refresh_token }, 200, corsHeaders);
}

async function handleMagicLink(request, env, corsHeaders) {
  const { email } = await request.json();
  if (!email || email.toLowerCase() !== ADMIN_EMAIL)
    return jsonResponse({ error: "Unauthorized" }, 403, corsHeaders);

  const genRes = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": env.SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ type: "magiclink", email: ADMIN_EMAIL, options: { redirect_to: ADMIN_URL } }),
  });
  if (!genRes.ok) throw new Error(`Magic link generation failed: ${await genRes.text()}`);
  const genData   = await genRes.json();
  const magicLink = genData.action_link;
  if (!magicLink) return jsonResponse({ error: "Failed to generate sign-in link" }, 500, corsHeaders);

  const html = `<!DOCTYPE html><html><body style="font-family:Inter,system-ui,sans-serif;color:#1E2D40;max-width:480px;margin:0 auto;padding:40px 24px">
<div style="margin-bottom:32px"><strong style="font-size:1.1rem">FrontFrame Admin</strong></div>
<p style="margin-bottom:20px">Click below to sign in to the FrontFrame Admin Portal. This link expires in 1 hour and can only be used once.</p>
<p style="margin:32px 0"><a href="${magicLink}" style="background:#1E2D40;color:white;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">Sign In to Admin</a></p>
<p style="font-size:0.8rem;color:#8A9BAE">If you did not request this link, you can safely ignore this email.</p>
<hr style="border:none;border-top:1px solid #E8ECF0;margin:32px 0">
<p style="font-size:0.75rem;color:#8A9BAE">FrontFrame LLC</p>
</body></html>`;

  await sendResendEmail(env, ADMIN_EMAIL, "FrontFrame Admin Sign-In Link", html);
  return jsonResponse({ sent: true }, 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: chat
// ════════════════════════════════════════════════════════════════════════════

async function handleChat(request, env, ctx, corsHeaders) {
  const body = await request.json();
  const { page, message, history = [], session_id = null } = body;
  if (!page || !message) return jsonResponse({ error: "page and message are required" }, 400, corsHeaders);

  const configRows = await supabaseFetch(env, "config", "?id=eq.1&select=mode,build_version,capture_enabled");
  const config = configRows?.[0] ?? { mode: "live", build_version: "unknown", capture_enabled: false };

  const promptRow           = await supabaseFetch(env, "system_prompt", `?page=eq.${encodeURIComponent(page)}&select=content`);
  const systemPromptContent = promptRow?.[0]?.content ?? "";
  const qaPairs             = await supabaseFetch(env, "qa_pairs",
    `?select=question,answer&or=(page.eq.all,page.eq.${encodeURIComponent(page)})&order=created_at.asc`);

  let combinedPrompt = buildSystemPrompt(systemPromptContent, qaPairs);
  if (config.mode === "testing") combinedPrompt += TESTING_LAYER;

  const hoursText = await getTodayOfficeHoursText(env);
  if (hoursText) combinedPrompt = hoursText + "\n\n" + combinedPrompt;

  const messages = [...history, { role: "user", content: message }];
  const rawReply = await callAnthropic(env, combinedPrompt, messages);

  // ── Escalation detection ─────────────────────────────────────────────────
  let response   = rawReply;
  let escalation = null;
  const escMatch = rawReply.match(ESCALATION_PATTERN);

  if (escMatch) {
    response = rawReply.replace(ESCALATION_PATTERN, "").trim();
    try { escalation = JSON.parse(escMatch[0]); }
    catch { escalation = { _escalate: true, reason: "unknown", prospect: "Visitor" }; }

    const alertPayload = {
      session_id: null, page,
      prospect_name:  escalation.prospect     ?? "Visitor",
      trigger_reason: escalation.reason       ?? "",
      current_site:   escalation.current_site ?? null,
      status: "new", sms_sent: false, sms_status: null,
    };

    ctx.waitUntil(
      supabasePost(env, "lead_alerts", alertPayload)
        .then(async (alertRows) => {
          const alertId = alertRows?.[0]?.alert_id ?? null;
          const smsMessage =
            `FrontFrame alert\nProspect: ${escalation.prospect ?? "Visitor"}\nPage: ${page}\n` +
            `Signal: ${escalation.reason ?? "escalation"}\n` +
            (escalation.contact_preference ? `Contact: ${escalation.contact_preference} - ${escalation.contact_value ?? "not provided"}\n` : "") +
            (escalation.current_site ? `Site: ${escalation.current_site}\n` : "") +
            `Reply to continue the conversation.`;
          const smsResult = await sendSms(env, smsMessage);
          if (alertId) {
            await supabasePatchByField(env, "lead_alerts", "alert_id", alertId,
              { sms_sent: smsResult.success, sms_status: smsResult.status })
              .catch((e) => console.error("lead_alert update failed:", e));
          }
        })
        .catch((e) => console.error("lead_alert write failed:", e))
    );
  }

  // ── Defect detection ─────────────────────────────────────────────────────
  const defMatch = response.match(DEFECT_PATTERN);
  if (defMatch) {
    response = response.replace(DEFECT_PATTERN, "").trim();
    let defectPayload;
    try {
      const parsed = JSON.parse(defMatch[0]);
      defectPayload = {
        area: parsed.area ?? "conversation", description: parsed.description ?? "(no description)",
        severity: parsed.severity ?? "low", disposition: parsed.disposition ?? "retain",
        build_version: config.build_version ?? "unknown", stage_gate: config.stage_gate ?? "build",
      };
    } catch {
      defectPayload = {
        area: "conversation", description: "Marker unparsed. Raw: " + defMatch[0].slice(0, 200),
        severity: "low", disposition: "retain",
        build_version: config.build_version ?? "unknown", stage_gate: config.stage_gate ?? "build",
      };
    }
    ctx.waitUntil(supabasePost(env, "defects", defectPayload).catch((e) => console.error("defect write failed:", e)));
  }

  // ── Research detection ───────────────────────────────────────────────────
  const researchMatch = response.match(RESEARCH_PATTERN);
  if (researchMatch) {
    response = response.replace(RESEARCH_PATTERN, "").trim();
    let leadPayload;
    try {
      const parsed  = JSON.parse(researchMatch[0]);
      const contact = parsed.contact ?? "";
      const isEmail = contact.includes("@");
      leadPayload = {
        name: parsed.name ?? "Visitor", email: isEmail ? contact : null,
        phone: isEmail ? null : (contact || null), notes: parsed.question ?? "", source: "agent", status: "new",
      };
    } catch {
      leadPayload = { name: "Visitor", notes: "Research request - marker unparsed. Raw: " + researchMatch[0].slice(0, 200), source: "agent", status: "new" };
    }
    ctx.waitUntil(
      supabasePost(env, "leads", leadPayload)
        .then(async () => {
          await sendSms(env,
            `FrontFrame research request\nName: ${leadPayload.name}\n` +
            `Contact: ${leadPayload.email ?? leadPayload.phone ?? "not provided"}\n` +
            `Question: ${leadPayload.notes?.slice(0, 120) ?? ""}`);
        })
        .catch((e) => console.error("research lead write failed:", e))
    );
  }

  // ── Session capture ──────────────────────────────────────────────────────
  if (config.capture_enabled && session_id) {
    const turn = [{ role: "user", content: message }, { role: "assistant", content: response }];
    ctx.waitUntil(captureSession(env, session_id, page, turn).catch((e) => console.error("session capture failed:", e)));
  }

  // ── Gap detection (testing mode only) ────────────────────────────────────
  if (config.mode === "testing" && response.includes(GAP_SIGNAL)) {
    ctx.waitUntil(supabasePost(env, "feedback", { question: message, ed_response: response })
      .catch((e) => console.error("feedback log failed:", e)));
  }

  // ── Post-response evaluator — single-call, fire-and-forget ──────────────
  if (session_id) {
    ctx.waitUntil((async () => {
      try {
        const flaggedTurn = { visitor_message: message, bot_response: response };
        const fullConv    = [...history, { role: "user", content: message }, { role: "assistant", content: response }];
        const convText    = fullConv.map((t, i) => {
          const label = t.role === "user" ? `[Visitor turn ${Math.floor(i / 2) + 1}]` : `[Bot turn ${Math.floor(i / 2) + 1}]`;
          return `${label}: ${t.content}`;
        }).join("\n\n");

        const evRes = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: "claude-haiku-4-5-20251001", max_tokens: 200,
            system: `You are a quality evaluator for FrontFrame, a web platform builder for small service businesses. Analyze the full conversation and return ONLY valid JSON with exactly these four fields:
- rephrasing_detected: boolean — true if the visitor asked materially the same question in different wording across multiple turns, signaling bot comprehension failure rather than a knowledge gap
- objection_count: integer — count of distinct visitor turns expressing resistance, skepticism, or a reason not to proceed (e.g. "too expensive", "we're already fine", "I don't think I need that")
- score: integer 1-10 — quality of the bot's most recent response for accuracy and completeness as a FrontFrame representative
- reasoning: string — one sentence explaining the score
No other text.`,
            messages: [{ role: "user", content: convText }],
          }),
        });
        if (!evRes.ok) return;
        const evText = (await evRes.json()).content?.[0]?.text ?? "";
        let ev;
        try { ev = JSON.parse(evText.replace(/```json|```/g, "").trim()); } catch { return; }

        const score         = parseInt(ev.score, 10);
        const objectionHigh = (ev.objection_count ?? 0) > 3;

        if (ev.rephrasing_detected) {
          await supabasePost(env, "review_queue", {
            session_id, flagged_turn: flaggedTurn, flag_source: "auto",
            auto_score: null,
            auto_reasoning: "Rephrasing pattern detected — visitor re-asked the same question in different wording, indicating bot comprehension failure.",
            status: "comprehension_failure",
          });
        } else if (objectionHigh) {
          await supabasePost(env, "review_queue", {
            session_id, flagged_turn: flaggedTurn, flag_source: "auto",
            auto_score: null, auto_reasoning: null, status: "dismissed",
          });
        } else if (!isNaN(score) && score <= 6) {
          await supabasePost(env, "review_queue", {
            session_id, flagged_turn: flaggedTurn, flag_source: "auto",
            auto_score: score, auto_reasoning: ev.reasoning ?? "", status: "candidate",
          });
        } else {
          await supabasePost(env, "review_queue", {
            session_id, flagged_turn: flaggedTurn, flag_source: "auto",
            auto_score: isNaN(score) ? null : score, auto_reasoning: ev.reasoning ?? "", status: "dismissed",
          });
        }
      } catch { /* evaluator errors never interrupt visitor response */ }
    })());
  }

  return jsonResponse({ response, mode: config.mode }, 200, corsHeaders);
}

async function captureSession(env, sessionId, page, newTurns) {
  const existing = await supabaseFetch(env, "chat_sessions",
    `?session_id=eq.${sessionId}&select=session_id,conversation`);
  if (!existing || existing.length === 0) {
    await supabasePost(env, "chat_sessions", { session_id: sessionId, page, conversation: newTurns });
  } else {
    const updated = [...(existing[0].conversation ?? []), ...newTurns];
    await supabasePatchByField(env, "chat_sessions", "session_id", sessionId,
      { conversation: updated, last_active_at: new Date().toISOString() });
  }
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: notify
// ════════════════════════════════════════════════════════════════════════════

async function handleNotify(request, env, ctx, corsHeaders) {
  const body = await request.json();
  const { session_id = null, name, contact, method, summary = "", source } = body;
  if (!name || !contact || !method || !source)
    return jsonResponse({ error: "name, contact, method, and source are required" }, 400, corsHeaders);

  const isEmail   = contact.includes("@");
  const leadPayload = {
    name, email: isEmail ? contact : null, phone: isEmail ? null : contact,
    notes: summary, source, status: "new",
  };

  let leadId = null;
  try {
    const leadRows = await supabasePost(env, "leads", leadPayload);
    leadId = leadRows?.[0]?.id ?? null;
  } catch (e) { console.error("notify lead write failed:", e); }

  const alertPayload = {
    session_id, page: source, prospect_name: name, trigger_reason: summary,
    current_site: null, status: "new", sms_sent: false, sms_status: null, lead_id: leadId,
  };

  const methodLabel = method === "phone" ? "Phone call" : method === "text" ? "Text" : "Email";
  const smsMessage  =
    `FrontFrame contact request\nName: ${name}\nReach by: ${methodLabel}\nContact: ${contact}\nSource: ${source}\n` +
    (summary ? `Summary: ${summary.slice(0, 200)}` : "");

  ctx.waitUntil(
    supabasePost(env, "lead_alerts", alertPayload)
      .then(async (alertRows) => {
        const alertId   = alertRows?.[0]?.alert_id ?? null;
        const smsResult = await sendSms(env, smsMessage);
        if (alertId) {
          await supabasePatchByField(env, "lead_alerts", "alert_id", alertId,
            { sms_sent: smsResult.success, sms_status: smsResult.status })
            .catch((e) => console.error("notify alert sms update failed:", e));
        }
      })
      .catch((e) => console.error("notify lead_alert write failed:", e))
  );

  return jsonResponse({ received: true }, 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: inquiry
// ════════════════════════════════════════════════════════════════════════════

async function verifyTurnstile(token, remoteIp, env) {
  if (!env.TURNSTILE_SECRET_KEY) return true; // not configured yet — don't hard-fail existing deploys
  if (!token) return false;
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token, ...(remoteIp ? { remoteip: remoteIp } : {}) }),
  });
  const data = await res.json().catch(() => ({ success: false }));
  return data.success === true;
}

async function handleInquiry(request, env, corsHeaders) {
  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "Invalid JSON" }, 400, corsHeaders); }

  const { owner_name, business_name, email, phone, business_type, tier_interest,
          description, services, clients, anything_else, source_page, turnstileToken } = body;

  if (!owner_name || !business_name || !email)
    return jsonResponse({ error: "owner_name, business_name, and email are required" }, 400, corsHeaders);

  const clientIp = request.headers.get("CF-Connecting-IP");
  const humanVerified = await verifyTurnstile(turnstileToken, clientIp, env).catch(() => false);
  if (!humanVerified)
    return jsonResponse({ error: "Verification failed. Please retry the checkbox above." }, 400, corsHeaders);

  const fullDescription = [
    description,
    services      ? `Services: ${services}`       : null,
    clients       ? `Clients: ${clients}`          : null,
    anything_else ? `Additional: ${anything_else}` : null,
  ].filter(Boolean).join("\n\n") || null;

  await supabasePost(env, "inquiries", {
    owner_name:    owner_name.trim(),
    business_name: business_name.trim(),
    email:         email.trim().toLowerCase(),
    phone:         phone?.trim() ?? null,
    business_type: business_type ?? null,
    tier_interest: tier_interest ?? "undecided",
    description:   fullDescription,
    source_page:   source_page ?? "added-intake",
    status:        "new",
  });

  return jsonResponse({ ok: true }, 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: scheduling (blackout dates + consultation bookings)
// ════════════════════════════════════════════════════════════════════════════

const CONSULT_SLOTS = ["9:00 AM MST", "10:00 AM MST", "11:00 AM MST", "1:00 PM MST", "2:00 PM MST", "3:00 PM MST"];

// Public — returns active/future blackout ranges so the client can grey out
// unavailable dates. Mirrors eleanor-website's /blackout endpoint.
async function getBlackout(env, corsHeaders) {
  const today  = new Date().toISOString().slice(0, 10);
  const rows   = await supabaseFetch(env, "blackout_periods",
    "?end_date=gte." + today + "&select=start_date,end_date,reason&order=start_date.asc");
  const periods = rows.map(r => ({ startDate: r.start_date, endDate: r.end_date, reason: r.reason ?? null }));
  return jsonResponse({ periods, slots: CONSULT_SLOTS }, 200, corsHeaders);
}

function dateInBlackout(dateStr, periods) {
  const d = new Date(dateStr + "T12:00:00");
  return periods.some(p => {
    const start = new Date(p.start_date + "T12:00:00");
    const end   = new Date(p.end_date   + "T12:00:00");
    return d >= start && d <= end;
  });
}

// Public — books a consultation/kickoff call. Validates the date against
// blackout periods and the requested slot against existing bookings
// server-side (never trust the client-side picker alone).
async function handleSchedule(request, env, corsHeaders) {
  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "Invalid JSON" }, 400, corsHeaders); }

  const { name, email, business_name, phone, requested_date, slot_label, notes, inquiry_id, turnstileToken } = body;

  if (!name || !email || !requested_date || !slot_label)
    return jsonResponse({ error: "name, email, requested_date, and slot_label are required" }, 400, corsHeaders);
  if (!CONSULT_SLOTS.includes(slot_label))
    return jsonResponse({ error: "Invalid time slot" }, 400, corsHeaders);

  const clientIp = request.headers.get("CF-Connecting-IP");
  const humanVerified = await verifyTurnstile(turnstileToken, clientIp, env).catch(() => false);
  if (!humanVerified)
    return jsonResponse({ error: "Verification failed. Please retry the checkbox above." }, 400, corsHeaders);

  const today = new Date().toISOString().slice(0, 10);
  if (requested_date < today)
    return jsonResponse({ error: "Please choose a date in the future." }, 400, corsHeaders);

  const blackoutRows = await supabaseFetch(env, "blackout_periods",
    "?end_date=gte." + today + "&select=start_date,end_date");
  if (dateInBlackout(requested_date, blackoutRows))
    return jsonResponse({ error: "That date isn't available. Please pick another." }, 409, corsHeaders);

  try {
    const rows = await supabasePost(env, "consultation_bookings", {
      name: name.trim(), email: email.trim().toLowerCase(),
      business_name: business_name?.trim() ?? null, phone: phone?.trim() ?? null,
      requested_date, slot_label, notes: notes?.trim() ?? null,
      inquiry_id: inquiry_id ?? null, status: "requested",
    });
    await sendSms(env, "FrontFrame call booked\n" + name.trim() + " -- " + requested_date + " @ " + slot_label)
      .catch((e) => console.error("booking SMS failed:", e));
    return jsonResponse({ ok: true, booking: rows?.[0] ?? null }, 200, corsHeaders);
  } catch (e) {
    if (String(e.message).includes("23505")) // unique violation on (requested_date, slot_label)
      return jsonResponse({ error: "That slot was just taken. Please pick another." }, 409, corsHeaders);
    throw e;
  }
}

// Admin — blackout period CRUD.
async function getBlackoutAdmin(env, corsHeaders) {
  return jsonResponse(await supabaseFetch(env, "blackout_periods",
    "?select=id,start_date,end_date,reason,created_at&order=start_date.asc"), 200, corsHeaders);
}

async function createBlackoutAdmin(request, env, corsHeaders) {
  const { start_date, end_date, reason } = await request.json();
  if (!start_date || !end_date) return jsonResponse({ error: "start_date and end_date are required" }, 400, corsHeaders);
  return jsonResponse(await supabasePost(env, "blackout_periods", { start_date, end_date, reason: reason ?? null }), 201, corsHeaders);
}

async function deleteBlackoutAdmin(env, id, corsHeaders) {
  await supabaseDelete(env, "blackout_periods", id);
  return jsonResponse({ ok: true }, 200, corsHeaders);
}

// Admin — view/manage consultation bookings.
async function getBookingsAdmin(env, corsHeaders) {
  return jsonResponse(await supabaseFetch(env, "consultation_bookings",
    "?select=id,name,email,business_name,phone,requested_date,slot_label,notes,status,inquiry_id,created_at&order=requested_date.asc"), 200, corsHeaders);
}

async function updateBookingAdmin(request, env, id, corsHeaders) {
  const body = await request.json();
  const updates = {};
  ["status", "notes"].forEach(k => { if (body[k] !== undefined) updates[k] = body[k]; });
  if (!Object.keys(updates).length) return jsonResponse({ error: "No fields to update" }, 400, corsHeaders);
  return jsonResponse(await supabasePatch(env, "consultation_bookings", id, updates), 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: qa
// ════════════════════════════════════════════════════════════════════════════

async function getQaPairs(env, corsHeaders) {
  return jsonResponse(await supabaseFetch(env, "qa_pairs",
    "?select=id,question,answer,page,status,source,created_at&order=created_at.asc"), 200, corsHeaders);
}

async function createQaPair(request, env, corsHeaders) {
  const { question, answer, page = "all" } = await request.json();
  if (!question || !answer) return jsonResponse({ error: "question and answer are required" }, 400, corsHeaders);
  return jsonResponse(await supabasePost(env, "qa_pairs", { question, answer, page }), 201, corsHeaders);
}

async function updateQaPair(request, env, id, corsHeaders) {
  const body = await request.json();
  const updates = {};
  ["question","answer","page","status"].forEach(k => { if (body[k] !== undefined) updates[k] = body[k]; });
  if (!Object.keys(updates).length) return jsonResponse({ error: "No fields to update" }, 400, corsHeaders);
  return jsonResponse(await supabasePatch(env, "qa_pairs", id, updates), 200, corsHeaders);
}

async function deleteQaPair(env, id, corsHeaders) {
  await supabaseDelete(env, "qa_pairs", id);
  return jsonResponse({ deleted: id }, 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: proposal
// ════════════════════════════════════════════════════════════════════════════

async function getProposal(request, env, corsHeaders) {
  const token = new URL(request.url).searchParams.get("token");
  if (!token) return jsonResponse({ error: "token is required" }, 400, corsHeaders);

  const accessRows = await supabaseFetch(env, "proposal_access",
    `?token=eq.${encodeURIComponent(token)}&select=access_id,proposal_id,expires_at,accessed_at`);
  if (!accessRows?.length) return jsonResponse({ error: "Invalid or expired link" }, 404, corsHeaders);

  const access = accessRows[0];
  if (access.expires_at && new Date(access.expires_at) < new Date())
    return jsonResponse({ error: "This link has expired" }, 410, corsHeaders);

  if (!access.accessed_at) {
    const ip = request.headers.get("CF-Connecting-IP") ?? "";
    supabasePatchByField(env, "proposal_access", "access_id", access.access_id,
      { accessed_at: new Date().toISOString(), ip_hash: ip ? await hashIp(ip) : null })
      .catch((e) => console.error("proposal_access stamp failed:", e));
  }

  const proposalRows = await supabaseFetch(env, "proposals",
    `?proposal_id=eq.${access.proposal_id}&select=proposal_id,prospect_name,status,version`);
  if (!proposalRows?.length) return jsonResponse({ error: "Proposal not found" }, 404, corsHeaders);

  const proposal = proposalRows[0];
  const sections = await supabaseFetch(env, "proposal_sections",
    `?proposal_id=eq.${access.proposal_id}&client_visible=eq.true&select=section_id,sort_order,title,content&order=sort_order.asc`);

  return jsonResponse({
    proposal_id: proposal.proposal_id, prospect_name: proposal.prospect_name,
    status: proposal.status, version: proposal.version, sections: sections ?? [],
  }, 200, corsHeaders);
}

async function submitProposalReview(request, env, ctx, corsHeaders) {
  const body = await request.json();
  const { token, proposal_id, overall_status, overall_comment = "", section_responses = [] } = body;
  if (!token || !proposal_id) return jsonResponse({ error: "token and proposal_id are required" }, 400, corsHeaders);

  const accessRows = await supabaseFetch(env, "proposal_access",
    `?token=eq.${encodeURIComponent(token)}&proposal_id=eq.${proposal_id}&select=access_id,expires_at`);
  if (!accessRows?.length) return jsonResponse({ error: "Invalid token" }, 403, corsHeaders);
  if (accessRows[0].expires_at && new Date(accessRows[0].expires_at) < new Date())
    return jsonResponse({ error: "This link has expired" }, 410, corsHeaders);

  await Promise.all(section_responses.map((s) =>
    supabasePatchByField(env, "proposal_sections", "section_id", s.section_id,
      { client_comment: s.comment ?? null, flagged: s.flagged ?? false })
      .catch((e) => console.error(`section patch failed for ${s.section_id}:`, e))
  ));
  await supabasePatchByField(env, "proposals", "proposal_id", proposal_id,
    { status: "under_review", reviewed_at: new Date().toISOString() });

  const proposalRows  = await supabaseFetch(env, "proposals", `?proposal_id=eq.${proposal_id}&select=prospect_name,version`);
  const proposal      = proposalRows?.[0] ?? { prospect_name: "Prospect", version: 1 };
  const flaggedCount  = section_responses.filter((s) => s.flagged).length;
  const statusLabels  = { ready: "Ready to move forward", questions: "Has questions", changes: "Requesting changes" };

  const smsMessage =
    `FrontFrame proposal review\nProspect: ${proposal.prospect_name}\nVersion: ${proposal.version}\n` +
    `Status: ${statusLabels[overall_status] ?? overall_status}\n` +
    (flaggedCount > 0 ? `Flagged sections: ${flaggedCount}\n` : "") +
    (overall_comment ? `Note: "${overall_comment.slice(0, 80)}${overall_comment.length > 80 ? "..." : ""}"` : "");

  ctx.waitUntil(sendSms(env, smsMessage).catch((e) => console.error("proposal review SMS failed:", e)));
  return jsonResponse({ received: true }, 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: podcast-episodes
// ════════════════════════════════════════════════════════════════════════════

async function getPodcastEpisodes(env, corsHeaders) {
  return jsonResponse(await supabaseFetch(env, "podcast_episodes",
    "?visible=eq.true&select=id,series,title,transcript,audio_path,published_at&order=published_at.desc"), 200, corsHeaders);
}

async function adminGetPodcastEpisodes(env, userJwt, corsHeaders) {
  return jsonResponse(await supabaseFetch(env, "podcast_episodes", "?select=*&order=published_at.desc", userJwt), 200, corsHeaders);
}

async function createPodcastEpisode(request, env, userJwt, corsHeaders) {
  const { series, title, transcript, audio_path, published_at, visible = true } = await request.json();
  if (!series || !title) return jsonResponse({ error: "series and title are required" }, 400, corsHeaders);
  return jsonResponse(await supabasePost(env, "podcast_episodes", {
    series, title, transcript: transcript ?? null, audio_path: audio_path ?? null,
    published_at: published_at ?? new Date().toISOString().split("T")[0], visible,
  }, userJwt), 201, corsHeaders);
}

async function updatePodcastEpisode(request, env, id, userJwt, corsHeaders) {
  const body = await request.json();
  const updates = {};
  ["series","title","transcript","audio_path","published_at","visible"].forEach(k => { if (body[k] !== undefined) updates[k] = body[k]; });
  if (!Object.keys(updates).length) return jsonResponse({ error: "No valid fields to update" }, 400, corsHeaders);
  return jsonResponse(await supabasePatch(env, "podcast_episodes", id, updates, userJwt), 200, corsHeaders);
}

async function deletePodcastEpisode(env, id, userJwt, corsHeaders) {
  await supabaseDelete(env, "podcast_episodes", id);
  return jsonResponse({ deleted: id }, 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: rss-proxy
// ════════════════════════════════════════════════════════════════════════════

async function handleRssProxy(request, corsHeaders) {
  const targetUrl = new URL(request.url).searchParams.get("url");
  if (!targetUrl) return jsonResponse({ error: "url parameter required" }, 400, corsHeaders);

  let parsed;
  try { parsed = new URL(targetUrl); }
  catch { return jsonResponse({ error: "Invalid URL" }, 400, corsHeaders); }

  if (!["http:", "https:"].includes(parsed.protocol))
    return jsonResponse({ error: "Only http/https URLs allowed" }, 400, corsHeaders);

  try {
    const res = await fetch(targetUrl, {
      headers: {
        "User-Agent": "FrontFrame Advisor Intel/1.0 (RSS reader; +https://frontframe.co)",
        "Accept":     "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return new Response(`Upstream error: ${res.status}`, { status: res.status, headers: corsHeaders });
    return new Response(await res.text(), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "text/xml; charset=utf-8", "Cache-Control": "public, max-age=900" },
    });
  } catch (err) {
    console.warn("rss-proxy fetch failed:", targetUrl, err.message);
    return new Response(`Fetch failed: ${err.message}`, { status: 502, headers: corsHeaders });
  }
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: config
// ════════════════════════════════════════════════════════════════════════════

async function getConfig(env, userJwt, corsHeaders) {
  return jsonResponse((await supabaseFetch(env, "config", "?id=eq.1&select=*", userJwt))?.[0] ?? {}, 200, corsHeaders);
}

async function updateConfig(request, env, userJwt, corsHeaders) {
  const body = await request.json();
  const updates = {};
  ["mode","build_version","stage_gate","capture_enabled"].forEach(k => { if (body[k] !== undefined) updates[k] = body[k]; });
  if (!Object.keys(updates).length) return jsonResponse({ error: "No valid fields to update" }, 400, corsHeaders);
  updates.updated_at = new Date().toISOString();
  return jsonResponse(await supabaseUpsert(env, "config", { id: 1, ...updates }, userJwt), 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: defects
// ════════════════════════════════════════════════════════════════════════════

async function getDefects(env, userJwt, corsHeaders) {
  return jsonResponse(await supabaseFetch(env, "defects", "?select=*&order=created_at.desc", userJwt), 200, corsHeaders);
}

async function createDefect(request, env, userJwt, corsHeaders) {
  const { area, description, severity, disposition = "retain" } = await request.json();
  if (!area || !description || !severity)
    return jsonResponse({ error: "area, description, and severity are required" }, 400, corsHeaders);
  const config = (await supabaseFetch(env, "config", "?id=eq.1&select=build_version,stage_gate"))?.[0] ?? {};
  return jsonResponse(await supabasePost(env, "defects", {
    area, description, severity, disposition,
    build_version: config.build_version ?? "unknown", stage_gate: config.stage_gate ?? "build",
  }, userJwt), 201, corsHeaders);
}

async function updateDefect(request, env, id, userJwt, corsHeaders) {
  const body = await request.json();
  const updates = {};
  ["status","resolver_id","severity","disposition","description","area"].forEach(k => { if (body[k] !== undefined) updates[k] = body[k]; });
  if (!Object.keys(updates).length) return jsonResponse({ error: "No valid fields to update" }, 400, corsHeaders);
  return jsonResponse(await supabasePatch(env, "defects", id, updates, userJwt), 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: feedback
// ════════════════════════════════════════════════════════════════════════════

async function getFeedback(env, userJwt, corsHeaders) {
  return jsonResponse(await supabaseFetch(env, "feedback", "?select=*&order=created_at.desc", userJwt), 200, corsHeaders);
}

async function createFeedback(request, env, userJwt, corsHeaders) {
  const { question, ed_response, suggested_answer } = await request.json();
  if (!question) return jsonResponse({ error: "question is required" }, 400, corsHeaders);
  return jsonResponse(await supabasePost(env, "feedback", { question, ed_response, suggested_answer }, userJwt), 201, corsHeaders);
}

async function updateFeedback(request, env, id, userJwt, corsHeaders) {
  const body = await request.json();
  if (body.action === "promote") {
    const entry = (await supabaseFetch(env, "feedback", `?id=eq.${id}&select=question,suggested_answer,ed_response`, userJwt))?.[0];
    if (!entry) return jsonResponse({ error: "Not found" }, 404, corsHeaders);
    const answer = entry.suggested_answer || entry.ed_response || "";
    if (!answer) return jsonResponse({ error: "No answer to promote" }, 400, corsHeaders);
    const page = body.page || "all";
    await supabasePost(env, "qa_pairs", { question: entry.question, answer, page, source: "testing" }, userJwt);
    return jsonResponse(await supabasePatch(env, "feedback", id, { promoted: true }, userJwt), 200, corsHeaders);
  }
  if (body.action === "dismiss")
    return jsonResponse(await supabasePatch(env, "feedback", id, { suggested_answer: body.note || "[dismissed]" }, userJwt), 200, corsHeaders);

  const updates = {};
  ["suggested_answer","promoted"].forEach(k => { if (body[k] !== undefined) updates[k] = body[k]; });
  if (!Object.keys(updates).length) return jsonResponse({ error: "No valid fields to update" }, 400, corsHeaders);
  return jsonResponse(await supabasePatch(env, "feedback", id, updates, userJwt), 200, corsHeaders);
}

async function checkFeedbackConflicts(request, env, userJwt, corsHeaders) {
  if (!userJwt) return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
  const { question, answer, page = "all" } = await request.json();
  if (!question || !answer) return jsonResponse({ error: "question and answer are required" }, 400, corsHeaders);

  const pagePromptRows = await supabaseFetch(env, "system_prompt", `?page=eq.${page}&select=content`, userJwt);
  const pagePrompt     = pagePromptRows?.[0]?.content || "";

  let globalPrompt = "";
  if (page !== "all") {
    const globalRows = await supabaseFetch(env, "system_prompt", `?page=eq.all&select=content`, userJwt);
    globalPrompt = globalRows?.[0]?.content || "";
  }

  const systemPromptContent = [globalPrompt, pagePrompt].filter(Boolean).join("\n\n") || "(none)";
  const pairsQuery = page === "all" ? `?page=eq.all&select=question,answer` : `?or=(page.eq.all,page.eq.${page})&select=question,answer`;
  const pairs      = await supabaseFetch(env, "qa_pairs", pairsQuery, userJwt) || [];
  const pagesChecked   = page === "all" ? ["all"] : ["all", page];
  const pairsText  = pairs.length ? pairs.map(p => `Q: ${p.question}\nA: ${p.answer}`).join("\n\n") : "(none)";
  const userMessage =
    `SYSTEM PROMPT FOR PAGE "${page}":\n${systemPromptContent}\n\n` +
    `EXISTING Q&A PAIRS (${pairs.length}):\n${pairsText}\n\n` +
    `PROPOSED NEW PAIR:\nQ: ${question}\nA: ${answer}\n\nCheck for conflicts.`;

  const fallback = { conflict: false, severity: "none", summary: "Check could not be completed.", details: [] };
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001", max_tokens: 400,
        system: `You are a quality reviewer for an AI assistant knowledge base. You check whether a proposed Q&A pair conflicts with existing instructions or established Q&A pairs for the same assistant.\n\nA conflict exists if:\n- The proposed answer directly contradicts something in the system prompt\n- The proposed answer contradicts an existing Q&A pair covering the same topic\n- The proposed answer introduces a policy, price, claim, or commitment that contradicts existing content\n\nRespond with valid JSON only:\n{\n  "conflict": true | false,\n  "severity": "blocking" | "minor" | "none",\n  "summary": "one sentence",\n  "details": ["specific conflict 1", "specific conflict 2"]\n}\nNo other text.`,
        messages: [{ role: "user", content: userMessage }],
      }),
    });
    if (!res.ok) return jsonResponse({ ...fallback, pairs_checked: pairs.length, pages_checked: pagesChecked }, 200, corsHeaders);
    const text = (await res.json()).content?.[0]?.text ?? "";
    let parsed;
    try { parsed = JSON.parse(text.replace(/```json|```/g, "").trim()); } catch { parsed = fallback; }
    return jsonResponse({ ...parsed, pairs_checked: pairs.length, pages_checked: pagesChecked }, 200, corsHeaders);
  } catch {
    return jsonResponse({ ...fallback, pairs_checked: pairs.length, pages_checked: pagesChecked }, 200, corsHeaders);
  }
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: changelog
// ════════════════════════════════════════════════════════════════════════════

async function getChangelog(env, userJwt, corsHeaders) {
  return jsonResponse(await supabaseFetch(env, "changelog", "?select=*&order=created_at.desc", userJwt), 200, corsHeaders);
}

async function createChangelog(request, env, userJwt, corsHeaders) {
  const { event_type, summary, disposition = "retain", build_version } = await request.json();
  if (!event_type || !summary) return jsonResponse({ error: "event_type and summary are required" }, 400, corsHeaders);
  const cfg = (await supabaseFetch(env, "config", "?id=eq.1&select=build_version"))?.[0] ?? {};
  return jsonResponse(await supabasePost(env, "changelog", {
    event_type, summary, disposition, build_version: build_version || cfg.build_version || "unknown",
  }, userJwt), 201, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: leads
// ════════════════════════════════════════════════════════════════════════════

async function getLeads(env, userJwt, corsHeaders) {
  return jsonResponse(await supabaseFetch(env, "leads",
    "?select=id,name,email,phone,business_name,source,status,created_at&order=created_at.desc", userJwt), 200, corsHeaders);
}

async function createLead(request, env, userJwt, corsHeaders) {
  const { name, email, phone, business_name, notes, source = "pipeline", status = "new" } = await request.json();
  if (!name || !email) return jsonResponse({ error: "name and email are required" }, 400, corsHeaders);
  return jsonResponse(await supabasePost(env, "leads", {
    name, email, phone: phone ?? null, business_name: business_name ?? null,
    notes: notes ?? null, source, status,
  }, userJwt), 201, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: lead-alerts
// ════════════════════════════════════════════════════════════════════════════

async function getLeadAlerts(env, userJwt, corsHeaders) {
  return jsonResponse(await supabaseFetch(env, "lead_alerts",
    "?select=alert_id,lead_id,prospect_name,trigger_reason,page,current_site,sms_sent,sms_status,status,session_id,triggered_at&order=triggered_at.desc",
    userJwt), 200, corsHeaders);
}

async function updateLeadAlert(request, env, id, userJwt, corsHeaders) {
  const body = await request.json();
  const updates = {};
  ["status","prospect_name","trigger_reason","current_site","lead_id"].forEach(k => { if (body[k] !== undefined) updates[k] = body[k]; });
  if (!Object.keys(updates).length) return jsonResponse({ error: "No valid fields to update" }, 400, corsHeaders);
  return jsonResponse(await supabasePatchByField(env, "lead_alerts", "alert_id", id, updates), 200, corsHeaders);
}

async function deleteLeadAlert(env, id, userJwt, corsHeaders) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/lead_alerts?alert_id=eq.${encodeURIComponent(id)}`,
    { method: "DELETE", headers: supabaseHeaders(env) });
  if (!res.ok) throw new Error(`Supabase DELETE lead_alerts failed: ${await res.text()}`);
  return jsonResponse({ deleted: id }, 200, corsHeaders);
}

async function getAlertSession(env, alertId, userJwt, corsHeaders) {
  const alertRows = await supabaseFetch(env, "lead_alerts",
    `?alert_id=eq.${encodeURIComponent(alertId)}&select=session_id,prospect_name`, userJwt);
  if (!alertRows?.length) return jsonResponse({ error: "Alert not found" }, 404, corsHeaders);
  const sessionId = alertRows[0].session_id;
  if (!sessionId) return jsonResponse({ conversation: null, reason: "no_session" }, 200, corsHeaders);
  const sessionRows = await supabaseFetch(env, "chat_sessions",
    `?session_id=eq.${encodeURIComponent(sessionId)}&select=conversation,page,started_at,last_active_at`, userJwt);
  if (!sessionRows?.length) return jsonResponse({ conversation: null, reason: "session_not_found" }, 200, corsHeaders);
  return jsonResponse(sessionRows[0], 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: agreements
// ════════════════════════════════════════════════════════════════════════════

async function getAgreements(env, userJwt, corsHeaders) {
  return jsonResponse(await supabaseFetch(env, "agreements", "?select=*&order=sent_at.desc", userJwt), 200, corsHeaders);
}

async function updateAgreement(request, env, id, userJwt, corsHeaders) {
  const body = await request.json();
  const updates = {};
  ["client_called_at","status","document_url"].forEach(k => { if (body[k] !== undefined) updates[k] = body[k]; });
  if (!Object.keys(updates).length) return jsonResponse({ error: "No valid fields to update" }, 400, corsHeaders);
  return jsonResponse(await supabasePatch(env, "agreements", id, updates, userJwt), 200, corsHeaders);
}

async function sendAgreement(request, env, userJwt, corsHeaders) {
  const { order_id } = await request.json();
  if (!order_id) return jsonResponse({ error: "order_id is required" }, 400, corsHeaders);
  const orderRows = await supabaseFetch(env, "orders", `?id=eq.${order_id}&select=id,tier,lead_id`);
  if (!orderRows?.length) return jsonResponse({ error: "Order not found" }, 404, corsHeaders);
  const order    = orderRows[0];
  const leadRows = await supabaseFetch(env, "leads", `?id=eq.${order.lead_id}&select=name,email,business_name`);
  const lead     = leadRows?.[0] ?? {};
  const today    = new Date().toISOString().split("T")[0];
  const signatureUrl = env.DOCUSEAL_SIGNATURE_URL ?? "";
  const submissionPayload = {
    template_id: 3600228, send_email: true,
    submitters: [
      { role: "First Party", email: lead.email ?? "",
        fields: [
          { name: "Client Name",          default_value: lead.name          ?? "", readonly: true },
          { name: "Business Name",        default_value: lead.business_name ?? "", readonly: true },
          { name: "Client Email Address", default_value: lead.email         ?? "", readonly: true },
          { name: "Date Field 1",         default_value: today,                   readonly: true },
        ] },
      { role: "Second Party", email: "ed@frontframe.co", completed: true,
        fields: [
          { name: "FrontFrame Date",      default_value: today,        readonly: true },
          { name: "FrontFrame Signature", default_value: signatureUrl, readonly: true },
        ] },
    ],
  };
  const dsRes = await fetch("https://api.docuseal.com/submissions", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Auth-Token": env.DOCUSEAL_API_KEY },
    body: JSON.stringify(submissionPayload),
  });
  if (!dsRes.ok) throw new Error(`DocuSeal submission failed: ${await dsRes.text()}`);
  const dsData     = await dsRes.json();
  const envelopeId = String(dsData?.[0]?.submission_id ?? dsData?.id ?? "");
  const agreement  = await supabasePost(env, "agreements", { order_id, docuseal_envelope_id: envelopeId, status: "sent", sent_at: new Date().toISOString() });
  return jsonResponse({ sent: true, envelope_id: envelopeId, agreement }, 201, corsHeaders);
}

async function sendDueDiligence(request, env, userJwt, corsHeaders) {
  const { lead_id } = await request.json();
  if (!lead_id) return jsonResponse({ error: "lead_id is required" }, 400, corsHeaders);
  const leadRows = await supabaseFetch(env, "leads", `?id=eq.${lead_id}&select=id,name,email,business_name`);
  if (!leadRows?.length) return jsonResponse({ error: "Lead not found" }, 404, corsHeaders);
  const lead         = leadRows[0];
  const today        = new Date().toISOString().split("T")[0];
  const signatureUrl = env.DOCUSEAL_SIGNATURE_URL ?? "";
  const submissionPayload = {
    template_id: 3703869, send_email: true,
    submitters: [
      { role: "Second Party", email: lead.email ?? "",
        fields: [
          { name: "Client_Name",   default_value: lead.name          ?? "", readonly: true },
          { name: "Business_Name", default_value: lead.business_name ?? "", readonly: true },
          { name: "Client_email",  default_value: lead.email         ?? "", readonly: true },
          { name: "Contract_date", default_value: today,                   readonly: true },
        ] },
      { role: "FrontFrame", email: "ed@frontframe.co", completed: true,
        fields: [{ name: "FrontFrame_Signature", default_value: signatureUrl, readonly: true }] },
    ],
  };
  const dsRes = await fetch("https://api.docuseal.com/submissions", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Auth-Token": env.DOCUSEAL_API_KEY },
    body: JSON.stringify(submissionPayload),
  });
  if (!dsRes.ok) throw new Error(`DocuSeal submission failed: ${await dsRes.text()}`);
  const dsData     = await dsRes.json();
  const envelopeId = String(dsData?.[0]?.submission_id ?? dsData?.id ?? "");
  const agreement  = await supabasePost(env, "agreements", { lead_id, docuseal_envelope_id: envelopeId, status: "sent", sent_at: new Date().toISOString() });
  return jsonResponse({ sent: true, envelope_id: envelopeId, agreement }, 201, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: system-prompt
// ════════════════════════════════════════════════════════════════════════════

async function getSystemPrompt(env, page, userJwt, corsHeaders) {
  const validPages = ["home","intake","discovery","yours","admin","proposal","resources"];
  if (!validPages.includes(page))
    return jsonResponse({ error: `Invalid page. Must be one of: ${validPages.join(", ")}` }, 400, corsHeaders);
  const rows = await supabaseFetch(env, "system_prompt", `?page=eq.${encodeURIComponent(page)}&select=page,content`, userJwt);
  if (!rows?.length) return jsonResponse({ page, content: null }, 200, corsHeaders);
  return jsonResponse(rows[0], 200, corsHeaders);
}

async function updateSystemPrompt(request, env, page, userJwt, corsHeaders) {
  const validPages = ["home","intake","discovery","yours","admin","proposal","resources"];
  if (!validPages.includes(page))
    return jsonResponse({ error: `Invalid page. Must be one of: ${validPages.join(", ")}` }, 400, corsHeaders);
  const { content } = await request.json();
  if (!content) return jsonResponse({ error: "content is required" }, 400, corsHeaders);
  return jsonResponse(await supabaseUpsert(env, "system_prompt", { page, content, updated_at: new Date().toISOString() }, userJwt), 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: reviewers
// ════════════════════════════════════════════════════════════════════════════

async function getReviewers(env, userJwt, corsHeaders) {
  return jsonResponse(await supabaseFetch(env, "reviewers",
    "?select=id,email,display_name,role,engagement_id,invited_at,active,dev_access&order=invited_at.asc", userJwt), 200, corsHeaders);
}

async function inviteReviewer(request, env, userJwt, corsHeaders) {
  const { email, display_name, role, engagement_id } = await request.json();
  if (!email || !display_name || !role)
    return jsonResponse({ error: "email, display_name, and role are required" }, 400, corsHeaders);
  const validRoles = ["frontframe_admin","frontframe_staff","contractor","client_tester","client_owner"];
  if (!validRoles.includes(role))
    return jsonResponse({ error: `role must be one of: ${validRoles.join(", ")}` }, 400, corsHeaders);
  const inviteRes = await fetch(`${env.SUPABASE_URL}/auth/v1/invite`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": env.SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ email }),
  });
  if (!inviteRes.ok) throw new Error(`Supabase invite failed: ${await inviteRes.text()}`);
  const inviteData = await inviteRes.json();
  if (!inviteData.id) return jsonResponse({ error: "Invite sent but no user ID returned" }, 500, corsHeaders);
  const reviewer = await supabasePost(env, "reviewers", { id: inviteData.id, email, display_name, role, engagement_id: engagement_id ?? null });
  return jsonResponse({ invited: email, reviewer }, 201, corsHeaders);
}

async function resetReviewerPassword(request, env, userJwt, corsHeaders) {
  const { email } = await request.json();
  if (!email) return jsonResponse({ error: "email is required" }, 400, corsHeaders);
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/recover`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": env.SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) throw new Error(`Password reset failed: ${await res.text()}`);
  return jsonResponse({ sent: true }, 200, corsHeaders);
}

async function updateReviewer(request, env, id, userJwt, corsHeaders) {
  const body = await request.json();
  const updates = {};
  ["display_name","email","dev_access"].forEach(k => { if (body[k] !== undefined) updates[k] = body[k]; });
  if (!Object.keys(updates).length) return jsonResponse({ error: "No valid fields to update" }, 400, corsHeaders);
  return jsonResponse(await supabasePatch(env, "reviewers", id, updates, userJwt), 200, corsHeaders);
}

async function deleteReviewer(env, id, userJwt, corsHeaders) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/reviewers?id=eq.${encodeURIComponent(id)}`,
    { method: "DELETE", headers: supabaseHeaders(env) });
  if (!res.ok) throw new Error(`Supabase DELETE reviewers failed: ${await res.text()}`);
  return jsonResponse({ deleted: id }, 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: marketing-log
// ════════════════════════════════════════════════════════════════════════════

async function getMarketingLog(request, env, userJwt, corsHeaders) {
  const platform = new URL(request.url).searchParams.get("platform");
  let query = "?select=*&order=log_date.desc,created_at.desc";
  if (platform) query += `&platform=eq.${encodeURIComponent(platform)}`;
  return jsonResponse(await supabaseFetch(env, "marketing_log", query, userJwt), 200, corsHeaders);
}

async function createMarketingLog(request, env, userJwt, corsHeaders) {
  const { platform, question, answer, action_committed } = await request.json();
  if (!platform || !question) return jsonResponse({ error: "platform and question are required" }, 400, corsHeaders);
  return jsonResponse(await supabasePost(env, "marketing_log", {
    platform, question, answer: answer ?? null, action_committed: action_committed ?? null,
  }, userJwt), 201, corsHeaders);
}

async function updateMarketingLog(request, env, id, userJwt, corsHeaders) {
  const body = await request.json();
  const updates = {};
  ["notes","action_committed","answer"].forEach(k => { if (body[k] !== undefined) updates[k] = body[k]; });
  if (!Object.keys(updates).length) return jsonResponse({ error: "No valid fields to update" }, 400, corsHeaders);
  return jsonResponse(await supabasePatch(env, "marketing_log", id, updates, userJwt), 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: problem-statements
// ════════════════════════════════════════════════════════════════════════════

async function getProblemStatements(env, userJwt, corsHeaders) {
  return jsonResponse(await supabaseFetch(env, "problem_statements", "?select=*&order=created_at.asc", userJwt), 200, corsHeaders);
}

async function createProblemStatement(request, env, userJwt, corsHeaders) {
  const { title, description, ideal_outcome } = await request.json();
  if (!title || !description || !ideal_outcome)
    return jsonResponse({ error: "title, description, and ideal_outcome are required" }, 400, corsHeaders);
  return jsonResponse(await supabasePost(env, "problem_statements", { title, description, ideal_outcome }, userJwt), 201, corsHeaders);
}

async function updateProblemStatement(request, env, id, userJwt, corsHeaders) {
  const body = await request.json();
  const updates = {};
  ["title","description","ideal_outcome","status"].forEach(k => { if (body[k] !== undefined) updates[k] = body[k]; });
  if (!Object.keys(updates).length) return jsonResponse({ error: "No valid fields to update" }, 400, corsHeaders);
  updates.updated_at = new Date().toISOString();
  return jsonResponse(await supabasePatch(env, "problem_statements", id, updates, userJwt), 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: deliverables
// ════════════════════════════════════════════════════════════════════════════

async function getDeliverables(request, env, userJwt, corsHeaders) {
  const problemId = new URL(request.url).searchParams.get("problem_id");
  const query = problemId
    ? `?problem_id=eq.${encodeURIComponent(problemId)}&select=*&order=session_date.desc,created_at.desc&limit=20`
    : "?select=*&order=session_date.desc,created_at.desc&limit=20";
  return jsonResponse(await supabaseFetch(env, "deliverables", query, userJwt), 200, corsHeaders);
}

async function createDeliverable(request, env, userJwt, corsHeaders) {
  const { problem_id, challenge, response, action_committed } = await request.json();
  if (!problem_id || !challenge) return jsonResponse({ error: "problem_id and challenge are required" }, 400, corsHeaders);
  return jsonResponse(await supabasePost(env, "deliverables", {
    problem_id, challenge, response: response ?? null, action_committed: action_committed ?? null,
  }, userJwt), 201, corsHeaders);
}

async function updateDeliverable(request, env, id, userJwt, corsHeaders) {
  const body = await request.json();
  const updates = {};
  ["observation","action_committed","response"].forEach(k => { if (body[k] !== undefined) updates[k] = body[k]; });
  if (!Object.keys(updates).length) return jsonResponse({ error: "No valid fields to update" }, 400, corsHeaders);
  return jsonResponse(await supabasePatch(env, "deliverables", id, updates, userJwt), 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: subscriptions
// ════════════════════════════════════════════════════════════════════════════

async function getSubscriptions(env, userJwt, corsHeaders) {
  return jsonResponse(await supabaseFetch(env, "subscriptions", "?select=*&order=created_at.asc", userJwt), 200, corsHeaders);
}

async function createSubscription(request, env, userJwt, corsHeaders) {
  const body = await request.json();
  const { platform, provisioned_by = "frontframe", account_email, account_identifier,
    legal_business_name, ein, address, contact_name, phone, website,
    campaign_type, use_case_description, sample_message, estimated_monthly_volume,
    opt_in_method, opt_in_form_url, privacy_policy_url, approved_number,
    plan, billing_method, provisioned_at, notes } = body;
  if (!platform) return jsonResponse({ error: "platform is required" }, 400, corsHeaders);
  return jsonResponse(await supabasePost(env, "subscriptions", {
    platform, provisioned_by, account_email: account_email ?? null, account_identifier: account_identifier ?? null,
    legal_business_name: legal_business_name ?? null, ein: ein ?? null, address: address ?? null,
    contact_name: contact_name ?? null, phone: phone ?? null, website: website ?? null,
    campaign_type: campaign_type ?? null, use_case_description: use_case_description ?? null,
    sample_message: sample_message ?? null, estimated_monthly_volume: estimated_monthly_volume ?? null,
    opt_in_method: opt_in_method ?? null, opt_in_form_url: opt_in_form_url ?? null,
    privacy_policy_url: privacy_policy_url ?? null, approved_number: approved_number ?? null,
    plan: plan ?? null, billing_method: billing_method ?? null, provisioned_at: provisioned_at ?? null, notes: notes ?? null,
  }, userJwt), 201, corsHeaders);
}

async function updateSubscription(request, env, id, userJwt, corsHeaders) {
  const body = await request.json();
  const updates = {};
  ["status","provisioned_by","account_email","account_identifier","legal_business_name","ein","address","contact_name","phone","website",
   "campaign_type","use_case_description","sample_message","estimated_monthly_volume","opt_in_method","opt_in_form_url","privacy_policy_url",
   "approved_number","plan","billing_method","provisioned_at","notes"].forEach(k => { if (body[k] !== undefined) updates[k] = body[k]; });
  if (!Object.keys(updates).length) return jsonResponse({ error: "No valid fields to update" }, 400, corsHeaders);
  return jsonResponse(await supabasePatch(env, "subscriptions", id, updates, userJwt), 200, corsHeaders);
}

async function sendSubscription(env, id, userJwt, corsHeaders) {
  const rows = await supabaseFetch(env, "subscriptions", `?id=eq.${id}&select=*`, userJwt);
  if (!rows?.length) return jsonResponse({ error: "Subscription not found" }, 404, corsHeaders);
  const sub = rows[0];
  await supabasePatch(env, "subscriptions", id, { status: "submitted", submitted_at: new Date().toISOString() }, userJwt);
  await sendSms(env,
    `FrontFrame subscription setup\nPlatform: ${sub.platform}\nProvisioned by: ${sub.provisioned_by}\n` +
    (sub.approved_number ? `Number: ${sub.approved_number}\n` : "") +
    (sub.plan            ? `Plan: ${sub.plan}\n`              : "") +
    (sub.account_email   ? `Email: ${sub.account_email}\n`    : "") +
    (sub.notes           ? `Notes: ${sub.notes.slice(0, 100)}` : "")
  ).catch((e) => console.error("subscription SMS failed:", e));
  return jsonResponse({ sent: true }, 200, corsHeaders);
}

// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: payments
// ════════════════════════════════════════════════════════════════════════════

async function createCheckoutSession(request, env, userJwt, corsHeaders) {
  const { price_id, lead_id, price_label, success_url, cancel_url } = await request.json();
  if (!price_id || !success_url) return jsonResponse({ error: "price_id and success_url are required" }, 400, corsHeaders);
  const params = new URLSearchParams();
  params.append("mode", "payment");
  params.append("line_items[0][price]", price_id);
  params.append("line_items[0][quantity]", "1");
  params.append("success_url", success_url);
  params.append("cancel_url", cancel_url ?? success_url);
  if (lead_id)     params.append("metadata[lead_id]", lead_id);
  if (price_label) params.append("metadata[price_label]", price_label);
  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) throw new Error(`Stripe checkout session failed: ${await res.text()}`);
  const s = await res.json();
  return jsonResponse({ url: s.url, session_id: s.id }, 201, corsHeaders);
}

async function handleSendPaymentRequest(request, env, userJwt, corsHeaders) {
  const { lead_id, agreement_id } = await request.json();
  if (!lead_id) return jsonResponse({ error: "lead_id is required" }, 400, corsHeaders);
  const leadRows = await supabaseFetch(env, "leads", `?id=eq.${lead_id}&select=id,name,email,business_name`);
  if (!leadRows?.length) return jsonResponse({ error: "Lead not found" }, 404, corsHeaders);
  const lead = leadRows[0];
  let agrId  = agreement_id;
  if (!agrId) {
    const agrRows = await supabaseFetch(env, "agreements", `?lead_id=eq.${lead_id}&status=eq.signed&order=sent_at.desc&limit=1`);
    if (!agrRows?.length) return jsonResponse({ error: "No signed agreement found for this lead" }, 404, corsHeaders);
    agrId = agrRows[0].id;
  }
  const params = new URLSearchParams();
  params.append("mode", "payment");
  params.append("line_items[0][price]", STRIPE_PRICE_IDS.due_diligence_deposit);
  params.append("line_items[0][quantity]", "1");
  params.append("success_url", `https://frontframe.co/start?lead=${lead_id}`);
  params.append("cancel_url", "https://frontframe.co");
  params.append("customer_email", lead.email ?? "");
  params.append("metadata[lead_id]", lead_id);
  params.append("metadata[price_label]", "Due Diligence Deposit");
  const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!stripeRes.ok) throw new Error(`Stripe checkout failed: ${await stripeRes.text()}`);
  const stripeSession = await stripeRes.json();
  const emailHtml = `<!DOCTYPE html><html><body style="font-family:Inter,system-ui,sans-serif;color:#1E2D40;max-width:560px;margin:0 auto;padding:40px 24px">
<div style="margin-bottom:32px"><strong style="font-size:1.1rem">FrontFrame</strong></div>
<p style="margin-bottom:16px">Hi ${lead.name},</p>
<p style="margin-bottom:16px">Thank you for signing the Due Diligence &amp; Engagement Framework.</p>
<p style="margin-bottom:16px">Your $500 Due Diligence Deposit secures your place and authorizes FrontFrame to begin research and prepare a Draft Site Recommendation. Work begins upon confirmation of cleared funds.</p>
<p style="margin:32px 0"><a href="${stripeSession.url}" style="background:#F5A623;color:#1E2D40;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">Pay $500 Deposit</a></p>
<p style="font-size:0.875rem;color:#8A9BAE">If you have questions, reply to this email and I will get back to you promptly.</p>
<hr style="border:none;border-top:1px solid #E8ECF0;margin:32px 0">
<p style="font-size:0.8rem;color:#8A9BAE">FrontFrame LLC - Phoenix, Arizona - frontframe.co</p>
</body></html>`;
  await sendResendEmail(env, lead.email, "FrontFrame Due Diligence Deposit - $500", emailHtml);
  await supabasePatch(env, "agreements", agrId, {
    payment_request_sent_at: new Date().toISOString(),
    stripe_session_id:       stripeSession.id,
  }).catch((e) => console.error("agreement payment_request update failed:", e));
  return jsonResponse({ sent: true, checkout_url: stripeSession.url }, 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: vault
// ════════════════════════════════════════════════════════════════════════════

// Encryption itself is handled entirely by Supabase's built-in Vault
// (the supabase_vault extension, vault.create_secret/vault.update_secret/
// vault.decrypted_secrets) via the vault_get_all_entries and
// vault_upsert_entry SECURITY DEFINER functions in the public schema.
// The Worker never sees or manages an encryption key — Supabase does,
// on its own infrastructure. See [[project-frontframe-vault]] memory /
// 2026-07-03 migration for why this replaced a prior hand-rolled
// AES-GCM + Cloudflare-secret scheme (that key was lost during a
// Cloudflare account migration and made every stored credential
// permanently unrecoverable).

async function handleAdminVaultGet(request, env, userJwt, corsHeaders) {
  let rows;
  try { rows = await supabaseRpc(env, "vault_get_all_entries"); }
  catch (e) { return jsonResponse({ error: e.message }, 500, corsHeaders); }
  const result = {};
  for (const row of rows) {
    let data = {};
    try { data = row.decrypted_data ? JSON.parse(row.decrypted_data) : {}; }
    catch { data = {}; }
    result[row.vendor] = {
      category:   row.category,
      data,
      updated_at: row.updated_at,
      updated_by: row.updated_by,
    };
  }
  return jsonResponse(result, 200, corsHeaders);
}

async function handleAdminVaultSet(request, env, userJwt, corsHeaders) {
  const { vendor, category, data } = await request.json().catch(() => ({}));
  if (!vendor || !data) return jsonResponse({ error: "vendor and data are required." }, 400, corsHeaders);
  try {
    await supabaseRpc(env, "vault_upsert_entry", {
      p_vendor:     vendor,
      p_category:   category ?? "platform",
      p_data:       JSON.stringify(data),
      p_updated_by: "ed@frontframe.co",
    });
  } catch (e) {
    console.error("Vault save error:", e.message);
    return jsonResponse({ error: "Failed to save vault entry.", detail: e.message }, 500, corsHeaders);
  }
  return jsonResponse({ saved: true }, 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: office-hours
// ════════════════════════════════════════════════════════════════════════════

async function getEffectiveHours(env, corsHeaders) {
  try {
    const today     = getPhoenixDateStr();
    const dayOfWeek = getPhoenixDayOfWeek();
    const overrides = await supabaseFetch(env, "office_hours_overrides",
      `?override_date=eq.${today}&select=open_time,close_time,is_closed,note`);
    if (overrides?.length)
      return jsonResponse({ source: "override", date: today, day_of_week: dayOfWeek, ...overrides[0] }, 200, corsHeaders);
    const schedule = await supabaseFetch(env, "office_hours_schedule",
      `?day_of_week=eq.${dayOfWeek}&select=day_of_week,open_time,close_time,is_closed`);
    return jsonResponse({ source: "schedule", date: today, day_of_week: dayOfWeek, ...(schedule?.[0] ?? { is_closed: true }) }, 200, corsHeaders);
  } catch (e) {
    console.error("getEffectiveHours error:", e);
    return jsonResponse({ source: "error", is_closed: true }, 200, corsHeaders);
  }
}

async function getSchedule(env, userJwt, corsHeaders) {
  return jsonResponse(await supabaseFetch(env, "office_hours_schedule", "?select=*&order=day_of_week.asc", userJwt), 200, corsHeaders);
}

async function updateScheduleDay(request, env, day, userJwt, corsHeaders) {
  const body = await request.json();
  const updates = {};
  ["open_time","close_time","is_closed"].forEach(k => { if (body[k] !== undefined) updates[k] = body[k]; });
  if (!Object.keys(updates).length) return jsonResponse({ error: "No valid fields to update" }, 400, corsHeaders);
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/office_hours_schedule?day_of_week=eq.${day}`,
    { method: "PATCH", headers: supabaseHeaders(env), body: JSON.stringify(updates) });
  if (!res.ok) throw new Error(`Supabase PATCH office_hours_schedule failed: ${await res.text()}`);
  return jsonResponse({ updated: true }, 200, corsHeaders);
}

async function getOverrides(env, userJwt, corsHeaders) {
  const today = getPhoenixDateStr();
  return jsonResponse(await supabaseFetch(env, "office_hours_overrides",
    `?override_date=gte.${today}&select=*&order=override_date.asc`, userJwt), 200, corsHeaders);
}

async function createOverride(request, env, userJwt, corsHeaders) {
  const { override_date, open_time, close_time, is_closed, note } = await request.json();
  if (!override_date) return jsonResponse({ error: "override_date is required" }, 400, corsHeaders);
  return jsonResponse(await supabasePost(env, "office_hours_overrides", {
    override_date,
    open_time:  is_closed ? null : (open_time  ?? null),
    close_time: is_closed ? null : (close_time ?? null),
    is_closed:  is_closed ?? false,
    note:       note ?? null,
  }, userJwt), 201, corsHeaders);
}

async function deleteOverride(env, date, userJwt, corsHeaders) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/office_hours_overrides?override_date=eq.${encodeURIComponent(date)}`,
    { method: "DELETE", headers: supabaseHeaders(env) });
  if (!res.ok) throw new Error(`Supabase DELETE office_hours_overrides failed: ${await res.text()}`);
  return jsonResponse({ deleted: date }, 200, corsHeaders);
}

async function getTodayOfficeHoursText(env) {
  try {
    const today     = getPhoenixDateStr();
    const dayOfWeek = getPhoenixDayOfWeek();
    const overrides = await supabaseFetch(env, "office_hours_overrides",
      `?override_date=eq.${today}&select=open_time,close_time,is_closed`);
    const hours = overrides?.length
      ? overrides[0]
      : (await supabaseFetch(env, "office_hours_schedule", `?day_of_week=eq.${dayOfWeek}&select=open_time,close_time,is_closed`))?.[0] ?? null;
    if (!hours) return "";
    const dayName   = DAY_NAMES[dayOfWeek];
    const dateLabel = new Date().toLocaleDateString("en-US", {
      timeZone: "America/Phoenix", month: "long", day: "numeric", year: "numeric",
    });
    if (hours.is_closed)
      return `[Office hours context: Today is ${dayName}, ${dateLabel}. FrontFrame is closed today. Responses will be provided the next business day. Share this when visitors ask about response times or hours.]`;
    const open  = formatTime12(hours.open_time);
    const close = formatTime12(hours.close_time);
    return `[Office hours context: Today is ${dayName}, ${dateLabel}. FrontFrame office hours: ${open} to ${close} Arizona time (no DST). Responses are typically provided within one business day during open hours. Share this when visitors ask about response times or hours.]`;
  } catch (e) {
    console.error("getTodayOfficeHoursText failed:", e.message);
    return "";
  }
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: rd-log
// ════════════════════════════════════════════════════════════════════════════

async function getRdLog(env, userJwt, corsHeaders) {
  return jsonResponse(await supabaseFetch(env, "rd_log", "?select=*&order=session_date.desc,created_at.desc", userJwt), 200, corsHeaders);
}

async function createRdEntry(request, env, userJwt, corsHeaders) {
  const { client, session_date, duration_minutes, category, description, qualifies, dedup_note, narrative } = await request.json();
  if (!client || !session_date || !duration_minutes || !category)
    return jsonResponse({ error: "client, session_date, duration_minutes, and category are required" }, 400, corsHeaders);
  return jsonResponse(await supabasePost(env, "rd_log", {
    client, session_date, duration_minutes: parseInt(duration_minutes, 10),
    category, description: description ?? null, qualifies: qualifies ?? false,
    dedup_note: dedup_note ?? null, narrative: narrative ?? null,
  }, userJwt), 201, corsHeaders);
}

async function deleteRdEntry(env, id, userJwt, corsHeaders) {
  await supabaseDelete(env, "rd_log", id);
  return jsonResponse({ deleted: id }, 200, corsHeaders);
}

async function updateRdEntry(request, env, id, userJwt, corsHeaders) {
  const body = await request.json();
  const updates = {};
  ["client","session_date","duration_minutes","category","description","qualifies","dedup_note","narrative"]
    .forEach(k => { if (body[k] !== undefined) updates[k] = body[k]; });
  if (!Object.keys(updates).length)
    return jsonResponse({ error: "No valid fields to update" }, 400, corsHeaders);
  if (updates.duration_minutes !== undefined) updates.duration_minutes = parseInt(updates.duration_minutes, 10);
  return jsonResponse(await supabasePatch(env, "rd_log", id, updates, userJwt), 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: outreach
// ════════════════════════════════════════════════════════════════════════════

const OUTREACH_MUTABLE_FIELDS = [
  "status", "research_notes", "prototype_subdomain",
  "contract_status", "contract_sent_at", "contract_expires_at",
  "ddl_payment_sent_at", "ddl_payment_paid_at",
];

async function getOutreachProspects(env, userJwt, corsHeaders) {
  const rows = await supabaseFetch(env, "inquiries",
    "?source=eq.cold_outreach&select=id,owner_name,business_name,email,phone,status,research_notes,prototype_subdomain,contract_status,contract_sent_at,contract_expires_at,ddl_payment_sent_at,ddl_payment_paid_at,created_at&order=created_at.desc",
    userJwt);
  return jsonResponse(rows ?? [], 200, corsHeaders);
}

async function createOutreachProspect(request, env, userJwt, corsHeaders) {
  const { owner_name, business_name, email, phone, prototype_subdomain, research_notes, source_page = "outreach" } = await request.json();
  if (!owner_name || !business_name || !email)
    return jsonResponse({ error: "owner_name, business_name, and email are required" }, 400, corsHeaders);
  const row = await supabasePost(env, "inquiries", {
    owner_name, business_name, email,
    phone:               phone               ?? null,
    prototype_subdomain: prototype_subdomain ?? null,
    research_notes:      research_notes      ?? null,
    source:              "cold_outreach",
    status:              "identified",
    source_page,
    contract_status:     "not_sent",
  }, userJwt);
  return jsonResponse(row, 201, corsHeaders);
}

async function updateOutreachProspect(request, env, id, userJwt, corsHeaders) {
  const body = await request.json();
  const updates = {};
  OUTREACH_MUTABLE_FIELDS.forEach(k => { if (k in body) updates[k] = body[k]; });
  if (!Object.keys(updates).length)
    return jsonResponse({ error: "No valid fields to update" }, 400, corsHeaders);
  return jsonResponse(await supabasePatch(env, "inquiries", id, updates, userJwt), 200, corsHeaders);
}

async function sendOutreachContract(request, env, id, userJwt, corsHeaders) {
  const rows = await supabaseFetch(env, "inquiries",
    `?id=eq.${encodeURIComponent(id)}&source=eq.cold_outreach&select=id,owner_name,business_name,email,contract_status`,
    userJwt);
  if (!rows?.length) return jsonResponse({ error: "Prospect not found" }, 404, corsHeaders);
  const p = rows[0];
  if (!p.email) return jsonResponse({ error: "Prospect has no email address" }, 400, corsHeaders);

  const today        = new Date().toISOString().split("T")[0];
  const signatureUrl = env.DOCUSEAL_SIGNATURE_URL ?? "";

  const submissionPayload = {
    template_id: 3703869,
    send_email:  true,
    submitters: [
      { role: "Second Party", email: p.email,
        fields: [
          { name: "Client_Name",   default_value: p.owner_name    ?? "", readonly: true },
          { name: "Business_Name", default_value: p.business_name ?? "", readonly: true },
          { name: "Client_email",  default_value: p.email         ?? "", readonly: true },
          { name: "Contract_date", default_value: today,                 readonly: true },
        ] },
      { role: "FrontFrame", email: ADMIN_EMAIL, completed: true,
        fields: [{ name: "FrontFrame_Signature", default_value: signatureUrl, readonly: true }] },
    ],
  };

  const dsRes = await fetch("https://api.docuseal.com/submissions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Auth-Token": env.DOCUSEAL_API_KEY },
    body: JSON.stringify(submissionPayload),
  });
  if (!dsRes.ok) throw new Error(`DocuSeal submission failed: ${await dsRes.text()}`);

  const dsData     = await dsRes.json();
  const envelopeId = String(dsData?.[0]?.submission_id ?? dsData?.id ?? "");

  const sentAt    = new Date();
  const expiresAt = new Date(sentAt.getTime() + 14 * 24 * 60 * 60 * 1000); // 14-day hard close

  await supabasePatch(env, "inquiries", id, {
    contract_status:     "sent",
    contract_sent_at:    sentAt.toISOString(),
    contract_expires_at: expiresAt.toISOString(),
  }, userJwt);

  return jsonResponse({ sent: true, envelope_id: envelopeId, expires_at: expiresAt.toISOString() }, 200, corsHeaders);
}

async function getOutreachTouches(env, inquiryId, userJwt, corsHeaders) {
  const rows = await supabaseFetch(env, "communications",
    `?inquiry_id=eq.${encodeURIComponent(inquiryId)}&select=*&order=touch_date.desc,created_at.desc`,
    userJwt);
  return jsonResponse(rows ?? [], 200, corsHeaders);
}

async function createOutreachTouch(request, env, inquiryId, userJwt, corsHeaders) {
  const { touch_date, method, outcome, next_action } = await request.json();
  if (!touch_date || !outcome)
    return jsonResponse({ error: "touch_date and outcome are required" }, 400, corsHeaders);
  const VALID_METHODS = ["call", "email", "sms", "visit"];
  if (method && !VALID_METHODS.includes(method))
    return jsonResponse({ error: `method must be one of: ${VALID_METHODS.join(", ")}` }, 400, corsHeaders);
  const row = await supabasePost(env, "communications", {
    inquiry_id:  Number(inquiryId),
    touch_date,
    method:      method      ?? "call",
    outcome,
    next_action: next_action ?? null,
  }, userJwt);
  return jsonResponse(row, 201, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: review-queue
// ════════════════════════════════════════════════════════════════════════════

async function getReviewQueue(request, env, userJwt, corsHeaders) {
  if (!userJwt) return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
  const status = new URL(request.url).searchParams.get("status");
  let query = "?select=*&order=created_at.desc";
  if (status && status !== "all") query += `&status=eq.${encodeURIComponent(status)}`;
  return jsonResponse(await supabaseFetch(env, "review_queue", query, userJwt), 200, corsHeaders);
}

async function updateReviewQueue(request, env, id, userJwt, corsHeaders) {
  const body = await request.json();
  const updates = {};
  ["status","notes"].forEach(k => { if (body[k] !== undefined) updates[k] = body[k]; });
  if (updates.status === "reviewed" || updates.status === "dismissed")
    updates.reviewed_at = new Date().toISOString();
  if (!Object.keys(updates).length) return jsonResponse({ error: "No valid fields to update" }, 400, corsHeaders);
  return jsonResponse(await supabasePatch(env, "review_queue", id, updates, userJwt), 200, corsHeaders);
}

async function deleteReviewQueue(env, id, userJwt, corsHeaders) {
  await supabaseDelete(env, "review_queue", id, userJwt);
  return jsonResponse({ deleted: id }, 200, corsHeaders);
}

async function bulkDeleteReviewQueue(request, env, userJwt, corsHeaders) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/review_queue?status=in.(reviewed,dismissed)`,
    { method: "DELETE", headers: supabaseHeaders(env) });
  if (!res.ok) throw new Error(`Bulk delete review_queue failed: ${await res.text()}`);
  return jsonResponse({ deleted: true }, 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: webhooks
// ════════════════════════════════════════════════════════════════════════════

async function handleStripeWebhook(request, env, corsHeaders) {
  const rawBody = await request.text();
  const sig     = request.headers.get("stripe-signature");
  if (env.STRIPE_WEBHOOK_SECRET && sig) {
    const valid = await verifyStripeSignature(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
    if (!valid) return jsonResponse({ error: "Invalid signature" }, 400, corsHeaders);
  }
  let event;
  try { event = JSON.parse(rawBody); } catch { return jsonResponse({ ok: true }, 200, corsHeaders); }
  if (event.type === "checkout.session.completed") {
    const session    = event.data.object;
    const leadId     = session.metadata?.lead_id     ?? null;
    const priceLabel = session.metadata?.price_label ?? "payment";
    const amount     = session.amount_total          ?? 0;
    if (leadId) {
      const agrRows = await supabaseFetch(env, "agreements", `?lead_id=eq.${leadId}&order=sent_at.desc&limit=1`).catch(() => null);
      if (agrRows?.length) {
        await supabasePatch(env, "agreements", agrRows[0].id, {
          payment_received_at: new Date().toISOString(), stripe_session_id: session.id,
        }).catch((e) => console.error("payment_received_at update failed:", e));
      }
    }
    await sendSms(env,
      `FrontFrame payment received\nAmount: $${(amount / 100).toFixed(2)}\nItem: ${priceLabel}\n` +
      (leadId ? `Lead: ${leadId}\n` : "") + `Session: ${session.id.slice(-12)}`
    ).catch((e) => console.error("Stripe payment SMS failed:", e));
  }
  return jsonResponse({ ok: true }, 200, corsHeaders);
}

async function handleDocusealWebhook(request, env, corsHeaders) {
  let payload;
  try { payload = await request.json(); } catch { return jsonResponse({ ok: true }, 200, corsHeaders); }
  const eventType    = payload?.event_type ?? payload?.event ?? "";
  const submissionId = String(payload?.data?.id ?? payload?.submission_id ?? "");
  if (!submissionId || !eventType.includes("completed")) return jsonResponse({ ok: true }, 200, corsHeaders);

  const agreementRows = await supabaseFetch(env, "agreements",
    `?docuseal_envelope_id=eq.${encodeURIComponent(submissionId)}&select=id,order_id,lead_id`).catch(() => null);
  if (agreementRows?.length) {
    const agreement = agreementRows[0];
    await supabasePatch(env, "agreements", agreement.id, { status: "signed", signed_at: new Date().toISOString() })
      .catch((e) => console.error("agreement patch failed:", e));
    const documentUrl = await fetchAndStoreDocument(env, submissionId, agreement.lead_id, agreement.id);
    if (documentUrl) {
      await supabasePatch(env, "agreements", agreement.id, { document_url: documentUrl })
        .catch((e) => console.error("document_url update failed:", e));
    }
    await sendSms(env, `FrontFrame contract signed\nLead: ${agreement.lead_id ?? "N/A"}\nDocuSeal ID: ${submissionId}`)
      .catch((e) => console.error("SMS failed:", e));
  }
  return jsonResponse({ ok: true }, 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: sms (Surge)
// ════════════════════════════════════════════════════════════════════════════

async function sendSms(env, message) {
  if (!env.SURGE_API_KEY) { console.warn("SURGE_API_KEY not configured"); return { success: false, status: "not_configured" }; }
  try {
    const res = await fetch(`https://api.surge.app/accounts/${SURGE_ACCOUNT_ID}/messages`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.SURGE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to: SURGE_TO_NUMBER, body: message }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { console.error("Surge error:", res.status, JSON.stringify(data)); return { success: false, status: data.message ?? `http_${res.status}` }; }
    return { success: true, status: data.status ?? "sent" };
  } catch (err) {
    console.error("Surge fetch failed:", err.message);
    return { success: false, status: "fetch_error" };
  }
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: email (Resend)
// ════════════════════════════════════════════════════════════════════════════

async function sendResendEmail(env, to, subject, html) {
  if (!env.RESEND_API_KEY) { console.warn("RESEND_API_KEY not configured"); return { success: false, status: "not_configured" }; }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: RESEND_FROM, to: [to], subject, html }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { console.error("Resend error:", res.status, JSON.stringify(data)); return { success: false, status: data.message ?? `http_${res.status}` }; }
    return { success: true, status: "sent", id: data.id };
  } catch (err) {
    console.error("Resend fetch failed:", err.message);
    return { success: false, status: "fetch_error" };
  }
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: docuseal (PDF store)
// ════════════════════════════════════════════════════════════════════════════

async function fetchAndStoreDocument(env, submissionId, leadId, agreementId) {
  try {
    const dsRes = await fetch(`https://api.docuseal.com/submissions/${submissionId}`,
      { headers: { "X-Auth-Token": env.DOCUSEAL_API_KEY } });
    if (!dsRes.ok) { console.error("DocuSeal submission fetch failed:", await dsRes.text()); return null; }
    const submission = await dsRes.json();
    const docUrl     = submission?.documents?.[0]?.url ?? null;
    if (!docUrl) { console.error("No document URL in DocuSeal submission"); return null; }
    const pdfRes = await fetch(docUrl);
    if (!pdfRes.ok) { console.error("PDF download failed:", pdfRes.status); return null; }
    const pdfBuffer   = await pdfRes.arrayBuffer();
    const storagePath = `${leadId ?? agreementId}/${submissionId}.pdf`;
    const uploadRes   = await fetch(`${env.SUPABASE_URL}/storage/v1/object/agreements/${storagePath}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "apikey":        env.SUPABASE_SERVICE_ROLE_KEY,
        "Content-Type":  "application/pdf",
        "x-upsert":      "true",
      },
      body: pdfBuffer,
    });
    if (!uploadRes.ok) { console.error("Supabase Storage upload failed:", await uploadRes.text()); return null; }
    return `${env.SUPABASE_URL}/storage/v1/object/agreements/${storagePath}`;
  } catch (err) { console.error("fetchAndStoreDocument failed:", err.message); return null; }
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: stripe (signature verification)
// ════════════════════════════════════════════════════════════════════════════

async function verifyStripeSignature(payload, sigHeader, secret) {
  try {
    const parts = sigHeader.split(",").reduce((acc, part) => {
      const [k, v] = part.split("="); if (k && v) acc[k] = v; return acc;
    }, {});
    if (!parts["t"] || !parts["v1"]) return false;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sigBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${parts["t"]}.${payload}`));
    const computed = Array.from(new Uint8Array(sigBytes)).map(b => b.toString(16).padStart(2, "0")).join("");
    return computed === parts["v1"];
  } catch { return false; }
}


// ════════════════════════════════════════════════════════════════════════════
// § UTILITY: ip hash, phoenix timezone
// ════════════════════════════════════════════════════════════════════════════

async function hashIp(ip) {
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(buffer)).slice(0, 8).map(b => b.toString(16).padStart(2, "0")).join("");
}

function getPhoenixDateStr() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Phoenix" });
}

function getPhoenixDayOfWeek() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/Phoenix" })).getDay();
}

function formatTime12(timeStr) {
  if (!timeStr) return "";
  const [h, m] = timeStr.slice(0, 5).split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const h12    = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: debug
// ════════════════════════════════════════════════════════════════════════════
//
// Empty in production. During a debug episode:
//   1. Write a targeted handler function here.
//   2. Add one entry to DEBUG_ROUTES below.
//   3. Deploy, tail, trigger, observe, resolve.
//   4. Remove handler and DEBUG_ROUTES entry before next production deploy.
//
// Example episode handler (do not leave in production):
//
//   async function debugAlertShape(request, env, corsHeaders) {
//     const rows = await supabaseFetch(env, "lead_alerts", "?limit=1&order=triggered_at.desc");
//     console.log("lead_alert shape:", JSON.stringify(rows?.[0], null, 2));
//     return jsonResponse({ shape: rows?.[0] ?? null }, 200, corsHeaders);
//   }

const DEBUG_ROUTES = [
  // { method: "GET", path: "/debug/alert-shape", handler: debugAlertShape },
];


// ════════════════════════════════════════════════════════════════════════════
// § ROUTER
// ════════════════════════════════════════════════════════════════════════════

const ROUTES = [
  // ── auth ─────────────────────────────────────────────────────────────────
  { method: "POST", path: "/auth/otp",                handler: (req, env, _ctx, ch) => handleSendOtp(req, env, ch) },
  { method: "POST", path: "/auth/otp/verify",         handler: (req, env, _ctx, ch) => handleVerifyOtp(req, env, ch) },
  { method: "POST", path: "/auth/magic-link",         handler: (req, env, _ctx, ch) => handleMagicLink(req, env, ch) },

  // ── chat / notify / inquiry ───────────────────────────────────────────────
  { method: "POST", path: "/chat",                    handler: (req, env, ctx, ch) => handleChat(req, env, ctx, ch) },
  { method: "POST", path: "/notify",                  handler: (req, env, ctx, ch) => handleNotify(req, env, ctx, ch) },
  { method: "POST", path: "/inquiry",                 handler: (req, env, _ctx, ch) => handleInquiry(req, env, ch) },

  // ── scheduling (public) ─────────────────────────────────────────────────
  { method: "GET",  path: "/blackout",                handler: (req, env, _ctx, ch) => getBlackout(env, ch) },
  { method: "POST", path: "/schedule",                handler: (req, env, _ctx, ch) => handleSchedule(req, env, ch) },

  // ── qa ───────────────────────────────────────────────────────────────────
  { method: "GET",    path: "/qa",                    handler: (req, env, _ctx, ch) => getQaPairs(env, ch) },
  { method: "POST",   path: "/qa",                    handler: (req, env, _ctx, ch) => createQaPair(req, env, ch) },
  { method: "PUT",    path: "/qa/:id",                handler: (req, env, _ctx, ch, p) => updateQaPair(req, env, p.id, ch) },
  { method: "DELETE", path: "/qa/:id",                handler: (req, env, _ctx, ch, p) => deleteQaPair(env, p.id, ch) },

  // ── proposal ─────────────────────────────────────────────────────────────
  { method: "GET",  path: "/proposal",                handler: (req, env, _ctx, ch) => getProposal(req, env, ch) },
  { method: "POST", path: "/proposal/review",         handler: (req, env, ctx, ch)  => submitProposalReview(req, env, ctx, ch) },

  // ── podcast-episodes (public) ─────────────────────────────────────────────
  { method: "GET", path: "/podcast-episodes",         handler: (req, env, _ctx, ch) => getPodcastEpisodes(env, ch) },

  // ── rss-proxy ─────────────────────────────────────────────────────────────
  { method: "GET", path: "/rss-proxy",                handler: (req, env, _ctx, ch) => handleRssProxy(req, ch) },

  // ── office-hours (public) ─────────────────────────────────────────────────
  { method: "GET", path: "/api/office-hours",         handler: (req, env, _ctx, ch) => getEffectiveHours(env, ch) },

  // ── webhooks ─────────────────────────────────────────────────────────────
  { method: "POST", path: "/webhooks/stripe",         handler: (req, env, _ctx, ch) => handleStripeWebhook(req, env, ch) },
  { method: "POST", path: "/webhooks/docuseal",       handler: (req, env, _ctx, ch) => handleDocusealWebhook(req, env, ch) },

  // ── admin: scheduling ────────────────────────────────────────────────────
  { method: "GET",    path: "/admin/blackout",         handler: (req, env, _ctx, ch) => getBlackoutAdmin(env, ch) },
  { method: "POST",   path: "/admin/blackout",         handler: (req, env, _ctx, ch) => createBlackoutAdmin(req, env, ch) },
  { method: "DELETE", path: "/admin/blackout/:id",     handler: (req, env, _ctx, ch, p) => deleteBlackoutAdmin(env, p.id, ch) },
  { method: "GET",    path: "/admin/bookings",         handler: (req, env, _ctx, ch) => getBookingsAdmin(env, ch) },
  { method: "PUT",    path: "/admin/bookings/:id",     handler: (req, env, _ctx, ch, p) => updateBookingAdmin(req, env, p.id, ch) },

  // ── admin: config ─────────────────────────────────────────────────────────
  { method: "GET",  path: "/admin/config",            handler: (req, env, _ctx, ch) => getConfig(env, extractJwt(req), ch) },
  { method: "POST", path: "/admin/config",            handler: (req, env, _ctx, ch) => updateConfig(req, env, extractJwt(req), ch) },

  // ── admin: defects ────────────────────────────────────────────────────────
  { method: "GET",   path: "/admin/defects",          handler: (req, env, _ctx, ch) => getDefects(env, extractJwt(req), ch) },
  { method: "POST",  path: "/admin/defects",          handler: (req, env, _ctx, ch) => createDefect(req, env, extractJwt(req), ch) },
  { method: "PATCH", path: "/admin/defects/:id",      handler: (req, env, _ctx, ch, p) => updateDefect(req, env, p.id, extractJwt(req), ch) },

  // ── admin: feedback ───────────────────────────────────────────────────────
  { method: "GET",   path: "/admin/feedback",                  handler: (req, env, _ctx, ch) => getFeedback(env, extractJwt(req), ch) },
  { method: "POST",  path: "/admin/feedback",                  handler: (req, env, _ctx, ch) => createFeedback(req, env, extractJwt(req), ch) },
  { method: "POST",  path: "/admin/feedback/check-conflicts",  handler: (req, env, _ctx, ch) => checkFeedbackConflicts(req, env, extractJwt(req), ch) },
  { method: "PATCH", path: "/admin/feedback/:id",              handler: (req, env, _ctx, ch, p) => updateFeedback(req, env, p.id, extractJwt(req), ch) },

  // ── admin: changelog ──────────────────────────────────────────────────────
  { method: "GET",  path: "/admin/changelog",         handler: (req, env, _ctx, ch) => getChangelog(env, extractJwt(req), ch) },
  { method: "POST", path: "/admin/changelog",         handler: (req, env, _ctx, ch) => createChangelog(req, env, extractJwt(req), ch) },

  // ── admin: leads ──────────────────────────────────────────────────────────
  { method: "GET",  path: "/admin/leads",             handler: (req, env, _ctx, ch) => getLeads(env, extractJwt(req), ch) },
  { method: "POST", path: "/admin/leads",             handler: (req, env, _ctx, ch) => createLead(req, env, extractJwt(req), ch) },

  // ── admin: lead-alerts (session sub-route before :id) ─────────────────────
  { method: "GET",    path: "/admin/lead-alerts/:id/session", handler: (req, env, _ctx, ch, p) => getAlertSession(env, p.id, extractJwt(req), ch) },
  { method: "GET",    path: "/admin/lead-alerts",             handler: (req, env, _ctx, ch) => getLeadAlerts(env, extractJwt(req), ch) },
  { method: "PATCH",  path: "/admin/lead-alerts/:id",         handler: (req, env, _ctx, ch, p) => updateLeadAlert(req, env, p.id, extractJwt(req), ch) },
  { method: "DELETE", path: "/admin/lead-alerts/:id",         handler: (req, env, _ctx, ch, p) => deleteLeadAlert(env, p.id, extractJwt(req), ch) },

  // ── admin: agreements ─────────────────────────────────────────────────────
  { method: "GET",   path: "/admin/agreements",               handler: (req, env, _ctx, ch) => getAgreements(env, extractJwt(req), ch) },
  { method: "POST",  path: "/admin/agreements/send",          handler: (req, env, _ctx, ch) => sendAgreement(req, env, extractJwt(req), ch) },
  { method: "POST",  path: "/admin/agreements/send-diligence", handler: (req, env, _ctx, ch) => sendDueDiligence(req, env, extractJwt(req), ch) },
  { method: "PATCH", path: "/admin/agreements/:id",           handler: (req, env, _ctx, ch, p) => updateAgreement(req, env, p.id, extractJwt(req), ch) },

  // ── admin: system-prompt ──────────────────────────────────────────────────
  { method: "GET",  path: "/admin/system-prompt/:page",       handler: (req, env, _ctx, ch, p) => getSystemPrompt(env, p.page, extractJwt(req), ch) },
  { method: "POST", path: "/admin/system-prompt/:page",       handler: (req, env, _ctx, ch, p) => updateSystemPrompt(req, env, p.page, extractJwt(req), ch) },

  // ── admin: reviewers ──────────────────────────────────────────────────────
  { method: "GET",    path: "/admin/reviewers",               handler: (req, env, _ctx, ch) => getReviewers(env, extractJwt(req), ch) },
  { method: "POST",   path: "/admin/reviewers/invite",        handler: (req, env, _ctx, ch) => inviteReviewer(req, env, extractJwt(req), ch) },
  { method: "POST",   path: "/admin/reviewers/reset-password", handler: (req, env, _ctx, ch) => resetReviewerPassword(req, env, extractJwt(req), ch) },
  { method: "PATCH",  path: "/admin/reviewers/:id",           handler: (req, env, _ctx, ch, p) => updateReviewer(req, env, p.id, extractJwt(req), ch) },
  { method: "DELETE", path: "/admin/reviewers/:id",           handler: (req, env, _ctx, ch, p) => deleteReviewer(env, p.id, extractJwt(req), ch) },

  // ── admin: podcast-episodes ───────────────────────────────────────────────
  { method: "GET",    path: "/admin/podcast-episodes",        handler: (req, env, _ctx, ch) => adminGetPodcastEpisodes(env, extractJwt(req), ch) },
  { method: "POST",   path: "/admin/podcast-episodes",        handler: (req, env, _ctx, ch) => createPodcastEpisode(req, env, extractJwt(req), ch) },
  { method: "PATCH",  path: "/admin/podcast-episodes/:id",    handler: (req, env, _ctx, ch, p) => updatePodcastEpisode(req, env, p.id, extractJwt(req), ch) },
  { method: "DELETE", path: "/admin/podcast-episodes/:id",    handler: (req, env, _ctx, ch, p) => deletePodcastEpisode(env, p.id, extractJwt(req), ch) },

  // ── admin: marketing-log ──────────────────────────────────────────────────
  { method: "GET",   path: "/admin/marketing-log",            handler: (req, env, _ctx, ch) => getMarketingLog(req, env, extractJwt(req), ch) },
  { method: "POST",  path: "/admin/marketing-log",            handler: (req, env, _ctx, ch) => createMarketingLog(req, env, extractJwt(req), ch) },
  { method: "PATCH", path: "/admin/marketing-log/:id",        handler: (req, env, _ctx, ch, p) => updateMarketingLog(req, env, p.id, extractJwt(req), ch) },

  // ── admin: problem-statements ─────────────────────────────────────────────
  { method: "GET",   path: "/admin/problem-statements",       handler: (req, env, _ctx, ch) => getProblemStatements(env, extractJwt(req), ch) },
  { method: "POST",  path: "/admin/problem-statements",       handler: (req, env, _ctx, ch) => createProblemStatement(req, env, extractJwt(req), ch) },
  { method: "PATCH", path: "/admin/problem-statements/:id",   handler: (req, env, _ctx, ch, p) => updateProblemStatement(req, env, p.id, extractJwt(req), ch) },

  // ── admin: deliverables ───────────────────────────────────────────────────
  { method: "GET",   path: "/admin/deliverables",             handler: (req, env, _ctx, ch) => getDeliverables(req, env, extractJwt(req), ch) },
  { method: "POST",  path: "/admin/deliverables",             handler: (req, env, _ctx, ch) => createDeliverable(req, env, extractJwt(req), ch) },
  { method: "PATCH", path: "/admin/deliverables/:id",         handler: (req, env, _ctx, ch, p) => updateDeliverable(req, env, p.id, extractJwt(req), ch) },

  // ── admin: payments ───────────────────────────────────────────────────────
  { method: "POST", path: "/admin/payments/create-checkout",  handler: (req, env, _ctx, ch) => createCheckoutSession(req, env, extractJwt(req), ch) },
  { method: "POST", path: "/admin/payments/send-request",     handler: (req, env, _ctx, ch) => handleSendPaymentRequest(req, env, extractJwt(req), ch) },

  // ── admin: subscriptions ──────────────────────────────────────────────────
  { method: "GET",  path: "/admin/subscriptions",             handler: (req, env, _ctx, ch) => getSubscriptions(env, extractJwt(req), ch) },
  { method: "POST", path: "/admin/subscriptions",             handler: (req, env, _ctx, ch) => createSubscription(req, env, extractJwt(req), ch) },
  { method: "POST", path: "/admin/subscriptions/:id/send",    handler: (req, env, _ctx, ch, p) => sendSubscription(env, p.id, extractJwt(req), ch) },
  { method: "PATCH", path: "/admin/subscriptions/:id",        handler: (req, env, _ctx, ch, p) => updateSubscription(req, env, p.id, extractJwt(req), ch) },

  // ── admin: vault ──────────────────────────────────────────────────────────
  { method: "GET",  path: "/admin/vault",                     handler: (req, env, _ctx, ch) => handleAdminVaultGet(req, env, extractJwt(req), ch) },
  { method: "POST", path: "/admin/vault",                     handler: (req, env, _ctx, ch) => handleAdminVaultSet(req, env, extractJwt(req), ch) },

  // ── api: office-hours (admin) ─────────────────────────────────────────────
  { method: "GET",    path: "/api/office-hours/schedule",         handler: (req, env, _ctx, ch) => getSchedule(env, extractJwt(req), ch) },
  { method: "PATCH",  path: "/api/office-hours/schedule/:day",    handler: (req, env, _ctx, ch, p) => updateScheduleDay(req, env, p.day, extractJwt(req), ch) },
  { method: "GET",    path: "/api/office-hours/overrides",        handler: (req, env, _ctx, ch) => getOverrides(env, extractJwt(req), ch) },
  { method: "POST",   path: "/api/office-hours/overrides",        handler: (req, env, _ctx, ch) => createOverride(req, env, extractJwt(req), ch) },
  { method: "DELETE", path: "/api/office-hours/overrides/:date",  handler: (req, env, _ctx, ch, p) => deleteOverride(env, p.date, extractJwt(req), ch) },

  // ── api: rd-log ───────────────────────────────────────────────────────────
  { method: "GET",    path: "/api/rd-log",                    handler: (req, env, _ctx, ch) => getRdLog(env, extractJwt(req), ch) },
  { method: "POST",   path: "/api/rd-log",                    handler: (req, env, _ctx, ch) => createRdEntry(req, env, extractJwt(req), ch) },
  { method: "PATCH",  path: "/api/rd-log/:id",                handler: (req, env, _ctx, ch, p) => updateRdEntry(req, env, p.id, extractJwt(req), ch) },
  { method: "DELETE", path: "/api/rd-log/:id",                handler: (req, env, _ctx, ch, p) => deleteRdEntry(env, p.id, extractJwt(req), ch) },

  // ── admin: outreach (sub-routes before :id) ───────────────────────────────
  { method: "GET",   path: "/admin/outreach",                    handler: (req, env, _ctx, ch) => getOutreachProspects(env, extractJwt(req), ch) },
  { method: "POST",  path: "/admin/outreach",                    handler: (req, env, _ctx, ch) => createOutreachProspect(req, env, extractJwt(req), ch) },
  { method: "GET",   path: "/admin/outreach/:id/touches",        handler: (req, env, _ctx, ch, p) => getOutreachTouches(env, p.id, extractJwt(req), ch) },
  { method: "POST",  path: "/admin/outreach/:id/touches",        handler: (req, env, _ctx, ch, p) => createOutreachTouch(req, env, p.id, extractJwt(req), ch) },
  { method: "POST",  path: "/admin/outreach/:id/send-contract",  handler: (req, env, _ctx, ch, p) => sendOutreachContract(req, env, p.id, extractJwt(req), ch) },
  { method: "PATCH", path: "/admin/outreach/:id",                handler: (req, env, _ctx, ch, p) => updateOutreachProspect(req, env, p.id, extractJwt(req), ch) },

  // ── admin: review-queue (bulk before :id) ─────────────────────────────────
  { method: "DELETE", path: "/admin/review-queue/bulk",       handler: (req, env, _ctx, ch) => bulkDeleteReviewQueue(req, env, extractJwt(req), ch) },
  { method: "GET",    path: "/admin/review-queue",            handler: (req, env, _ctx, ch) => getReviewQueue(req, env, extractJwt(req), ch) },
  { method: "PATCH",  path: "/admin/review-queue/:id",        handler: (req, env, _ctx, ch, p) => updateReviewQueue(req, env, p.id, extractJwt(req), ch) },
  { method: "DELETE", path: "/admin/review-queue/:id",        handler: (req, env, _ctx, ch, p) => deleteReviewQueue(env, p.id, extractJwt(req), ch) },
];

function matchRoute(routes, method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    if (route.path === pathname) return { route, params: {} };
    const pattern = "^" + route.path.replace(/:([^/]+)/g, "([^/]+)") + "$";
    const match   = pathname.match(new RegExp(pattern));
    if (match) {
      const keys   = [...route.path.matchAll(/:([^/]+)/g)].map((m) => m[1]);
      const params = Object.fromEntries(keys.map((k, i) => [k, match[i + 1]]));
      return { route, params };
    }
  }
  return null;
}

export default {
  async fetch(request, env, ctx) {
    const url    = new URL(request.url);
    const method = request.method;

    if (method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

    try {
      const debugHit = matchRoute(DEBUG_ROUTES, method, url.pathname);
      if (debugHit) return debugHit.route.handler(request, env, ctx, CORS_HEADERS, debugHit.params);

      const hit = matchRoute(ROUTES, method, url.pathname);
      if (hit) {
        const isProtected = hit.route.path.startsWith("/admin/") || hit.route.path === "/admin"
          || ADMIN_EXTRA_PROTECTED_PATHS.has(hit.route.path);
        if (isProtected) {
          const auth = await requireReviewer(request, env);
          if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status, CORS_HEADERS);
        }
        return hit.route.handler(request, env, ctx, CORS_HEADERS, hit.params);
      }

      return jsonResponse({ error: "Not found" }, 404, CORS_HEADERS);
    } catch (err) {
      console.error("Worker error:", err);
      return jsonResponse({ error: "Internal server error" }, 500, CORS_HEADERS);
    }
  },
};

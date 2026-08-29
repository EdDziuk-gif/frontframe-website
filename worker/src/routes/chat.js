import { jsonResponse } from "../shared/http.js";
import { supabaseDelete, supabaseFetch, supabasePatch, supabasePatchByField, supabasePost, supabaseRpc, supabaseUpsert, supabaseHeaders } from "../shared/supabase.js";
import { ADMIN_EMAIL, DEFECT_PATTERN, ESCALATION_PATTERN, GAP_SIGNAL, RESEARCH_PATTERN, TESTING_LAYER, buildSystemPrompt, callAnthropic, sendSms } from "../shared/runtime.js";
import { getTodayOfficeHoursText } from "../shared/office-hours.js";
import { RATE_LIMITED_MESSAGE, checkChatRateLimit } from "../shared/rate-limit.js";
import { LIMITED_CONFIDENCE_HEDGE, createScoringLifecycle, recordDeliveredResponse } from "../shared/scoring.js";

// § DOMAIN: chat
// ════════════════════════════════════════════════════════════════════════════

// Shown to visitors when config.mode = "disabled" (kill switch, admin Config tab).
// Draft copy — Ed's edit, not final. Keep it short, no overpromising on timeline.
const BOT_DISABLED_MESSAGE =
  `Our assistant is temporarily unavailable. For anything urgent, reach us directly at ${ADMIN_EMAIL}.`;

// Per the architecture and REQ-SCA-06, a sub-threshold candidate answer cannot
// be surfaced to the inquirer on the system's own authority.
// Draft copy — Ed's edit, not final.
const RESOLVE_GAP_MESSAGE =
  "I don't have a reliable answer to that yet. Want to leave your contact info? " +
  `Ed will follow up personally once we have a solid answer. You can also reach him directly at ed@frontframe.co.`;

async function handleChat(request, env, ctx, corsHeaders) {
  const body = await request.json();
  const { page, message, history = [], session_id = null } = body;
  if (!page || !message) return jsonResponse({ error: "page and message are required" }, 400, corsHeaders);

  const configRows = await supabaseFetch(env, "config", "?id=eq.1&select=mode,build_version,capture_enabled");
  const config = configRows?.[0] ?? { mode: "live", build_version: "unknown", capture_enabled: false };

  // ── Kill switch ───────────────────────────────────────────────────────────
  // When mode = "disabled" (set via /admin → Config), skip Supabase content
  // lookups and Anthropic calls entirely. No redeploy needed to flip this.
  if (config.mode === "disabled") {
	return jsonResponse({ response: BOT_DISABLED_MESSAGE, mode: config.mode }, 200, corsHeaders);
  }

  // ── Rate guard ────────────────────────────────────────────────────────────
  // Caps requests into the Anthropic pipeline before any content lookup.
  // Phase D adds the Scoring Agent call, so a normal turn now makes the main
  // reply + scoring call, plus the existing async evaluator when session_id exists.
  const rateLimit = await checkChatRateLimit(env, request);
  if (!rateLimit.allowed) {
	return jsonResponse({ response: RATE_LIMITED_MESSAGE, mode: config.mode }, 200, corsHeaders);
  }

  // ── System prompt: shared core (page="all") + page-specific block ───────
  // Same global-row + page-row merge already used in operations.js's admin
  // preview path (fetch both, join with a blank line between). Previously
  // this route only fetched the page-specific row — the "all" row existed
  // in operations.js's read path but was never joined into what visitors
  // actually talk to. This wires it in here too, so the two paths (live
  // chat, admin preview) build the prompt the same way.
  const [pageRow, globalRow] = await Promise.all([
	supabaseFetch(env, "system_prompt", `?page=eq.${encodeURIComponent(page)}&select=content`),
	supabaseFetch(env, "system_prompt", `?page=eq.all&select=content`),
  ]);
  const pagePromptContent   = pageRow?.[0]?.content ?? "";
  const globalPromptContent = globalRow?.[0]?.content ?? "";
  const systemPromptContent = [globalPromptContent, pagePromptContent].filter(Boolean).join("\n\n");

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

  // ── Phase D: Scoring Agent + deterministic Scoring Consumer ──────────────
  // The candidate answer is scored before visitor delivery. The scoring call
  // receives only the literal question and candidate answer. SCA then applies
  // live threshold_config values deterministically.
  let scoringLifecycle = null;
  let hedgeShown = false;
  try {
	scoringLifecycle = await createScoringLifecycle(env, {
	  question: message,
	  answer: response,
	  askedBy: session_id,
	  source: "visitor_chat",
	});

	if (scoringLifecycle.route === "resolve_gap") {
	  // The candidate remains in lifecycle records for human handling, but the
	  // system does not surface it to the visitor on its own authority.
	  response = RESOLVE_GAP_MESSAGE;
	} else if (scoringLifecycle.route === "respond_limited") {
	  // Decision 0018: deliver the candidate with a confidence hedge; no
	  // mandatory affirm/decline gate.
	  hedgeShown = true;
	  response = LIMITED_CONFIDENCE_HEDGE + response;
	}
  } catch (e) {
	// Infrastructure/model failure is not permission to surface an unscored
	// candidate. Fail closed at the same human-resolution boundary.
	console.error("Phase D scoring pipeline failed:", e);
	response = RESOLVE_GAP_MESSAGE;
	ctx.waitUntil(
	  supabasePost(env, "defects", {
		area: "agentic_scoring",
		description: `Phase D scoring pipeline failed: ${e?.message ?? "unknown error"}`,
		severity: "high",
		disposition: "retain",
		build_version: config.build_version ?? "unknown",
		stage_gate: config.stage_gate ?? "build",
	  }).catch((err) => console.error("scoring defect write failed:", err))
	);
  }

  if (scoringLifecycle?.routeId) {
	try {
	  await recordDeliveredResponse(env, scoringLifecycle.routeId, response, hedgeShown);
	} catch (e) {
	  // Routing succeeded, so do not change the visitor's already-determined
	  // route merely because response evidence failed to persist. Log the defect.
	  console.error("Phase D response persistence failed:", e);
	  ctx.waitUntil(
		supabasePost(env, "defects", {
		  area: "agentic_scoring",
		  description: `Phase D response persistence failed: ${e?.message ?? "unknown error"}`,
		  severity: "high",
		  disposition: "retain",
		  build_version: config.build_version ?? "unknown",
		  stage_gate: config.stage_gate ?? "build",
		}).catch((err) => console.error("response persistence defect write failed:", err))
	  );
	}
  }

  // ── Session capture ──────────────────────────────────────────────────────
  // Capture the response actually delivered after Phase D routing.
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

export { handleChat, captureSession, RESOLVE_GAP_MESSAGE };
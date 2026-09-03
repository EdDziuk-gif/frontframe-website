import { jsonResponse } from "../shared/http.js";
import { supabaseDelete, supabaseFetch, supabasePatch, supabasePatchByField, supabasePost, supabaseRpc, supabaseUpsert, supabaseHeaders } from "../shared/supabase.js";
import { ADMIN_EMAIL, DEFECT_PATTERN, ESCALATION_PATTERN, GAP_SIGNAL, KNOWLEDGE_GAP_INSTRUCTION, KNOWLEDGE_GAP_PATTERN, RESEARCH_PATTERN, TESTING_LAYER, buildConstitutionSection, buildSystemPrompt, callAnthropic, sendSms } from "../shared/runtime.js";
import { getTodayOfficeHoursText } from "../shared/office-hours.js";
import { RATE_LIMITED_MESSAGE, checkChatRateLimit } from "../shared/rate-limit.js";
import { LIMITED_CONFIDENCE_HEDGE, checkConstitutionalEligibility, createConstitutionalCandidateLifecycle, createKnowledgeGapLifecycle, createScoringLifecycle, recordDeliveredResponse } from "../shared/scoring.js";

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
  `Ed will follow up personally once we have a solid answer. You can also reach him directly at ${ADMIN_EMAIL}.`;

// Phase E completion, item B. Shown when the prior, bounded constitutional-
// eligibility check (checkConstitutionalEligibility(), run BEFORE generation
// and BEFORE SCR — see handleSingleTurn below) has flagged this question as
// a constitutional/authority-governance candidate. Distinct message from
// RESOLVE_GAP_MESSAGE so a visitor and any log reader can tell this was a
// governance question, not a missing fact — the model is not withholding a
// guess, it is declining to decide something that isn't its call to make.
const CONSTITUTIONAL_HOLD_MESSAGE =
  "That touches how FrontFrame itself is governed, which isn't something I can decide on my own. " +
  "I've flagged it for Ed to determine. Want to leave your contact info so he can follow up? " +
  `You can also reach him directly at ${ADMIN_EMAIL}.`;

// Truthful, compact statements used when assembling a compound reply — see
// decomposeIfCompound()/handleSingleTurn() below. These stand in place of the
// full withheld-answer messages above so a multi-part reply doesn't repeat
// the same contact pitch once per unresolved subpart; assembleCompoundReply()
// appends a single combined invitation at the end instead.
const WITHHELD_KNOWLEDGE_GAP_NOTE =
  "I don't have a reliable answer to that part yet";
const WITHHELD_CONSTITUTIONAL_NOTE =
  "that part touches FrontFrame's own governance, which isn't mine to decide";

// Phase E gap-resolution-queue visibility: a lightweight SMS alert whenever a
// gap_resolution_requests row is created, so an unresolved visitor question
// doesn't sit unseen. Best-effort — never blocks or fails the visitor reply.
async function alertGapResolutionQueue(env, ctx, page, question, reason) {
  ctx.waitUntil(
    sendSms(env,
      `FrontFrame gap queue\nReason: ${reason}\nPage: ${page}\n` +
      `Question: ${question.slice(0, 200)}`
    ).catch((e) => console.error("gap-resolution-queue alert failed:", e))
  );
}

// Phase E completion, item C. Cheap, purely syntactic prefilter run before
// ever spending a model call on decomposition — most single-question turns
// never reach the Anthropic call below. Intentionally permissive (a false
// positive just costs one small haiku call that returns {"subparts": null}).
const COMPOUND_HINT_PATTERN = /\b(and also|also,|in addition|as well as)\b|\?.*\?/is;

async function decomposeIfCompound(env, message) {
  if (!COMPOUND_HINT_PATTERN.test(message)) return null;
  try {
    const raw = await callAnthropic(
      env,
      `Decide whether the visitor message below asks more than one genuinely separate
question that would need separate answers. Most messages, even long ones, are a
single question — do not split rhetorical asides, clarifying detail, or a single
question that merely has multiple clauses.

If it is genuinely two or more separate questions, return each as its own
self-contained question in the visitor's own words (add only the minimal
context needed for the question to stand alone). If it is not, return null.

Return exactly one JSON object and no other text, in exactly this form:
{"subparts": ["...", "..."]} or {"subparts": null}`,
      [{ role: "user", content: message }],
    );
    const cleaned = String(raw ?? "").replace(/```json|```/gi, "").trim();
    const parsed = JSON.parse(cleaned);
    if (!Array.isArray(parsed?.subparts) || parsed.subparts.length < 2) return null;
    const subparts = parsed.subparts
      .map((s) => (typeof s === "string" ? s.trim() : ""))
      .filter(Boolean);
    return subparts.length >= 2 ? subparts : null;
  } catch (e) {
    // Decomposition is an optimization, not a correctness requirement — on any
    // failure, fall through to treating the message as a single turn.
    console.error("compound decomposition failed, treating as single turn:", e);
    return null;
  }
}

// Phase E completion, item B. A bounded, prior classification step run
// BEFORE any candidate answer is generated and BEFORE SCR ever runs — see
// checkConstitutionalEligibility() in scoring.js for the eligibility
// contract itself. This is NOT the same thing as showing the Constitution
// to the generation call (item A) — that context is for an already-eligible
// question's answer quality, not for eligibility itself. A constitutional
// candidate is routed immediately with no candidate answer generated and no
// SCR call; only an eligible question proceeds to generation.
//
// One question through eligibility review, generation, marker detection, and
// Phase D/E routing. Shared by both the ordinary single-question path and
// each subpart of a decomposed compound question, so the two paths can never
// drift apart on how a candidate is judged eligible for delivery.
async function handleSingleTurn(env, ctx, config, constitutionSection, combinedPrompt, message, history, page, session_id, source) {
  // ── Constitutional eligibility review (Phase E completion, item B) ───────
  // Runs before anything else. On a genuine constitutional candidate, or on
  // an eligibility-check failure (fails closed), no candidate answer is ever
  // generated from the operational corpus and SCR is never invoked.
  const eligibility = await checkConstitutionalEligibility(env, constitutionSection, message);

  if (eligibility.constitutionalCandidate) {
    let scoringLifecycle = null;
    try {
      scoringLifecycle = await createConstitutionalCandidateLifecycle(env, {
        question: message,
        answer: "(No candidate answer generated — constitutional eligibility review withheld this question before generation.)",
        issue: eligibility.issue,
        askedBy: session_id,
        source,
      });
    } catch (e) {
      console.error("Phase E constitutional-candidate lifecycle failed:", e);
      ctx.waitUntil(
        supabasePost(env, "defects", {
          area: "agentic_scoring",
          description: `Constitutional-candidate lifecycle failed: ${e?.message ?? "unknown error"}`,
          severity: "high",
          disposition: "retain",
          build_version: config.build_version ?? "unknown",
          stage_gate: config.stage_gate ?? "build",
        }).catch((err) => console.error("constitutional defect write failed:", err))
      );
    }
    if (eligibility.eligibilityCheckFailed) {
      ctx.waitUntil(
        supabasePost(env, "defects", {
          area: "agentic_scoring",
          description: `Constitutional eligibility check failed - failed closed, no generation, no SCR. Question: ${message.slice(0, 200)}`,
          severity: "high",
          disposition: "retain",
          build_version: config.build_version ?? "unknown",
          stage_gate: config.stage_gate ?? "build",
        }).catch((err) => console.error("eligibility defect write failed:", err))
      );
    }
    if (scoringLifecycle?.gapResolutionRequestId) {
      await alertGapResolutionQueue(env, ctx, page, message, "constitutional_candidate");
    }
    return {
      response: CONSTITUTIONAL_HOLD_MESSAGE,
      routeId: scoringLifecycle?.routeId ?? null,
      hedgeShown: false,
      isWithheld: true,
      withheldNote: WITHHELD_CONSTITUTIONAL_NOTE,
    };
  }

  // ── Eligible: ordinary operational-corpus generation ─────────────────────
  const messages = [...history, { role: "user", content: message }];
  const rawReply = await callAnthropic(env, combinedPrompt, messages);

  // ── Escalation detection ─────────────────────────────────────────────────
  let response = rawReply;
  const escMatch = rawReply.match(ESCALATION_PATTERN);

  if (escMatch) {
    response = rawReply.replace(ESCALATION_PATTERN, "").trim();
    let escalation;
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

  // ── Knowledge-gap detection (Generation-Boundary Spike, Phase E) ─────────
  // Distinct boundary from the constitutional-eligibility review above: this
  // catches an ordinary missing organizational FACT (system_prompt/qa_pairs
  // silent on it), not a governance/authority question — eligibility for
  // that was already decided before generation even ran.
  const gapMatch = response.match(KNOWLEDGE_GAP_PATTERN);
  let knowledgeGapMissing = null;
  let knowledgeGapMalformed = false;

  if (gapMatch) {
    try {
      const parsedGap = JSON.parse(gapMatch[0]);
      if (parsedGap?._knowledge_gap === true) {
        knowledgeGapMissing = typeof parsedGap.missing === "string" && parsedGap.missing.trim()
          ? parsedGap.missing.trim()
          : "(not specified)";
        response = response.replace(KNOWLEDGE_GAP_PATTERN, "").trim();
      } else {
        knowledgeGapMalformed = true;
      }
    } catch {
      knowledgeGapMalformed = true;
    }
  } else if (response.slice(-300).includes("_knowledge_gap")) {
    // The model appears to have attempted the marker near the end of its
    // reply but it did not match the expected shape closely enough to parse.
    // Restricted to the tail of the response so an unrelated mid-reply
    // mention (e.g. quoted or discussed in prose) is not mistaken for a
    // failed marker attempt.
    knowledgeGapMalformed = true;
  }

  // ── Phase D: Scoring Agent + deterministic Scoring Consumer ──────────────
  // The candidate answer is scored before visitor delivery. The scoring call
  // receives only the literal question and candidate answer. SCA then applies
  // live threshold_config values deterministically. Bypassed entirely for a
  // confirmed or malformed knowledge-gap marker — see block above. (A
  // constitutional candidate never reaches this point at all — see the
  // eligibility check at the top of this function.)
  let scoringLifecycle = null;
  let hedgeShown = false;
  let isWithheld = false;
  let withheldNote = null;

  if (knowledgeGapMalformed) {
    const rawCandidate = response;
    console.error("Malformed knowledge-gap marker — withholding candidate:", rawCandidate.slice(0, 200));
    response = RESOLVE_GAP_MESSAGE;
    isWithheld = true;
    withheldNote = WITHHELD_KNOWLEDGE_GAP_NOTE;
    ctx.waitUntil(
      supabasePost(env, "defects", {
        area: "agentic_scoring",
        description: `Malformed knowledge-gap marker - candidate withheld, SCR not invoked. Raw: ${rawCandidate.slice(0, 200)}`,
        severity: "high",
        disposition: "retain",
        build_version: config.build_version ?? "unknown",
        stage_gate: config.stage_gate ?? "build",
      }).catch((err) => console.error("marker defect write failed:", err))
    );
  } else {
    try {
      scoringLifecycle = knowledgeGapMissing !== null
        ? await createKnowledgeGapLifecycle(env, {
            question: message,
            answer: response.trim() ? response : "(No partial answer — full knowledge gap.)",
            missing: knowledgeGapMissing,
            askedBy: session_id,
            source,
          })
        : await createScoringLifecycle(env, {
            question: message,
            answer: response,
            askedBy: session_id,
            source,
          });

      if (scoringLifecycle.route === "resolve_gap") {
        // The candidate remains in lifecycle records for human handling, but the
        // system does not surface it to the visitor on its own authority.
        response = RESOLVE_GAP_MESSAGE;
        isWithheld = true;
        withheldNote = WITHHELD_KNOWLEDGE_GAP_NOTE;
        if (scoringLifecycle?.gapResolutionRequestId) {
          await alertGapResolutionQueue(env, ctx, page, message,
            knowledgeGapMissing !== null ? "knowledge_gap" : "scr_low_confidence");
        }
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
      isWithheld = true;
      withheldNote = WITHHELD_KNOWLEDGE_GAP_NOTE;
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
  }

  return { response, routeId: scoringLifecycle?.routeId ?? null, hedgeShown, isWithheld, withheldNote };
}

// Assembles the per-subpart results of a decomposed compound question into
// one coherent reply: supported subparts are delivered as generated, withheld
// subparts are stated truthfully in place (no fabricated partial answer, no
// repeated full contact-pitch boilerplate), and a single combined contact
// invitation is appended once at the end if any subpart needs follow-up —
// matching the completion prompt's item C acceptance criteria directly.
function assembleCompoundReply(turnResults) {
  const bodyParts = turnResults.map((t) =>
    t.isWithheld ? `On the other part: ${t.withheldNote}.` : t.response
  );
  let assembled = bodyParts.join(" ");
  if (turnResults.some((t) => t.isWithheld)) {
    assembled += ` Want to leave your contact info on the part(s) I couldn't answer? ` +
      `Ed will follow up personally. You can also reach him directly at ${ADMIN_EMAIL}.`;
  }
  return assembled;
}

async function handleChat(request, env, ctx, corsHeaders, source = "visitor_chat") {
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
  const [pageRow, globalRow, constitutionRows] = await Promise.all([
	supabaseFetch(env, "system_prompt", `?page=eq.${encodeURIComponent(page)}&select=content`),
	supabaseFetch(env, "system_prompt", `?page=eq.all&select=content`),
	supabaseFetch(env, "constitution_provisions", `?select=provision_number,title,current_text&order=provision_number.asc`),
  ]);
  const pagePromptContent   = pageRow?.[0]?.content ?? "";
  const globalPromptContent = globalRow?.[0]?.content ?? "";
  const systemPromptContent = [globalPromptContent, pagePromptContent].filter(Boolean).join("\n\n");

  const qaPairs             = await supabaseFetch(env, "qa_pairs",
	`?select=question,answer&or=(page.eq.all,page.eq.${encodeURIComponent(page)})&order=created_at.asc`);

  // ── Phase E completion, item A ───────────────────────────────────────────
  // constitutionSection is used two ways, and they must not be confused:
  //   1. Passed separately into handleSingleTurn() for the bounded
  //      constitutional-ELIGIBILITY review (item B), which runs BEFORE any
  //      generation and BEFORE SCR. That is the actual eligibility boundary.
  //   2. Prepended into combinedPrompt below purely as governing CONTEXT for
  //      generation, once a question has already cleared that eligibility
  //      review — this is not itself an eligibility check, and generation is
  //      never asked to flag or decide a constitutional question.
  // Either way, the Constitution is superior to the operational corpus
  // (system_prompt + qa_pairs), never merged into or overridden by it. SCR's
  // own input contract is unaffected: SCR still receives only the literal
  // QUESTION + candidate ANSWER, never this prompt.
  const constitutionSection = buildConstitutionSection(constitutionRows);
  let combinedPrompt = constitutionSection
	? constitutionSection + "\n\n" + buildSystemPrompt(systemPromptContent, qaPairs)
	: buildSystemPrompt(systemPromptContent, qaPairs);
  combinedPrompt += KNOWLEDGE_GAP_INSTRUCTION;
  if (config.mode === "testing") combinedPrompt += TESTING_LAYER;

  const hoursText = await getTodayOfficeHoursText(env);
  if (hoursText) combinedPrompt = hoursText + "\n\n" + combinedPrompt;

  // ── Phase E completion, item C ────────────────────────────────────────────
  // Compound-question handling is a lightweight orchestration loop over the
  // existing single-question path (handleSingleTurn), not a new agent or an
  // SCR/SCA redesign. The common case (a single question) never invokes the
  // decomposition helper's model call — see COMPOUND_HINT_PATTERN.
  const subparts = await decomposeIfCompound(env, message);

  let response;
  let primaryRouteId = null;
  let primaryHedgeShown = false;

  if (!subparts) {
	const turn = await handleSingleTurn(env, ctx, config, constitutionSection, combinedPrompt, message, history, page, session_id, source);
	response = turn.response;
	primaryRouteId = turn.routeId;
	primaryHedgeShown = turn.hedgeShown;
  } else {
	const turnResults = [];
	for (const subpart of subparts) {
	  // Sequential, not parallel: each subpart is an independent lifecycle
	  // write (questions/candidate_answers/scores/routes rows), and keeping
	  // them sequential keeps that bookkeeping simple and avoids concurrent
	  // writes racing against the same session/rate-limit state.
	  turnResults.push(await handleSingleTurn(env, ctx, config, constitutionSection, combinedPrompt, subpart, history, page, session_id, source));
	}
	response = assembleCompoundReply(turnResults);
	// For session-capture/delivered-response bookkeeping below, treat the
	// first subpart's route as primary — each subpart already recorded its
	// own full lifecycle row independently above.
	primaryRouteId = turnResults[0]?.routeId ?? null;
	primaryHedgeShown = turnResults.some((t) => t.hedgeShown);
	for (const t of turnResults) {
	  if (t.routeId) {
		try {
		  await recordDeliveredResponse(env, t.routeId, response, t.hedgeShown);
		} catch (e) {
		  console.error("Phase D response persistence failed (compound subpart):", e);
		}
	  }
	}
  }

  if (!subparts && primaryRouteId) {
	try {
	  await recordDeliveredResponse(env, primaryRouteId, response, primaryHedgeShown);
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
  // Capture the response actually delivered after Phase D/E routing.
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

export { handleChat, handleSingleTurn, captureSession, RESOLVE_GAP_MESSAGE, CONSTITUTIONAL_HOLD_MESSAGE };

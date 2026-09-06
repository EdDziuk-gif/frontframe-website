import { jsonResponse } from "../shared/http.js";
import { supabaseFetch, supabasePost, supabasePatch, supabaseDelete, supabaseRpc } from "../shared/supabase.js";
import { callAnthropic, buildConstitutionSection } from "../shared/runtime.js";
import { checkConstitutionalEligibility, scoreCandidateAnswer } from "../shared/scoring.js";
import { getReviewerAuthority } from "./constitution.js";

// § DOMAIN: kgr-cases (Phase F Candidate 2, Increment 2)
// ════════════════════════════════════════════════════════════════════════
//
// Durable case-development record for an authorized gap_resolution_requests
// row (Increment 1). Records research, hypotheses, tests, and dispositions
// so a case can be resumed without reconstructing it from chat history.
//
// Explicitly NOT built here: resolution statements, scoring of accepted
// hypotheses, sign-off/selection, promulgation, or any notification on a
// case-status change. Those are later, separately-approved increments.
// /develop makes exactly one model call per invocation and writes nothing -
// no background loop, no chained follow-up call.

const CASE_MANAGEMENT_ONLY_ROLES = ["frontframe_admin"];
const CASE_DEVELOPMENT_ROLES     = ["frontframe_admin", "frontframe_staff"];

const KGR_DEVELOP_SYSTEM_PROMPT = `You are assisting a FrontFrame reviewer developing a Knowledge-Gap Resolution case.

You are given the original visitor question, any research notes recorded so far, and any hypotheses already proposed with their status. Your job is bounded: help the reviewer think through the gap.

Respond with plain text only - a short assessment of what's known, what's still open, and (if warranted) a candidate hypothesis the reviewer could choose to record themselves. You are not authorized to decide the answer, and nothing you write here is stored automatically. The reviewer reads your response and, if they agree with it, records a hypothesis themselves through their own action - your text is never persisted as a hypothesis directly.

Do not fabricate FrontFrame-specific facts, commitments, or guarantees not already present in the research notes or hypotheses given to you.`;

async function requireCaseAuthority(env, userJwt, allowedRoles, corsHeaders) {
  const authority = await getReviewerAuthority(env, userJwt);
  if (!authority) return { ok: false, response: jsonResponse({ error: "Unauthorized" }, 401, corsHeaders) };
  if (!allowedRoles.includes(authority.role))
    return { ok: false, response: jsonResponse({ error: "Insufficient authority" }, 403, corsHeaders) };
  return { ok: true, authority };
}

async function fetchCase(env, id) {
  const rows = await supabaseFetch(env, "kgr_cases",
    `?id=eq.${id}&select=id,gap_resolution_request_id,status,research_notes,escalation_reason,created_by,created_at,updated_at,gap_resolution_requests(questions(question_text))`);
  return rows?.[0] ?? null;
}

async function fetchHypotheses(env, caseId) {
  return (await supabaseFetch(env, "kgr_hypotheses",
    `?kgr_case_id=eq.${caseId}&select=id,description,status,test_notes,created_by,created_at,updated_at&order=created_at.asc`)) ?? [];
}

// Phase F Candidate 2, Increment 3 — resolution statement preparation.
async function fetchResolutionStatement(env, caseId) {
  const rows = await supabaseFetch(env, "kgr_resolution_statements",
    `?kgr_case_id=eq.${caseId}&select=id,kgr_case_id,problem_statement,prepared_by,created_at,selected_candidate_id,signed_off_by,signed_off_at,qa_pair_id,kgr_resolution_candidates!kgr_resolution_candidates_kgr_resolution_statement_id_fkey(id,kgr_hypothesis_id,presented_content,score,rationale)`);
  return rows?.[0] ?? null;
}

// ── Case creation and reads ─────────────────────────────────────────────────

// Management-only (REQ-KGR-02's authorization act and case creation are the
// same continuous Management action). One-to-one/idempotent: a UNIQUE
// constraint on gap_resolution_request_id backs this at the database level;
// a repeat call for the same intake row returns the existing case (409)
// rather than a duplicate row or a raw constraint error.
async function createKgrCase(request, env, userJwt, corsHeaders) {
  const auth = await requireCaseAuthority(env, userJwt, CASE_MANAGEMENT_ONLY_ROLES, corsHeaders);
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => ({}));
  const gapRequestId = body.gap_resolution_request_id;
  if (!gapRequestId) return jsonResponse({ error: "gap_resolution_request_id is required" }, 400, corsHeaders);

  const parentRows = await supabaseFetch(env, "gap_resolution_requests",
    `?id=eq.${gapRequestId}&select=id,authorized_at`);
  const parent = parentRows?.[0];
  if (!parent) return jsonResponse({ error: "gap_resolution_requests row not found" }, 404, corsHeaders);
  if (!parent.authorized_at) return jsonResponse({ error: "Intake row is not authorized" }, 403, corsHeaders);

  const existingRows = await supabaseFetch(env, "kgr_cases",
    `?gap_resolution_request_id=eq.${gapRequestId}&select=id`);
  if (existingRows?.length) {
    const existing = await fetchCase(env, existingRows[0].id);
    return jsonResponse({ error: "A case already exists for this intake row", case: existing }, 409, corsHeaders);
  }

  const inserted = await supabasePost(env, "kgr_cases", {
    gap_resolution_request_id: gapRequestId,
    status: "in_development",
    created_by: auth.authority.id,
  });
  const caseId = inserted?.[0]?.id;
  if (!caseId) throw new Error("Failed to create kgr_cases row");
  return jsonResponse(await fetchCase(env, caseId), 200, corsHeaders);
}

async function listKgrCases(env, userJwt, corsHeaders) {
  const auth = await requireCaseAuthority(env, userJwt, CASE_DEVELOPMENT_ROLES, corsHeaders);
  if (!auth.ok) return auth.response;
  const rows = await supabaseFetch(env, "kgr_cases",
    "?select=id,gap_resolution_request_id,status,research_notes,escalation_reason,created_by,created_at,updated_at,gap_resolution_requests(questions(question_text))&order=created_at.desc");
  return jsonResponse(rows ?? [], 200, corsHeaders);
}

async function getKgrCase(env, id, userJwt, corsHeaders) {
  const auth = await requireCaseAuthority(env, userJwt, CASE_DEVELOPMENT_ROLES, corsHeaders);
  if (!auth.ok) return auth.response;
  const kgrCase = await fetchCase(env, id);
  if (!kgrCase) return jsonResponse({ error: "Not found" }, 404, corsHeaders);
  const hypotheses = await fetchHypotheses(env, id);
  const resolutionStatement = await fetchResolutionStatement(env, id);
  return jsonResponse({ ...kgrCase, hypotheses, resolution_statement: resolutionStatement }, 200, corsHeaders);
}

// ── Case development (Management or Staff) ──────────────────────────────────

async function updateKgrCase(request, env, id, userJwt, corsHeaders) {
  const auth = await requireCaseAuthority(env, userJwt, CASE_DEVELOPMENT_ROLES, corsHeaders);
  if (!auth.ok) return auth.response;

  const kgrCase = await fetchCase(env, id);
  if (!kgrCase) return jsonResponse({ error: "Not found" }, 404, corsHeaders);
  if (kgrCase.status !== "in_development")
    return jsonResponse({ error: `Case is frozen (status '${kgrCase.status}') and cannot be edited` }, 409, corsHeaders);

  const body = await request.json().catch(() => ({}));
  if (typeof body.research_notes !== "string")
    return jsonResponse({ error: "research_notes (string) is required" }, 400, corsHeaders);

  const updated = await supabasePatch(env, "kgr_cases", id, {
    research_notes: body.research_notes,
    updated_at: new Date().toISOString(),
  });
  return jsonResponse(updated, 200, corsHeaders);
}

async function addHypothesis(request, env, id, userJwt, corsHeaders) {
  const auth = await requireCaseAuthority(env, userJwt, CASE_DEVELOPMENT_ROLES, corsHeaders);
  if (!auth.ok) return auth.response;

  const kgrCase = await fetchCase(env, id);
  if (!kgrCase) return jsonResponse({ error: "Not found" }, 404, corsHeaders);
  if (kgrCase.status !== "in_development")
    return jsonResponse({ error: `Case is frozen (status '${kgrCase.status}') and cannot take new hypotheses` }, 409, corsHeaders);

  const body = await request.json().catch(() => ({}));
  if (typeof body.description !== "string" || !body.description.trim())
    return jsonResponse({ error: "description (non-empty string) is required" }, 400, corsHeaders);

  const inserted = await supabasePost(env, "kgr_hypotheses", {
    kgr_case_id: id,
    description: body.description.trim(),
    status: "untested",
    created_by: auth.authority.id,
  });
  return jsonResponse(inserted, 200, corsHeaders);
}

async function updateHypothesis(request, env, id, hid, userJwt, corsHeaders) {
  const auth = await requireCaseAuthority(env, userJwt, CASE_DEVELOPMENT_ROLES, corsHeaders);
  if (!auth.ok) return auth.response;

  const kgrCase = await fetchCase(env, id);
  if (!kgrCase) return jsonResponse({ error: "Case not found" }, 404, corsHeaders);
  if (kgrCase.status !== "in_development")
    return jsonResponse({ error: `Case is frozen (status '${kgrCase.status}') and its hypotheses cannot be edited` }, 409, corsHeaders);

  const body = await request.json().catch(() => ({}));
  if (!["falsified", "accepted"].includes(body.status))
    return jsonResponse({ error: "status must be 'falsified' or 'accepted'" }, 400, corsHeaders);

  // Test/disposition notes are mandatory on a disposition, not optional
  // color: they are the only record of why a hypothesis was accepted or
  // falsified, and - when a hypothesis is being replaced by a better one -
  // the only place that traceably names the replacement (there is no
  // separate "replaced" status; replacing means falsifying the old
  // hypothesis with notes identifying the new one, then adding it).
  if (typeof body.test_notes !== "string" || !body.test_notes.trim())
    return jsonResponse(
      { error: `test_notes (non-blank) is required when marking a hypothesis '${body.status}' - if this replaces the hypothesis, name the replacement in the notes` },
      400,
      corsHeaders
    );

  const hypRows = await supabaseFetch(env, "kgr_hypotheses", `?id=eq.${hid}&kgr_case_id=eq.${id}&select=id,status`);
  const hyp = hypRows?.[0];
  if (!hyp) return jsonResponse({ error: "Hypothesis not found on this case" }, 404, corsHeaders);
  if (hyp.status !== "untested")
    return jsonResponse({ error: `Hypothesis is already '${hyp.status}' and cannot be changed again` }, 409, corsHeaders);

  const updated = await supabasePatch(env, "kgr_hypotheses", hid, {
    status: body.status,
    test_notes: body.test_notes.trim(),
    updated_at: new Date().toISOString(),
  });
  return jsonResponse(updated, 200, corsHeaders);
}

// ── Readiness and escalation ────────────────────────────────────────────────

// Rejects unless zero hypotheses are untested AND at least one is accepted -
// both halves of the constraint enforced together, server-side.
async function readyKgrCase(env, id, userJwt, corsHeaders) {
  const auth = await requireCaseAuthority(env, userJwt, CASE_DEVELOPMENT_ROLES, corsHeaders);
  if (!auth.ok) return auth.response;

  const kgrCase = await fetchCase(env, id);
  if (!kgrCase) return jsonResponse({ error: "Not found" }, 404, corsHeaders);
  if (kgrCase.status !== "in_development")
    return jsonResponse({ error: `Case is already '${kgrCase.status}'` }, 409, corsHeaders);

  const hypotheses = await fetchHypotheses(env, id);
  const hasUntested = hypotheses.some((h) => h.status === "untested");
  const hasAccepted = hypotheses.some((h) => h.status === "accepted");
  if (hasUntested) return jsonResponse({ error: "Case has untested hypotheses" }, 409, corsHeaders);
  if (!hasAccepted) return jsonResponse({ error: "Case has no accepted hypothesis" }, 409, corsHeaders);

  const updated = await supabasePatch(env, "kgr_cases", id, {
    status: "ready_for_decision",
    updated_at: new Date().toISOString(),
  });
  return jsonResponse(updated, 200, corsHeaders);
}

// Terminal for this increment: no route moves a case out of 'escalated'.
// A non-candidate result makes no state change - this only lets a reviewer
// check and record an escalation when the boundary is actually hit, it
// doesn't force one.
async function escalateKgrCase(env, id, userJwt, corsHeaders) {
  const auth = await requireCaseAuthority(env, userJwt, CASE_DEVELOPMENT_ROLES, corsHeaders);
  if (!auth.ok) return auth.response;

  const kgrCase = await fetchCase(env, id);
  if (!kgrCase) return jsonResponse({ error: "Not found" }, 404, corsHeaders);
  if (kgrCase.status !== "in_development")
    return jsonResponse({ error: `Case is already '${kgrCase.status}'` }, 409, corsHeaders);

  const hypotheses = await fetchHypotheses(env, id);
  const caseText = [kgrCase.research_notes, ...hypotheses.map((h) => h.description)]
    .filter(Boolean).join("\n\n");

  const provisions = await supabaseFetch(env, "constitution_provisions",
    "?select=provision_number,title,current_text&order=provision_number.asc");
  const constitutionSection = buildConstitutionSection(provisions);

  const result = await checkConstitutionalEligibility(env, constitutionSection, caseText);
  if (!result.constitutionalCandidate)
    return jsonResponse({ escalated: false, ...result }, 200, corsHeaders);

  const updated = await supabasePatch(env, "kgr_cases", id, {
    status: "escalated",
    escalation_reason: result.issue,
    updated_at: new Date().toISOString(),
  });
  return jsonResponse({ escalated: true, case: updated }, 200, corsHeaders);
}

// ── Resolution statement preparation (Management or Staff) ────────────────
//
// Turns a ready_for_decision case into a durable resolution statement: the
// original question, each accepted hypothesis's explicitly-submitted
// presented content, its appropriateness score + rationale (via the
// existing scoreCandidateAnswer(), unmodified), and the server-derived
// preparer. Does not select, sign off, or promulgate - that is later,
// separately-approved scope.
async function prepareResolutionStatement(request, env, id, userJwt, corsHeaders) {
  const auth = await requireCaseAuthority(env, userJwt, CASE_DEVELOPMENT_ROLES, corsHeaders);
  if (!auth.ok) return auth.response;

  const kgrCase = await fetchCase(env, id);
  if (!kgrCase) return jsonResponse({ error: "Case not found" }, 404, corsHeaders);
  if (kgrCase.status !== "ready_for_decision")
    return jsonResponse(
      { error: `Case must be 'ready_for_decision' to prepare a resolution statement (is '${kgrCase.status}')` },
      409,
      corsHeaders
    );

  // Idempotent: a completed repeat request returns the existing statement
  // without rescoring - no model call happens on this path.
  const existingStatement = await fetchResolutionStatement(env, id);
  if (existingStatement)
    return jsonResponse(
      { error: "A resolution statement already exists for this case", resolution_statement: existingStatement },
      409,
      corsHeaders
    );

  const body = await request.json().catch(() => ({}));
  const submitted = Array.isArray(body.candidates) ? body.candidates : null;
  if (!submitted || !submitted.length)
    return jsonResponse({ error: "candidates (non-empty array) is required" }, 400, corsHeaders);

  const hypotheses = await fetchHypotheses(env, id);
  const acceptedIds = hypotheses.filter((h) => h.status === "accepted").map((h) => h.id);
  const acceptedIdSet = new Set(acceptedIds);

  const submittedIds = submitted.map((c) => Number(c.hypothesis_id));
  const submittedIdSet = new Set(submittedIds);
  if (submittedIdSet.size !== submittedIds.length)
    return jsonResponse({ error: "candidates contains a duplicate hypothesis_id" }, 400, corsHeaders);
  if (
    submittedIdSet.size !== acceptedIdSet.size ||
    ![...acceptedIdSet].every((aid) => submittedIdSet.has(aid))
  )
    return jsonResponse(
      { error: "candidates must include exactly the case's accepted hypotheses - no more, no fewer, none falsified or untested" },
      400,
      corsHeaders
    );

  for (const c of submitted) {
    if (typeof c.presented_content !== "string" || !c.presented_content.trim())
      return jsonResponse({ error: "presented_content (non-blank) is required for every candidate" }, 400, corsHeaders);
  }

  const problemStatement =
    kgrCase.gap_resolution_requests?.questions?.question_text ?? `Request #${kgrCase.gap_resolution_request_id}`;

  // Score every candidate in memory first. If any call fails, nothing has
  // been written yet, so there is nothing to roll back.
  const scoredCandidates = [];
  for (const c of submitted) {
    const hypothesisId = Number(c.hypothesis_id);
    const presentedContent = c.presented_content.trim();
    let result;
    try {
      result = await scoreCandidateAnswer(env, problemStatement, presentedContent);
    } catch (e) {
      return jsonResponse({ error: `Scoring failed for hypothesis ${hypothesisId}: ${e.message}` }, 502, corsHeaders);
    }
    scoredCandidates.push({
      hypothesis_id: hypothesisId,
      presented_content: presentedContent,
      score: result.score,
      rationale: result.rationale,
    });
  }

  // Persist the statement and every candidate in one atomic transaction
  // (save_kgr_resolution_statement, migration 006). The UNIQUE constraint on
  // kgr_resolution_statements.kgr_case_id is what actually prevents two
  // simultaneous requests from both succeeding; a losing concurrent request
  // gets a unique_violation here, which is treated the same as the ordinary
  // idempotent-repeat case above - the winner's statement is returned, not
  // a raw error.
  try {
    await supabaseRpc(env, "save_kgr_resolution_statement", {
      p_case_id: Number(id),
      p_problem_statement: problemStatement,
      p_prepared_by: auth.authority.id,
      p_candidates: scoredCandidates,
    });
  } catch (e) {
    const raceLoserStatement = await fetchResolutionStatement(env, id);
    if (raceLoserStatement)
      return jsonResponse(
        { error: "A resolution statement already exists for this case", resolution_statement: raceLoserStatement },
        409,
        corsHeaders
      );
    throw e;
  }

  const saved = await fetchResolutionStatement(env, id);
  return jsonResponse(saved, 200, corsHeaders);
}

// ── Model assistance: exactly one explicit call, writes nothing ────────────

async function developKgrCase(env, id, userJwt, corsHeaders) {
  const auth = await requireCaseAuthority(env, userJwt, CASE_DEVELOPMENT_ROLES, corsHeaders);
  if (!auth.ok) return auth.response;

  const kgrCase = await fetchCase(env, id);
  if (!kgrCase) return jsonResponse({ error: "Not found" }, 404, corsHeaders);
  if (kgrCase.status !== "in_development")
    return jsonResponse({ error: `Case is '${kgrCase.status}' - development assistance is only available while in_development` }, 409, corsHeaders);

  const hypotheses = await fetchHypotheses(env, id);
  const originQuestionRows = await supabaseFetch(env, "gap_resolution_requests",
    `?id=eq.${kgrCase.gap_resolution_request_id}&select=questions(question_text)`);
  const question = originQuestionRows?.[0]?.questions?.question_text ?? "(question unavailable)";

  const context = [
    `VISITOR QUESTION:\n${question}`,
    `RESEARCH NOTES:\n${kgrCase.research_notes ?? "(none yet)"}`,
    `HYPOTHESES:\n${hypotheses.length
      ? hypotheses.map((h) => `- [${h.status}] ${h.description}${h.test_notes ? ` (notes: ${h.test_notes})` : ""}`).join("\n")
      : "(none yet)"}`,
  ].join("\n\n");

  const responseText = await callAnthropic(env, KGR_DEVELOP_SYSTEM_PROMPT, [
    { role: "user", content: context },
  ]);

  // Writes nothing - text only, per the agreed resolution: the reviewer
  // records a hypothesis themselves via addHypothesis if they agree with it.
  return jsonResponse({ response: responseText }, 200, corsHeaders);
}


// ── Sign-off (Management only) ──────────────────────────────────────────────
//
// Selects one candidate from a prepared resolution statement, records the
// decision, prunes the unselected candidates and their now-unused
// hypotheses, and publishes the selected candidate's content as a new
// qa_pairs row - all in one atomic transaction (sign_off_kgr_resolution,
// migration 007). Mirrors escalateKgrCase's exact pattern for building the
// constitution section and calling checkConstitutionalEligibility: the
// same provisions fetch, the same buildConstitutionSection() call, the same
// result.constitutionalCandidate field, the same result.issue field.
async function signOffKgrResolution(request, env, id, userJwt, corsHeaders) {
  const auth = await requireCaseAuthority(env, userJwt, CASE_MANAGEMENT_ONLY_ROLES, corsHeaders);
  if (!auth.ok) return auth.response;

  const kgrCase = await fetchCase(env, id);
  if (!kgrCase) return jsonResponse({ error: "Case not found" }, 404, corsHeaders);
  if (kgrCase.status !== "ready_for_decision")
    return jsonResponse(
      { error: `Case must be 'ready_for_decision' to sign off a resolution (is '${kgrCase.status}')` },
      409,
      corsHeaders
    );

  const resolutionStatement = await fetchResolutionStatement(env, id);
  if (!resolutionStatement)
    return jsonResponse({ error: "No resolution statement exists for this case" }, 404, corsHeaders);
  if (resolutionStatement.signed_off_at)
    return jsonResponse(
      { error: "This resolution statement has already been signed off", resolution_statement: resolutionStatement },
      409,
      corsHeaders
    );

  const body = await request.json().catch(() => ({}));
  const candidateId = body.candidate_id;
  const candidates = resolutionStatement.kgr_resolution_candidates ?? [];
  const selectedCandidate = candidates.find((c) => c.id === candidateId);
  if (candidateId === undefined || candidateId === null || !selectedCandidate)
    return jsonResponse({ error: "candidate_id must be one of this statement's candidates" }, 400, corsHeaders);

  const caseText = [resolutionStatement.problem_statement, selectedCandidate.presented_content]
    .filter(Boolean).join("\n\n");

  const provisions = await supabaseFetch(env, "constitution_provisions",
    "?select=provision_number,title,current_text&order=provision_number.asc");
  const constitutionSection = buildConstitutionSection(provisions);

  const eligibility = await checkConstitutionalEligibility(env, constitutionSection, caseText);
  if (eligibility.constitutionalCandidate)
    return jsonResponse(
      {
        error:
          "This resolution appears to raise a constitutional question and cannot be signed off operationally. FrontFrame's KGR escalation path only applies before a case reaches this stage, so no automated next step exists here - bring this case to the Operator directly for constitutional review.",
        issue: eligibility.issue,
      },
      409,
      corsHeaders
    );

  try {
    await supabaseRpc(env, "sign_off_kgr_resolution", {
      p_statement_id: resolutionStatement.id,
      p_candidate_id: candidateId,
      p_signed_off_by: auth.authority.id,
    });
  } catch (e) {
    if (String(e.message).includes("already signed off")) {
      const raceLoserStatement = await fetchResolutionStatement(env, id);
      return jsonResponse(
        { error: "This resolution statement has already been signed off", resolution_statement: raceLoserStatement },
        409,
        corsHeaders
      );
    }
    // Any other RPC error (e.g. "candidate % does not belong to statement %",
    // which the RPC's own candidate-existence check throws when a losing
    // concurrent sign-off's candidate was pruned by the winner before this
    // call began) may still mean the same thing as "already signed off":
    // someone else won this race. Re-fetch and check rather than assuming -
    // if the statement is now signed off, treat this identically to the
    // already-signed-off race-loser case above. If it is NOT signed off,
    // this is a genuine unrelated error and must not be swallowed.
    const raceCheckStatement = await fetchResolutionStatement(env, id);
    if (raceCheckStatement?.signed_off_at) {
      return jsonResponse(
        { error: "This resolution statement has already been signed off", resolution_statement: raceCheckStatement },
        409,
        corsHeaders
      );
    }
    throw e;
  }

  const finalCase = await fetchCase(env, id);
  const hypotheses = await fetchHypotheses(env, id);
  const finalStatement = await fetchResolutionStatement(env, id);
  return jsonResponse({ ...finalCase, hypotheses, resolution_statement: finalStatement }, 200, corsHeaders);
}

// ── Falsified-hypothesis review (pruning outside the sign-off transaction) ──

async function listFalsifiedHypotheses(request, env, userJwt, corsHeaders) {
  const auth = await requireCaseAuthority(env, userJwt, CASE_DEVELOPMENT_ROLES, corsHeaders);
  if (!auth.ok) return auth.response;
  const rows = await supabaseFetch(env, "kgr_hypotheses",
    "?status=eq.falsified&select=id,description,test_notes,created_at,kgr_case_id,kgr_cases(gap_resolution_requests(questions(question_text)))&order=created_at.desc");
  return jsonResponse(rows ?? [], 200, corsHeaders);
}

async function deleteFalsifiedHypothesis(env, id, userJwt, corsHeaders) {
  const auth = await requireCaseAuthority(env, userJwt, CASE_MANAGEMENT_ONLY_ROLES, corsHeaders);
  if (!auth.ok) return auth.response;

  const rows = await supabaseFetch(env, "kgr_hypotheses", `?id=eq.${id}&select=id,status`);
  const hyp = rows?.[0];
  if (!hyp) return jsonResponse({ error: "Not found" }, 404, corsHeaders);
  if (hyp.status !== "falsified")
    return jsonResponse(
      { error: `Only falsified hypotheses can be pruned this way (status is '${hyp.status}')` },
      409,
      corsHeaders
    );

  await supabaseDelete(env, "kgr_hypotheses", id);
  return jsonResponse({ deleted: id }, 200, corsHeaders);
}

export {
  createKgrCase, listKgrCases, getKgrCase, updateKgrCase,
  addHypothesis, updateHypothesis, readyKgrCase, escalateKgrCase, developKgrCase,
  prepareResolutionStatement, signOffKgrResolution, listFalsifiedHypotheses, deleteFalsifiedHypothesis,
};

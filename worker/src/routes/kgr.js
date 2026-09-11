import { jsonResponse } from "../shared/http.js";
import { supabaseFetch, supabasePost, supabaseDelete, supabaseRpc } from "../shared/supabase.js";
import { callAnthropic, buildConstitutionSection } from "../shared/runtime.js";
import { checkConstitutionalEligibility, scoreCandidateAnswer } from "../shared/scoring.js";
import { getReviewerAuthority } from "./constitution.js";

// Phase F Candidate 2, Increment 5 — human-contributed candidate solutions.
// A contributed solution runs the same rigor an assistant candidate does:
// checkConstitutionalEligibility() then scoreCandidateAnswer(), synchronously,
// before it is persisted. The atomic recheck-and-insert is submit_kgr_solution
// (migration 011); readiness, preparation and sign-off are the guarded RPCs
// ready_kgr_case / prepare_kgr_resolution_statement / sign_off_kgr_resolution
// (migrations 011-012), each serialized on the kgr_cases row.

const SOLUTION_ORIGINS = ["human", "assistant_assisted"];

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

// Deploy-window switch (amendment 7). A runtime toggle held in KV, read per
// request - no redeploy to flip, and no DB hit on the mutation path. While the
// key "kgr_mutations_paused" is "true", every KGR *mutation* handler returns
// 503; reads and /develop are unaffected. Set/clear with:
//   wrangler kv key put   --binding=RATE_LIMIT_KV kgr_mutations_paused true
//   wrangler kv key delete --binding=RATE_LIMIT_KV kgr_mutations_paused
//
// This is a maintenance gate, so it FAILS CLOSED: if the pause state cannot be
// read (KV binding missing, or the read throws) the mutation is refused with
// 503. A successful read that returns nothing (key absent) is the normal
// not-paused case and proceeds. Returns a Response to short-circuit with, or
// null to proceed.
async function kgrMutationGate(env, corsHeaders) {
  const kv = env.RATE_LIMIT_KV;
  const blocked = (msg) => jsonResponse({ error: msg }, 503, corsHeaders);
  if (!kv || typeof kv.get !== "function") {
    return blocked("KGR mutation gate is unavailable (no KV binding); mutation refused.");
  }
  let paused;
  try {
    paused = await kv.get("kgr_mutations_paused");
  } catch {
    return blocked("KGR mutation gate check failed; mutation refused, try again shortly.");
  }
  if (paused === "true" || paused === "1") {
    return blocked("KGR mutations are temporarily paused for a deployment. Reads are unaffected; try again shortly.");
  }
  return null;
}

// Reproducible identifier for the constitution provisions a check ran against -
// provenance for the screen result, not a claim it stays current.
async function provisionsHash(constitutionSection) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(constitutionSection || ""));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

async function fetchConstitutionSection(env) {
  const provisions = await supabaseFetch(env, "constitution_provisions",
    "?select=provision_number,title,current_text&order=provision_number.asc");
  return buildConstitutionSection(provisions);
}

// supabaseRpc throws `Supabase RPC <fn> failed: <PostgREST body>`, and the body
// is usually JSON ({code,message,...}). Pull out the human-readable message a
// RAISE EXCEPTION in the function produced, so it can be shown to a reviewer
// instead of a raw error envelope.
function rpcErrMessage(e) {
  const stripped = String(e?.message ?? "").replace(/^Supabase RPC [^:]+ failed:\s*/, "");
  try {
    const parsed = JSON.parse(stripped);
    return (parsed && (parsed.message || parsed.error || parsed.details)) || stripped;
  } catch {
    return stripped;
  }
}

async function fetchSolutions(env, caseId) {
  return (await supabaseFetch(env, "kgr_candidate_solutions",
    `?kgr_case_id=eq.${caseId}&select=id,kgr_hypothesis_id,proposed_content,submitted_by,origin,score,rationale,constitutional_provisions_hash,problem_snapshot,status,withdrawn_by,withdrawn_reason,withdrawn_at,created_at&order=created_at.asc`)) ?? [];
}

const CASE_SELECT =
  "id,gap_resolution_request_id,status,research_notes,escalation_reason," +
  "resolution_target,supersedes_qa_pair_id,target_system_prompt_page,target_revision," +
  "created_by,created_at,updated_at,gap_resolution_requests!kgr_cases_gap_resolution_request_id_fkey(questions(question_text))";

async function fetchCase(env, id) {
  const rows = await supabaseFetch(env, "kgr_cases", `?id=eq.${id}&select=${CASE_SELECT}`);
  return rows?.[0] ?? null;
}

async function fetchHypotheses(env, caseId) {
  return (await supabaseFetch(env, "kgr_hypotheses",
    `?kgr_case_id=eq.${caseId}&select=id,description,status,test_notes,created_by,created_at,updated_at&order=created_at.asc`)) ?? [];
}

// Phase F Candidate 2, Increment 3 — resolution statement preparation.
// Increment 5 adds the frozen provenance columns to the candidate embed
// (nullable: the one pre-Increment-5 snapshot row carries none).
async function fetchResolutionStatement(env, caseId) {
  const rows = await supabaseFetch(env, "kgr_resolution_statements",
    `?kgr_case_id=eq.${caseId}&select=id,kgr_case_id,problem_statement,prepared_by,created_at,selected_candidate_id,signed_off_by,signed_off_at,qa_pair_id,system_prompt_history_id,system_prompt_history!kgr_resolution_statements_system_prompt_history_id_fkey(page,adopted_content,prior_content_present,replaced_at),kgr_resolution_candidates!kgr_resolution_candidates_kgr_resolution_statement_id_fkey(id,kgr_hypothesis_id,presented_content,score,rationale,origin_solution_id,submitted_by,origin,constitutional_provisions_hash,problem_snapshot)`);
  return rows?.[0] ?? null;
}

// ── Case creation and reads ─────────────────────────────────────────────────

// "Start Case" — Staff or Management (migration 014 / decision 0036: this is the
// affirmative authorization REQ-KGR-02 requires; restricting it to Management was
// an unfounded assumption). The whole thing — reject resolved/escalated/has-a-
// case, stamp authorized_at/authorized_by if absent, insert exactly one case at
// the default target — is one transaction in the start_kgr_case RPC (migration
// 014), replacing the previous read-then-write. No target information in the
// body; the case starts at resolution_target='qa_pair'.
async function createKgrCase(request, env, userJwt, corsHeaders) {
  const auth = await requireCaseAuthority(env, userJwt, CASE_DEVELOPMENT_ROLES, corsHeaders);
  if (!auth.ok) return auth.response;
  const gate = await kgrMutationGate(env, corsHeaders);
  if (gate) return gate;

  const body = await request.json().catch(() => ({}));
  const gapRequestId = body.gap_resolution_request_id;
  if (!gapRequestId) return jsonResponse({ error: "gap_resolution_request_id is required" }, 400, corsHeaders);

  try {
    const out = await supabaseRpc(env, "start_kgr_case", {
      p_request_id: Number(gapRequestId),
      p_reviewer: auth.authority.id,
    });
    const row = Array.isArray(out) ? out[0] ?? null : out;
    const caseId = row?.id;
    if (!caseId) throw new Error("start_kgr_case returned no case");
    return jsonResponse(await fetchCase(env, caseId), 200, corsHeaders);
  } catch (e) {
    const msg = rpcErrMessage(e);
    const status = msg.includes("not found") ? 404
      : (msg.includes("already exists") || msg.includes("already resolved") || msg.includes("escalated")) ? 409
      : 400;
    return jsonResponse({ error: msg }, status, corsHeaders);
  }
}

// Set / change a case's resolution target while in_development (Staff or
// Management). One transaction in set_kgr_case_target (migration 014): takes the
// case-row lock, validates the combination, bumps target_revision, and deletes
// contributed solutions on a content-kind or prompt-page change.
async function setKgrCaseTarget(request, env, id, userJwt, corsHeaders) {
  const auth = await requireCaseAuthority(env, userJwt, CASE_DEVELOPMENT_ROLES, corsHeaders);
  if (!auth.ok) return auth.response;
  const gate = await kgrMutationGate(env, corsHeaders);
  if (gate) return gate;

  const body = await request.json().catch(() => ({}));
  const target = body.resolution_target;
  if (target !== "qa_pair" && target !== "system_prompt") {
    return jsonResponse({ error: "resolution_target must be 'qa_pair' or 'system_prompt'" }, 400, corsHeaders);
  }

  try {
    const out = await supabaseRpc(env, "set_kgr_case_target", {
      p_case_id: Number(id),
      p_target: target,
      p_supersedes_qa_pair_id: body.supersedes_qa_pair_id ?? null,
      p_sp_page: body.target_system_prompt_page ?? null,
      p_reviewer: auth.authority.id,
    });
    const row = Array.isArray(out) ? out[0] ?? null : out;
    return jsonResponse(await fetchCase(env, row?.id ?? id), 200, corsHeaders);
  } catch (e) {
    const msg = rpcErrMessage(e);
    const status = msg.includes("not found") ? 404 : msg.includes("in_development") ? 409 : 400;
    return jsonResponse({ error: msg }, status, corsHeaders);
  }
}

// Open a companion case: a second corpus target for one problem. Staff or
// Management, off an existing case's request. open_companion_case (migration
// 014) creates the linked question / route / gap_resolution_request / case.
async function openCompanionCase(request, env, id, userJwt, corsHeaders) {
  const auth = await requireCaseAuthority(env, userJwt, CASE_DEVELOPMENT_ROLES, corsHeaders);
  if (!auth.ok) return auth.response;
  const gate = await kgrMutationGate(env, corsHeaders);
  if (gate) return gate;

  // :id is the parent case; the RPC hangs the companion off that case's request.
  const parentCaseRows = await supabaseFetch(env, "kgr_cases",
    `?id=eq.${Number(id)}&select=gap_resolution_request_id`);
  const parentRequestId = parentCaseRows?.[0]?.gap_resolution_request_id;
  if (!parentRequestId) return jsonResponse({ error: "parent case not found" }, 404, corsHeaders);

  const body = await request.json().catch(() => ({}));
  const problemText = (body.problem_text ?? "").trim();
  if (!problemText) return jsonResponse({ error: "problem_text is required" }, 400, corsHeaders);

  try {
    const out = await supabaseRpc(env, "open_companion_case", {
      p_parent_request_id: Number(parentRequestId),
      p_problem_text: problemText,
      p_reviewer: auth.authority.id,
    });
    const row = Array.isArray(out) ? out[0] ?? null : out;
    if (!row?.case_id) throw new Error("open_companion_case returned no case");
    return jsonResponse(await fetchCase(env, row.case_id), 200, corsHeaders);
  } catch (e) {
    const msg = rpcErrMessage(e);
    return jsonResponse({ error: msg }, msg.includes("no case") ? 409 : 400, corsHeaders);
  }
}

// Which served, implemented qa_pairs are the replacement target of an OPEN case
// (no signed-off statement yet), for the given page scope. Consumed by chat.js
// to add the "under active review" caveat (plan §3.4a). Throws on error — the
// caller (chat.js) decides to serve without the caveat and log a defect.
async function underReviewQaPairIds(env, page) {
  const rows = await supabaseFetch(env, "kgr_cases",
    `?resolution_target=eq.qa_pair&supersedes_qa_pair_id=not.is.null` +
    `&select=supersedes_qa_pair_id,kgr_resolution_statements(signed_off_at)`);
  if (!Array.isArray(rows)) throw new Error("under-review lookup failed");
  const ids = new Set();
  for (const c of rows) {
    const stmts = c.kgr_resolution_statements;
    const signedOff = Array.isArray(stmts)
      ? stmts.some((s) => s.signed_off_at)
      : Boolean(stmts?.signed_off_at);
    if (!signedOff && c.supersedes_qa_pair_id) ids.add(c.supersedes_qa_pair_id);
  }
  if (ids.size === 0) return [];
  // Restrict to pairs actually served on this page scope.
  const list = [...ids].map((x) => `"${x}"`).join(",");
  const served = await supabaseFetch(env, "qa_pairs",
    `?id=in.(${list})&status=eq.implemented&or=(page.eq.all,page.eq.${encodeURIComponent(page)})&select=id`);
  return Array.isArray(served) ? served.map((r) => r.id) : [];
}

async function listKgrCases(env, userJwt, corsHeaders) {
  const auth = await requireCaseAuthority(env, userJwt, CASE_DEVELOPMENT_ROLES, corsHeaders);
  if (!auth.ok) return auth.response;
  const rows = await supabaseFetch(env, "kgr_cases",
    "?select=id,gap_resolution_request_id,status,research_notes,escalation_reason,created_by,created_at,updated_at,gap_resolution_requests!kgr_cases_gap_resolution_request_id_fkey(questions(question_text))&order=created_at.desc");
  return jsonResponse(rows ?? [], 200, corsHeaders);
}

async function getKgrCase(env, id, userJwt, corsHeaders) {
  const auth = await requireCaseAuthority(env, userJwt, CASE_DEVELOPMENT_ROLES, corsHeaders);
  if (!auth.ok) return auth.response;
  const kgrCase = await fetchCase(env, id);
  if (!kgrCase) return jsonResponse({ error: "Not found" }, 404, corsHeaders);
  const hypotheses = await fetchHypotheses(env, id);
  const resolutionStatement = await fetchResolutionStatement(env, id);
  const allSolutions = await fetchSolutions(env, id);
  const solutions = {
    active: allSolutions.filter((s) => s.status === "active"),
    withdrawn: allSolutions.filter((s) => s.status === "withdrawn"),
  };
  return jsonResponse({ ...kgrCase, hypotheses, solutions, resolution_statement: resolutionStatement }, 200, corsHeaders);
}

// ── Case development (Management or Staff) ──────────────────────────────────

async function updateKgrCase(request, env, id, userJwt, corsHeaders) {
  const auth = await requireCaseAuthority(env, userJwt, CASE_DEVELOPMENT_ROLES, corsHeaders);
  if (!auth.ok) return auth.response;
  const gate = await kgrMutationGate(env, corsHeaders);
  if (gate) return gate;

  const body = await request.json().catch(() => ({}));
  if (typeof body.research_notes !== "string")
    return jsonResponse({ error: "research_notes (string) is required" }, 400, corsHeaders);

  // Guarded write (migration 013): update_kgr_research_notes locks the case row
  // and rechecks in_development inside the transaction, so this cannot land on
  // a case another session has just frozen.
  try {
    const out = await supabaseRpc(env, "update_kgr_research_notes", {
      p_case_id: Number(id),
      p_notes: body.research_notes,
    });
    return jsonResponse(Array.isArray(out) ? out[0] ?? null : out, 200, corsHeaders);
  } catch (e) {
    const msg = rpcErrMessage(e);
    return jsonResponse({ error: msg }, msg.includes("not found") ? 404 : 409, corsHeaders);
  }
}

async function addHypothesis(request, env, id, userJwt, corsHeaders) {
  const auth = await requireCaseAuthority(env, userJwt, CASE_DEVELOPMENT_ROLES, corsHeaders);
  if (!auth.ok) return auth.response;
  const gate = await kgrMutationGate(env, corsHeaders);
  if (gate) return gate;

  const body = await request.json().catch(() => ({}));
  if (typeof body.description !== "string" || !body.description.trim())
    return jsonResponse({ error: "description (non-empty string) is required" }, 400, corsHeaders);

  // Guarded write (migration 013). created_by is server-derived.
  try {
    const out = await supabaseRpc(env, "add_kgr_hypothesis", {
      p_case_id: Number(id),
      p_description: body.description.trim(),
      p_created_by: auth.authority.id,
    });
    return jsonResponse(out, 200, corsHeaders);
  } catch (e) {
    const msg = rpcErrMessage(e);
    return jsonResponse({ error: msg }, msg.includes("not found") ? 404 : 409, corsHeaders);
  }
}

async function updateHypothesis(request, env, id, hid, userJwt, corsHeaders) {
  const auth = await requireCaseAuthority(env, userJwt, CASE_DEVELOPMENT_ROLES, corsHeaders);
  if (!auth.ok) return auth.response;
  const gate = await kgrMutationGate(env, corsHeaders);
  if (gate) return gate;

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

  // Guarded write (migration 013): dispose_kgr_hypothesis locks the case row,
  // rechecks in_development, verifies the hypothesis is on this case and still
  // untested, and disposes it - all in one transaction.
  try {
    const out = await supabaseRpc(env, "dispose_kgr_hypothesis", {
      p_case_id: Number(id),
      p_hypothesis_id: Number(hid),
      p_status: body.status,
      p_test_notes: body.test_notes.trim(),
    });
    return jsonResponse(Array.isArray(out) ? out[0] ?? null : out, 200, corsHeaders);
  } catch (e) {
    const msg = rpcErrMessage(e);
    return jsonResponse({ error: msg }, msg.includes("not on case") || msg.includes("not found") ? 404 : 409, corsHeaders);
  }
}

// ── Readiness and escalation ────────────────────────────────────────────────

// Increment 5: readiness is the guarded ready_kgr_case RPC (migration 011). It
// serializes on the case row and enforces, together, zero untested hypotheses,
// at least one accepted hypothesis, AND at least one active contributed
// solution for every accepted hypothesis (the coverage rule). Moving to
// ready_for_decision closes contributions.
async function readyKgrCase(env, id, userJwt, corsHeaders) {
  const auth = await requireCaseAuthority(env, userJwt, CASE_DEVELOPMENT_ROLES, corsHeaders);
  if (!auth.ok) return auth.response;
  const gate = await kgrMutationGate(env, corsHeaders);
  if (gate) return gate;

  const kgrCase = await fetchCase(env, id);
  if (!kgrCase) return jsonResponse({ error: "Not found" }, 404, corsHeaders);

  try {
    const rowsOut = await supabaseRpc(env, "ready_kgr_case", { p_case_id: Number(id) });
    return jsonResponse(Array.isArray(rowsOut) ? rowsOut[0] ?? null : rowsOut, 200, corsHeaders);
  } catch (e) {
    // Every guard failure in ready_kgr_case is a 409 (wrong status, untested
    // hypotheses, no accepted hypothesis, or an accepted hypothesis with no
    // active solution).
    return jsonResponse({ error: rpcErrMessage(e) }, 409, corsHeaders);
  }
}

// Terminal for this increment: no route moves a case out of 'escalated'.
// A non-candidate result makes no state change - this only lets a reviewer
// check and record an escalation when the boundary is actually hit, it
// doesn't force one.
async function escalateKgrCase(env, id, userJwt, corsHeaders) {
  const auth = await requireCaseAuthority(env, userJwt, CASE_DEVELOPMENT_ROLES, corsHeaders);
  if (!auth.ok) return auth.response;
  const gate = await kgrMutationGate(env, corsHeaders);
  if (gate) return gate;

  const kgrCase = await fetchCase(env, id);
  if (!kgrCase) return jsonResponse({ error: "Not found" }, 404, corsHeaders);
  if (kgrCase.status !== "in_development")
    return jsonResponse({ error: `Case is already '${kgrCase.status}'` }, 409, corsHeaders);

  const hypotheses = await fetchHypotheses(env, id);
  const caseText = [kgrCase.research_notes, ...hypotheses.map((h) => h.description)]
    .filter(Boolean).join("\n\n");

  const constitutionSection = await fetchConstitutionSection(env);

  const result = await checkConstitutionalEligibility(env, constitutionSection, caseText);
  if (!result.constitutionalCandidate)
    return jsonResponse({ escalated: false, ...result }, 200, corsHeaders);

  // Guarded write (migration 013): escalate_kgr_case locks the case row and
  // rechecks in_development inside the transaction.
  try {
    const out = await supabaseRpc(env, "escalate_kgr_case", {
      p_case_id: Number(id),
      p_reason: result.issue || "(not specified)",
    });
    const updated = Array.isArray(out) ? out[0] ?? null : out;
    return jsonResponse({ escalated: true, case: updated }, 200, corsHeaders);
  } catch (e) {
    const msg = rpcErrMessage(e);
    return jsonResponse({ error: msg }, msg.includes("not found") ? 404 : 409, corsHeaders);
  }
}

// ── Solution contribution (Management or Staff) ──────────────────────────────
//
// A contributed proposed answer against an accepted hypothesis, run through
// the same rigor an assistant candidate gets: the constitutional screen, then
// one scoreCandidateAnswer() call, synchronously, BEFORE anything is written.
// A screen hit -> 422, no write, the case is not escalated. A scoring failure
// -> 502, no write. On success submit_kgr_solution (migration 011) does the
// atomic recheck-and-insert under a lock on the case row, and establishes or
// verifies the case-level contribution problem snapshot.
async function submitKgrSolution(request, env, id, userJwt, corsHeaders) {
  const auth = await requireCaseAuthority(env, userJwt, CASE_DEVELOPMENT_ROLES, corsHeaders);
  if (!auth.ok) return auth.response;
  const gate = await kgrMutationGate(env, corsHeaders);
  if (gate) return gate;

  const kgrCase = await fetchCase(env, id);
  if (!kgrCase) return jsonResponse({ error: "Case not found" }, 404, corsHeaders);
  if (kgrCase.status !== "in_development")
    return jsonResponse({ error: `Case is '${kgrCase.status}' - solutions can only be contributed while in_development` }, 409, corsHeaders);

  const body = await request.json().catch(() => ({}));
  const hypothesisId = Number(body.hypothesis_id);
  const proposedContent = typeof body.proposed_content === "string" ? body.proposed_content.trim() : "";
  const origin = body.origin;
  const submissionKey = typeof body.submission_key === "string" ? body.submission_key.trim() : "";
  if (!Number.isInteger(hypothesisId) || hypothesisId <= 0)
    return jsonResponse({ error: "hypothesis_id (positive integer) is required" }, 400, corsHeaders);
  if (!proposedContent)
    return jsonResponse({ error: "proposed_content (non-blank string) is required" }, 400, corsHeaders);
  if (!SOLUTION_ORIGINS.includes(origin))
    return jsonResponse({ error: `origin must be one of: ${SOLUTION_ORIGINS.join(", ")}` }, 400, corsHeaders);
  if (!submissionKey)
    return jsonResponse({ error: "submission_key (non-blank string) is required" }, 400, corsHeaders);

  // The hypothesis must be an accepted one on this case (the RPC rechecks this
  // atomically; this is the early, friendly rejection).
  const hyps = await fetchHypotheses(env, id);
  const hyp = hyps.find((h) => h.id === hypothesisId);
  if (!hyp) return jsonResponse({ error: "hypothesis_id is not on this case" }, 404, corsHeaders);
  if (hyp.status !== "accepted")
    return jsonResponse({ error: `hypothesis is '${hyp.status}' - a solution may only be contributed against an accepted hypothesis` }, 409, corsHeaders);

  // Idempotency status-code helper: a completed identical retry returns 200,
  // a fresh contribution 201. The RPC is still the atomic authority.
  const priorRows = await supabaseFetch(env, "kgr_candidate_solutions",
    `?kgr_case_id=eq.${id}&submitted_by=eq.${auth.authority.id}&submission_key=eq.${encodeURIComponent(submissionKey)}&select=id,proposed_content`);
  const prior = priorRows?.[0];
  if (prior) {
    if (prior.proposed_content === proposedContent) {
      const row = (await supabaseFetch(env, "kgr_candidate_solutions", `?id=eq.${prior.id}&select=*`))?.[0] ?? null;
      return jsonResponse({ solution: row }, 200, corsHeaders);
    }
    return jsonResponse({ error: "submission_key already used for different content" }, 409, corsHeaders);
  }

  const problemText =
    (typeof kgrCase.contribution_problem_snapshot === "string" && kgrCase.contribution_problem_snapshot) ||
    kgrCase.gap_resolution_requests?.questions?.question_text ||
    `Request #${kgrCase.gap_resolution_request_id}`;

  // Equal rigor, synchronous, before any write: constitutional screen first.
  const constitutionSection = await fetchConstitutionSection(env);
  const screenInput = `${problemText}\n\n${proposedContent}`;
  const screen = await checkConstitutionalEligibility(env, constitutionSection, screenInput);
  if (screen.constitutionalCandidate) {
    return jsonResponse(
      {
        error: "This proposed solution raises a constitutional question and was not recorded. Use the case's explicit escalation action if the case as a whole needs constitutional review.",
        issue: screen.issue,
      },
      422,
      corsHeaders
    );
  }
  const provHash = await provisionsHash(constitutionSection);

  // Then one appropriateness score. A failure here writes nothing.
  let scored;
  try {
    scored = await scoreCandidateAnswer(env, problemText, proposedContent);
  } catch (e) {
    return jsonResponse({ error: `Scoring is unavailable, nothing was recorded - retry: ${e.message}` }, 502, corsHeaders);
  }

  const rpcArgs = {
    p_case_id: Number(id),
    p_hypothesis_id: hypothesisId,
    p_proposed_content: proposedContent,
    p_origin: origin,
    p_submitted_by: auth.authority.id,
    p_score: scored.score,
    p_rationale: scored.rationale,
    p_provisions_hash: provHash,
    p_problem_snapshot: problemText,
    p_submission_key: submissionKey,
    // Migration 014: bind the contribution to the target revision it was
    // screened/scored against. If a set-target bumped it in the meantime the
    // RPC rejects and nothing is written.
    p_target_revision: kgrCase.target_revision,
  };

  try {
    const out = await supabaseRpc(env, "submit_kgr_solution", rpcArgs);
    const row = Array.isArray(out) ? out[0] ?? null : out;
    return jsonResponse({ solution: row }, 201, corsHeaders);
  } catch (e) {
    const msg = String(e.message);
    // Race: another "first" contribution set the snapshot while we scored
    // against the origin question. Re-read, re-score against the stored
    // snapshot, retry once.
    if (msg.includes("problem snapshot mismatch")) {
      const fresh = await fetchCase(env, id);
      const storedProblem = fresh?.contribution_problem_snapshot;
      if (storedProblem && storedProblem !== problemText) {
        let rescored;
        try {
          rescored = await scoreCandidateAnswer(env, storedProblem, proposedContent);
        } catch (e2) {
          return jsonResponse({ error: `Scoring is unavailable, nothing was recorded - retry: ${e2.message}` }, 502, corsHeaders);
        }
        try {
          const out2 = await supabaseRpc(env, "submit_kgr_solution", {
            ...rpcArgs, p_score: rescored.score, p_rationale: rescored.rationale, p_problem_snapshot: storedProblem,
          });
          const row2 = Array.isArray(out2) ? out2[0] ?? null : out2;
          return jsonResponse({ solution: row2 }, 201, corsHeaders);
        } catch (e3) {
          return jsonResponse({ error: rpcErrMessage(e3) }, 409, corsHeaders);
        }
      }
    }
    if (msg.includes("already used for different content"))
      return jsonResponse({ error: "submission_key already used for different content" }, 409, corsHeaders);
    return jsonResponse({ error: rpcErrMessage(e) }, 409, corsHeaders);
  }
}

// ── Solution withdrawal (contributor or Management, in_development only) ──────
async function withdrawKgrSolution(request, env, id, sid, userJwt, corsHeaders) {
  const auth = await requireCaseAuthority(env, userJwt, CASE_DEVELOPMENT_ROLES, corsHeaders);
  if (!auth.ok) return auth.response;
  const gate = await kgrMutationGate(env, corsHeaders);
  if (gate) return gate;

  const body = await request.json().catch(() => ({}));
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (!reason) return jsonResponse({ error: "reason (non-blank string) is required" }, 400, corsHeaders);

  try {
    const out = await supabaseRpc(env, "withdraw_kgr_solution", {
      p_case_id: Number(id),
      p_solution_id: Number(sid),
      p_actor_id: auth.authority.id,
      p_actor_role: auth.authority.role,
      p_reason: reason,
    });
    const row = Array.isArray(out) ? out[0] ?? null : out;
    return jsonResponse({ solution: row }, 200, corsHeaders);
  } catch (e) {
    const msg = rpcErrMessage(e);
    if (msg.includes("only the contributor or Management")) return jsonResponse({ error: msg }, 403, corsHeaders);
    if (msg.includes("is not on case")) return jsonResponse({ error: msg }, 404, corsHeaders);
    return jsonResponse({ error: msg }, 409, corsHeaders);
  }
}

// ── Resolution statement preparation (Management or Staff) ────────────────────
//
// Increment 5: server-derived freeze-and-snapshot. No request body. The
// prepare_kgr_resolution_statement RPC (migration 011) copies every active
// contributed solution into the statement with its exact content, score,
// rationale and provenance - no rescoring, no model call, no client-chosen
// subset. Idempotent: a repeat returns the existing statement.
async function prepareResolutionStatement(request, env, id, userJwt, corsHeaders) {
  const auth = await requireCaseAuthority(env, userJwt, CASE_DEVELOPMENT_ROLES, corsHeaders);
  if (!auth.ok) return auth.response;
  const gate = await kgrMutationGate(env, corsHeaders);
  if (gate) return gate;

  const kgrCase = await fetchCase(env, id);
  if (!kgrCase) return jsonResponse({ error: "Case not found" }, 404, corsHeaders);
  if (kgrCase.status !== "ready_for_decision")
    return jsonResponse(
      { error: `Case must be 'ready_for_decision' to prepare a resolution statement (is '${kgrCase.status}')` },
      409,
      corsHeaders
    );

  const existingStatement = await fetchResolutionStatement(env, id);
  if (existingStatement)
    return jsonResponse(
      { error: "A resolution statement already exists for this case", resolution_statement: existingStatement },
      409,
      corsHeaders
    );

  try {
    await supabaseRpc(env, "prepare_kgr_resolution_statement", {
      p_case_id: Number(id),
      p_prepared_by: auth.authority.id,
    });
  } catch (e) {
    const raceLoserStatement = await fetchResolutionStatement(env, id);
    if (raceLoserStatement)
      return jsonResponse(
        { error: "A resolution statement already exists for this case", resolution_statement: raceLoserStatement },
        409,
        corsHeaders
      );
    return jsonResponse({ error: rpcErrMessage(e) }, 409, corsHeaders);
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
  const gate = await kgrMutationGate(env, corsHeaders);
  if (gate) return gate;

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

  const constitutionSection = await fetchConstitutionSection(env);

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
    "?status=eq.falsified&select=id,description,test_notes,created_at,kgr_case_id,kgr_cases(gap_resolution_requests!kgr_cases_gap_resolution_request_id_fkey(questions(question_text)))&order=created_at.desc");
  return jsonResponse(rows ?? [], 200, corsHeaders);
}

async function deleteFalsifiedHypothesis(env, id, userJwt, corsHeaders) {
  const auth = await requireCaseAuthority(env, userJwt, CASE_MANAGEMENT_ONLY_ROLES, corsHeaders);
  if (!auth.ok) return auth.response;
  const gate = await kgrMutationGate(env, corsHeaders);
  if (gate) return gate;

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
  submitKgrSolution, withdrawKgrSolution,
  setKgrCaseTarget, openCompanionCase, underReviewQaPairIds,
  prepareResolutionStatement, signOffKgrResolution, listFalsifiedHypotheses, deleteFalsifiedHypothesis,
};

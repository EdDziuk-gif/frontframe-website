import { beforeEach, describe, expect, it, vi } from "vitest";

// Phase F Candidate 2, Increment 2 — KGR case development record.
// Scope: kgr_cases / kgr_hypotheses lifecycle only. No resolution statement,
// scoring, sign-off, promulgation, or notification path exists yet, so none
// of that is exercised here - this increment is a development record only.

const supabaseFetchMock = vi.fn();
const supabasePostMock  = vi.fn();
const supabasePatchMock = vi.fn();
const supabaseRpcMock   = vi.fn();
const callAnthropicMock = vi.fn();
const checkEligibilityMock = vi.fn();

const supabaseDeleteMock = vi.fn();

vi.mock("../src/shared/supabase.js", () => ({
  supabaseFetch: (...a) => supabaseFetchMock(...a),
  supabasePost:  (...a) => supabasePostMock(...a),
  supabasePatch: (...a) => supabasePatchMock(...a),
  supabasePatchByField: vi.fn(),
  supabaseRpc:   (...a) => supabaseRpcMock(...a),
  supabaseUpsert: vi.fn(),
  supabaseDelete: (...a) => supabaseDeleteMock(...a),
  supabaseHeaders: () => ({}),
}));

vi.mock("../src/shared/runtime.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    callAnthropic: (...a) => callAnthropicMock(...a),
    sendSms: vi.fn().mockResolvedValue({ success: true }),
  };
});

vi.mock("../src/shared/scoring.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    checkConstitutionalEligibility: (...a) => checkEligibilityMock(...a),
  };
});

// fetch is used by getReviewerAuthority for /auth/v1/user
global.fetch = vi.fn();

const {
  createKgrCase, listKgrCases, getKgrCase, updateKgrCase,
  addHypothesis, updateHypothesis, readyKgrCase, escalateKgrCase, developKgrCase,
  prepareResolutionStatement, signOffKgrResolution, listFalsifiedHypotheses, deleteFalsifiedHypothesis,
  setKgrCaseTarget, openCompanionCase,
} = await import("../src/routes/kgr.js");

const CH = {};
const ENV = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
  // The KGR mutation gate (kgr.js) fails closed without this binding; a stub
  // that reports "not paused" is the normal path.
  RATE_LIMIT_KV: { get: async () => null },
};

function mockRequest(body = {}) {
  return { json: () => Promise.resolve(body) };
}

// Mocks getReviewerAuthority(env, jwt)'s call chain: /auth/v1/user, then
// reviewers, then reviewer_roles (the last is unused by kgr.js but
// getReviewerAuthority always queries it).
function mockAuth({ id = "rev-uuid", role = "frontframe_admin", active = true } = {}) {
  global.fetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({ email: "reviewer@frontframe.co" }),
  });
  supabaseFetchMock
    .mockResolvedValueOnce([{ id, role, active }])
    .mockResolvedValueOnce([{ roles: { can_amend_constitution: false } }]);
}

function mockInvalidJwt() {
  global.fetch.mockResolvedValueOnce({ ok: false });
}

beforeEach(() => {
  // resetAllMocks (not clearAllMocks) so a test's unconsumed mockResolvedValueOnce
  // values do not leak into the next test - handlers that call an RPC where an
  // older revision read a table consume a different number of queued mocks.
  vi.resetAllMocks();
});

// ── createKgrCase ────────────────────────────────────────────────────────

// Migration 014 / decision 0036: "Start Case" is Staff or Management, and the
// whole thing (reject resolved/escalated/has-a-case, stamp authorized_*, insert
// one case at the default target) is the start_kgr_case RPC — one transaction,
// replacing the old read-then-write. The handler just maps RPC errors to codes.
describe("createKgrCase (Start Case)", () => {
  it("rejects a missing/invalid JWT", async () => {
    mockInvalidJwt();
    const res = await createKgrCase(mockRequest({ gap_resolution_request_id: 1 }), ENV, "bad-jwt", CH);
    expect(res.status).toBe(401);
    expect(supabaseRpcMock).not.toHaveBeenCalled();
  });

  it("rejects a missing gap_resolution_request_id (400)", async () => {
    mockAuth({ role: "frontframe_staff" });
    const res = await createKgrCase(mockRequest({}), ENV, "staff-jwt", CH);
    expect(res.status).toBe(400);
    expect(supabaseRpcMock).not.toHaveBeenCalled();
  });

  it("maps the RPC 'not found' to 404", async () => {
    mockAuth({ role: "frontframe_staff" });
    supabaseRpcMock.mockRejectedValueOnce(new Error("gap_resolution_requests row 999 not found"));
    const res = await createKgrCase(mockRequest({ gap_resolution_request_id: 999 }), ENV, "staff-jwt", CH);
    expect(res.status).toBe(404);
  });

  it("maps the RPC 'a case already exists' to 409", async () => {
    mockAuth();
    supabaseRpcMock.mockRejectedValueOnce(new Error("a case already exists for request 1"));
    const res = await createKgrCase(mockRequest({ gap_resolution_request_id: 1 }), ENV, "admin-jwt", CH);
    expect(res.status).toBe(409);
  });

  it("maps the RPC 'escalated' / 'already resolved' to 409", async () => {
    mockAuth();
    supabaseRpcMock.mockRejectedValueOnce(new Error("request 1 is escalated"));
    const res = await createKgrCase(mockRequest({ gap_resolution_request_id: 1 }), ENV, "admin-jwt", CH);
    expect(res.status).toBe(409);
  });

  it("a Staff caller starts the case; p_reviewer is server-derived, at the default target", async () => {
    mockAuth({ id: "staff-uuid", role: "frontframe_staff" });
    supabaseRpcMock.mockResolvedValueOnce([{ id: 7 }]);                    // start_kgr_case
    supabaseFetchMock.mockResolvedValueOnce([{ id: 7, status: "in_development", resolution_target: "qa_pair", target_revision: 0 }]); // fetchCase(7)

    const res = await createKgrCase(
      mockRequest({ gap_resolution_request_id: 1, created_by: "attacker-uuid", p_reviewer: "attacker-uuid" }),
      ENV, "staff-jwt", CH,
    );

    expect(res.status).toBe(200);
    const [, fn, args] = supabaseRpcMock.mock.calls[0];
    expect(fn).toBe("start_kgr_case");
    expect(args.p_request_id).toBe(1);
    expect(args.p_reviewer).toBe("staff-uuid");
  });
});

// ── development: Staff-permitted ────────────────────────────────────────

// Increment 5 (migration 013): research-note and hypothesis writes go through
// guarded RPCs (update_kgr_research_notes / add_kgr_hypothesis) that lock the
// case row and recheck in_development inside the transaction.
describe("Staff may develop an existing authorized case", () => {
  it("allows Staff to update research_notes via the guarded RPC", async () => {
    mockAuth({ role: "frontframe_staff", id: "staff-uuid" });
    supabaseRpcMock.mockResolvedValueOnce([{ id: 7, research_notes: "Found the CDN vendor page." }]);

    const res = await updateKgrCase(mockRequest({ research_notes: "Found the CDN vendor page." }), ENV, "7", "staff-jwt", CH);
    expect(res.status).toBe(200);
    const [, fnName, params] = supabaseRpcMock.mock.calls[0];
    expect(fnName).toBe("update_kgr_research_notes");
    expect(params.p_case_id).toBe(7);
    expect(params.p_notes).toBe("Found the CDN vendor page.");
  });

  it("allows Staff to add a hypothesis, created_by derived server-side", async () => {
    mockAuth({ role: "frontframe_staff", id: "staff-uuid" });
    supabaseRpcMock.mockResolvedValueOnce([{ id: 100, status: "untested" }]);

    const res = await addHypothesis(
      mockRequest({ description: "No formal SLA exists.", created_by: "attacker-uuid" }),
      ENV, "7", "staff-jwt", CH,
    );

    expect(res.status).toBe(200);
    const [, fnName, params] = supabaseRpcMock.mock.calls[0];
    expect(fnName).toBe("add_kgr_hypothesis");
    expect(params.p_created_by).toBe("staff-uuid"); // server-derived, never body-supplied
    expect(params.p_description).toBe("No formal SLA exists.");
  });

  it("rejects edits to a frozen (non-in_development) case (RPC raises)", async () => {
    mockAuth({ role: "frontframe_staff" });
    supabaseRpcMock.mockRejectedValueOnce(new Error("case 7 is ready_for_decision and is frozen"));
    const res = await updateKgrCase(mockRequest({ research_notes: "too late" }), ENV, "7", "staff-jwt", CH);
    expect(res.status).toBe(409);
  });
});

// ── hypothesis disposition ──────────────────────────────────────────────

// Increment 5 (migration 013): disposition goes through the guarded
// dispose_kgr_hypothesis RPC. The handler still validates status/test_notes
// shape up front; the case-freeze, on-this-case, and still-untested checks are
// the RPC's, atomically.
describe("updateHypothesis", () => {
  it("rejects a status other than falsified/accepted, before the RPC", async () => {
    mockAuth();
    const res = await updateHypothesis(mockRequest({ status: "untested" }), ENV, "7", "100", "admin-jwt", CH);
    expect(res.status).toBe(400);
    expect(supabaseRpcMock).not.toHaveBeenCalled();
  });

  it("rejects accepting a hypothesis with no test_notes, before the RPC", async () => {
    mockAuth();
    const res = await updateHypothesis(mockRequest({ status: "accepted" }), ENV, "7", "100", "admin-jwt", CH);
    expect(res.status).toBe(400);
    expect(supabaseRpcMock).not.toHaveBeenCalled();
  });

  it("rejects falsifying with blank/whitespace-only test_notes, before the RPC", async () => {
    mockAuth();
    const res = await updateHypothesis(mockRequest({ status: "falsified", test_notes: "   " }), ENV, "7", "100", "admin-jwt", CH);
    expect(res.status).toBe(400);
    expect(supabaseRpcMock).not.toHaveBeenCalled();
  });

  it("maps the RPC's already-disposed rejection to 409", async () => {
    mockAuth();
    supabaseRpcMock.mockRejectedValueOnce(new Error("hypothesis 100 is already accepted and cannot be changed again"));
    const res = await updateHypothesis(mockRequest({ status: "falsified", test_notes: "No longer relevant." }), ENV, "7", "100", "admin-jwt", CH);
    expect(res.status).toBe(409);
  });

  it("maps the RPC's not-on-case rejection to 404", async () => {
    mockAuth();
    supabaseRpcMock.mockRejectedValueOnce(new Error("hypothesis 100 is not on case 7"));
    const res = await updateHypothesis(mockRequest({ status: "accepted", test_notes: "x" }), ENV, "7", "100", "admin-jwt", CH);
    expect(res.status).toBe(404);
  });

  it("dispatches a valid disposition to dispose_kgr_hypothesis with trimmed notes", async () => {
    mockAuth();
    supabaseRpcMock.mockResolvedValueOnce([{ id: 100, status: "falsified", test_notes: "Superseded by hypothesis: revised timeline theory." }]);

    const res = await updateHypothesis(
      mockRequest({ status: "falsified", test_notes: "  Superseded by hypothesis: revised timeline theory.  " }),
      ENV, "7", "100", "admin-jwt", CH
    );
    expect(res.status).toBe(200);
    const [, fnName, params] = supabaseRpcMock.mock.calls[0];
    expect(fnName).toBe("dispose_kgr_hypothesis");
    expect(params.p_case_id).toBe(7);
    expect(params.p_hypothesis_id).toBe(100);
    expect(params.p_status).toBe("falsified");
    expect(params.p_test_notes).toBe("Superseded by hypothesis: revised timeline theory."); // trimmed
  });

  it("passes a replacement-identity note through verbatim", async () => {
    mockAuth();
    supabaseRpcMock.mockResolvedValueOnce([{ id: 100, status: "falsified" }]);
    const replacementNote = 'Replaced by hypothesis #103 ("revised timeline theory") - original scope was too narrow.';
    const res = await updateHypothesis(mockRequest({ status: "falsified", test_notes: replacementNote }), ENV, "7", "100", "admin-jwt", CH);
    expect(res.status).toBe(200);
    expect(supabaseRpcMock.mock.calls[0][2].p_test_notes).toBe(replacementNote);
  });
});

// ── readiness gate ───────────────────────────────────────────────────────

// Increment 5: readiness is the guarded ready_kgr_case RPC (migration 011) -
// it serializes on the case row and enforces zero untested hypotheses, at
// least one accepted, AND at least one active contributed solution for every
// accepted hypothesis. The handler surfaces every guard failure as a 409.
describe("readyKgrCase", () => {
  it("does not call the RPC for an unauthenticated caller", async () => {
    mockInvalidJwt();
    const res = await readyKgrCase(ENV, "7", "bad-jwt", CH);
    expect(res.status).toBe(401);
    expect(supabaseRpcMock).not.toHaveBeenCalled();
  });

  it("404s when the case does not exist, before the RPC", async () => {
    mockAuth();
    supabaseFetchMock.mockResolvedValueOnce([]); // fetchCase
    const res = await readyKgrCase(ENV, "7", "admin-jwt", CH);
    expect(res.status).toBe(404);
    expect(supabaseRpcMock).not.toHaveBeenCalled();
  });

  it("passes a guard failure from ready_kgr_case through as a clean 409", async () => {
    mockAuth();
    supabaseFetchMock.mockResolvedValueOnce([{ id: 7, status: "in_development" }]); // fetchCase
    supabaseRpcMock.mockRejectedValueOnce(
      new Error("Supabase RPC ready_kgr_case failed: case 7 has 1 accepted hypothesis(es) with no active contributed solution")
    );
    const res = await readyKgrCase(ENV, "7", "admin-jwt", CH);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("no active contributed solution");
    expect(body.error).not.toContain("Supabase RPC"); // wrapper stripped
  });

  it("succeeds via ready_kgr_case and returns the updated case row", async () => {
    mockAuth();
    supabaseFetchMock.mockResolvedValueOnce([{ id: 7, status: "in_development" }]); // fetchCase
    supabaseRpcMock.mockResolvedValueOnce([{ id: 7, status: "ready_for_decision" }]);

    const res = await readyKgrCase(ENV, "7", "admin-jwt", CH);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ready_for_decision");

    const [, fnName, params] = supabaseRpcMock.mock.calls[0];
    expect(fnName).toBe("ready_kgr_case");
    expect(params.p_case_id).toBe(7);
    expect(supabasePatchMock).not.toHaveBeenCalled(); // no direct table write
  });
});

// ── escalation: terminal, evidence preserved ────────────────────────────

describe("escalateKgrCase", () => {
  it("makes no state change when the eligibility check returns non-candidate", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "in_development", research_notes: "notes" }]) // fetchCase
      .mockResolvedValueOnce([])   // hypotheses
      .mockResolvedValueOnce([]);  // constitution_provisions
    checkEligibilityMock.mockResolvedValueOnce({ constitutionalCandidate: false, issue: null });

    const res = await escalateKgrCase(ENV, "7", "admin-jwt", CH);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.escalated).toBe(false);
    expect(supabasePatchMock).not.toHaveBeenCalled();
  });

  it("escalates via the guarded escalate_kgr_case RPC, carrying the issue as the reason", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "in_development", research_notes: "notes" }])
      .mockResolvedValueOnce([{ description: "Does FrontFrame have authority to guarantee X" }])
      .mockResolvedValueOnce([]);
    checkEligibilityMock.mockResolvedValueOnce({ constitutionalCandidate: true, issue: "Requires Operator determination of guarantee authority" });
    supabaseRpcMock.mockResolvedValueOnce([{ id: 7, status: "escalated", escalation_reason: "Requires Operator determination of guarantee authority" }]);

    const res = await escalateKgrCase(ENV, "7", "admin-jwt", CH);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.escalated).toBe(true);
    const [, fnName, params] = supabaseRpcMock.mock.calls[0];
    expect(fnName).toBe("escalate_kgr_case");
    expect(params.p_case_id).toBe(7);
    expect(params.p_reason).toBe("Requires Operator determination of guarantee authority");
  });

  it("is terminal: an already-escalated case rejects a further escalate call, before any model call", async () => {
    mockAuth();
    supabaseFetchMock.mockResolvedValueOnce([{ id: 7, status: "escalated" }]);
    const res = await escalateKgrCase(ENV, "7", "admin-jwt", CH);
    expect(res.status).toBe(409);
    expect(checkEligibilityMock).not.toHaveBeenCalled();
    expect(supabaseRpcMock).not.toHaveBeenCalled();
  });

  it("an escalated case rejects a research-note edit (the guarded RPC raises)", async () => {
    mockAuth();
    supabaseRpcMock.mockRejectedValueOnce(new Error("case 7 is escalated and is frozen"));
    const res = await updateKgrCase(mockRequest({ research_notes: "x" }), ENV, "7", "admin-jwt", CH);
    expect(res.status).toBe(409);
  });
});

// ── model assistance: exactly one call, writes nothing ─────────────────

describe("developKgrCase", () => {
  it("makes exactly one model call and writes nothing", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "in_development", research_notes: "some notes", gap_resolution_request_id: 1 }]) // fetchCase
      .mockResolvedValueOnce([])  // hypotheses
      .mockResolvedValueOnce([{ questions: { question_text: "Do you guarantee uptime?" } }]); // origin question
    callAnthropicMock.mockResolvedValueOnce("Assessment: no SLA is documented. Candidate hypothesis: ...");

    const res = await developKgrCase(ENV, "7", "admin-jwt", CH);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.response).toContain("Assessment");
    expect(callAnthropicMock).toHaveBeenCalledTimes(1);
    expect(supabasePostMock).not.toHaveBeenCalled();
    expect(supabasePatchMock).not.toHaveBeenCalled();
  });

  it("rejects development assistance on a case that is not in_development", async () => {
    mockAuth();
    supabaseFetchMock.mockResolvedValueOnce([{ id: 7, status: "ready_for_decision" }]);
    const res = await developKgrCase(ENV, "7", "admin-jwt", CH);
    expect(res.status).toBe(409);
    expect(callAnthropicMock).not.toHaveBeenCalled();
  });
});

// ── full history reconstructable from the tables alone ──────────────────

describe("case history reconstruction", () => {
  it("getKgrCase returns the case plus its full hypothesis history with no external state", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "ready_for_decision", research_notes: "notes", escalation_reason: null }])
      .mockResolvedValueOnce([
        { id: 100, description: "H1", status: "falsified", test_notes: "wrong" },
        { id: 101, description: "H2", status: "accepted", test_notes: "confirmed" },
      ])
      .mockResolvedValueOnce([])  // fetchResolutionStatement
      .mockResolvedValueOnce([]); // fetchSolutions

    const res = await getKgrCase(ENV, "7", "admin-jwt", CH);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.research_notes).toBe("notes");
    expect(body.hypotheses).toHaveLength(2);
    expect(body.hypotheses.map((h) => h.status)).toEqual(["falsified", "accepted"]);
    expect(body.solutions).toEqual({ active: [], withdrawn: [] });
  });

  // Regression: fetchCase()'s select originally omitted the embedded
  // question, so the case detail view always fell back to a bare
  // "Request #N" label instead of the actual visitor question (caught
  // during live verification of Increment 2).
  it("getKgrCase includes the origin question via the embedded select", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{
        id: 7, status: "in_development", research_notes: null, escalation_reason: null,
        gap_resolution_requests: { questions: { question_text: "Does FrontFrame offer an SLA?" } },
      }])
      .mockResolvedValueOnce([])  // hypotheses
      .mockResolvedValueOnce([])  // fetchResolutionStatement
      .mockResolvedValueOnce([]); // fetchSolutions

    const res = await getKgrCase(ENV, "7", "admin-jwt", CH);
    const body = await res.json();
    expect(body.gap_resolution_requests?.questions?.question_text).toBe("Does FrontFrame offer an SLA?");

    const [, , query] = supabaseFetchMock.mock.calls[2]; // after mockAuth's two reviewer lookups
    // The FK is named explicitly: migration 014 added a second kgr_cases <->
    // gap_resolution_requests foreign key (resolved_kgr_case_id), so a bare
    // gap_resolution_requests(...) embed is ambiguous (PostgREST PGRST201).
    expect(query).toContain("gap_resolution_requests!kgr_cases_gap_resolution_request_id_fkey(questions(question_text))");
  });

  it("getKgrCase embeds a null resolution_statement when none exists yet", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "ready_for_decision", research_notes: null, escalation_reason: null }])
      .mockResolvedValueOnce([])   // hypotheses
      .mockResolvedValueOnce([])   // fetchResolutionStatement - none saved
      .mockResolvedValueOnce([]);  // fetchSolutions
    const res = await getKgrCase(ENV, "7", "admin-jwt", CH);
    const body = await res.json();
    expect(body.resolution_statement).toBeNull();
  });
});

// ── Phase F Candidate 2, Increment 3 — resolution statement preparation ──
// Scope: turning a ready_for_decision case's accepted hypotheses into a
// durable, scored resolution statement. No selection, sign-off,
// promulgation, or notification path is exercised here - none exists yet.

function scoreResponse(score, rationale) {
  return JSON.stringify({ score, rationale });
}

// New prepareResolutionStatement describe block (Increment 5: server-derived
// freeze-and-snapshot via the prepare_kgr_resolution_statement RPC - no request
// body, no client candidate array, no rescoring on prepare).
describe("prepareResolutionStatement", () => {
  it("rejects an unauthorized caller before touching the case", async () => {
    mockInvalidJwt();
    const res = await prepareResolutionStatement(mockRequest({}), ENV, "7", "bad-jwt", CH);
    expect(res.status).toBe(401);
    expect(supabaseFetchMock).not.toHaveBeenCalled();
    expect(supabaseRpcMock).not.toHaveBeenCalled();
  });

  it("404s when the case does not exist", async () => {
    mockAuth();
    supabaseFetchMock.mockResolvedValueOnce([]); // fetchCase
    const res = await prepareResolutionStatement(mockRequest({}), ENV, "7", "admin-jwt", CH);
    expect(res.status).toBe(404);
    expect(supabaseRpcMock).not.toHaveBeenCalled();
  });

  it("rejects a case that is still in_development (409, no RPC)", async () => {
    mockAuth();
    supabaseFetchMock.mockResolvedValueOnce([{ id: 7, status: "in_development" }]);
    const res = await prepareResolutionStatement(mockRequest({}), ENV, "7", "admin-jwt", CH);
    expect(res.status).toBe(409);
    expect(supabaseRpcMock).not.toHaveBeenCalled();
  });

  it("rejects an escalated case (409, no RPC)", async () => {
    mockAuth();
    supabaseFetchMock.mockResolvedValueOnce([{ id: 7, status: "escalated" }]);
    const res = await prepareResolutionStatement(mockRequest({}), ENV, "7", "admin-jwt", CH);
    expect(res.status).toBe(409);
    expect(supabaseRpcMock).not.toHaveBeenCalled();
  });

  it("returns the existing statement (409) on a repeat call, without calling the RPC", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "ready_for_decision" }])           // fetchCase
      .mockResolvedValueOnce([{ id: 55, kgr_case_id: 7, problem_statement: "Q?" }]); // existing statement
    const res = await prepareResolutionStatement(mockRequest({}), ENV, "7", "admin-jwt", CH);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.resolution_statement.id).toBe(55);
    expect(supabaseRpcMock).not.toHaveBeenCalled();
  });

  it("server-derives the snapshot via prepare_kgr_resolution_statement and returns the persisted statement", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "ready_for_decision" }]) // fetchCase
      .mockResolvedValueOnce([])                                        // no existing statement
      .mockResolvedValueOnce([{                                         // final re-fetch
        id: 55, kgr_case_id: 7, problem_statement: "Q?",
        kgr_resolution_candidates: [
          { id: 1, kgr_hypothesis_id: 100, presented_content: "A", score: 0.7, rationale: "r", submitted_by: "staff-a", origin: "human" },
          { id: 2, kgr_hypothesis_id: 100, presented_content: "B", score: 0.2, rationale: "r", submitted_by: "staff-b", origin: "human" },
        ],
      }]);
    supabaseRpcMock.mockResolvedValueOnce(55);

    const res = await prepareResolutionStatement(mockRequest({}), ENV, "7", "admin-jwt", CH);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(55);
    // N:1 in the snapshot: two candidates share one hypothesis, and the
    // low-scored one (0.2) is still present - no threshold gates it.
    expect(body.kgr_resolution_candidates).toHaveLength(2);
    expect(body.kgr_resolution_candidates.every((c) => c.kgr_hypothesis_id === 100)).toBe(true);
    expect(callAnthropicMock).not.toHaveBeenCalled(); // no rescoring on prepare

    expect(supabaseRpcMock).toHaveBeenCalledTimes(1);
    const [, fnName, params] = supabaseRpcMock.mock.calls[0];
    expect(fnName).toBe("prepare_kgr_resolution_statement");
    expect(params.p_case_id).toBe(7);
    expect(params.p_prepared_by).toBe("rev-uuid");        // server-derived, never caller-supplied
    expect(params).not.toHaveProperty("p_candidates");    // no client-supplied candidate array
    expect(params).not.toHaveProperty("p_problem_statement");
  });

  it("resolves a concurrent-race loss to a 409 with the winner's statement", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "ready_for_decision" }])
      .mockResolvedValueOnce([])                                                    // none at check time
      .mockResolvedValueOnce([{ id: 55, kgr_case_id: 7, problem_statement: "Q?" }]); // winner on re-fetch
    supabaseRpcMock.mockRejectedValueOnce(new Error("duplicate key value violates unique constraint"));

    const res = await prepareResolutionStatement(mockRequest({}), ENV, "7", "admin-jwt", CH);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.resolution_statement.id).toBe(55);
  });

  it("surfaces a guard failure from the RPC as a 409 when there is no race winner", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "ready_for_decision" }])
      .mockResolvedValueOnce([])   // none at check time
      .mockResolvedValueOnce([]);  // still none on re-fetch
    supabaseRpcMock.mockRejectedValueOnce(new Error("Supabase RPC prepare_kgr_resolution_statement failed: case 7 has no active solutions to snapshot"));

    const res = await prepareResolutionStatement(mockRequest({}), ENV, "7", "admin-jwt", CH);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("no active solutions to snapshot");
    expect(body.error).not.toContain("Supabase RPC");
  });

  it("re-fetching the case afterward returns the identical persisted statement", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "ready_for_decision", research_notes: null, escalation_reason: null }])
      .mockResolvedValueOnce([])  // hypotheses
      .mockResolvedValueOnce([{
        id: 55, kgr_case_id: 7, problem_statement: "Q?",
        kgr_resolution_candidates: [
          { id: 1, kgr_hypothesis_id: 100, presented_content: "Answer A", score: 0.8, rationale: "Directly responsive." },
        ],
      }]);
    const res = await getKgrCase(ENV, "7", "admin-jwt", CH);
    const body = await res.json();
    expect(body.resolution_statement.id).toBe(55);
    expect(body.resolution_statement.kgr_resolution_candidates[0].presented_content).toBe("Answer A");
  });
});

// ── Phase F Candidate 2, Increment 4 — sign-off ─────────────────────────
// Scope: selecting one prepared candidate, recording the decision, pruning
// unselected candidates/hypotheses, and publishing to qa_pairs - all inside
// sign_off_kgr_resolution (migration 007). No promulgation/notification
// path beyond writing qa_pairs is exercised here.

function baseStatement(overrides = {}) {
  return {
    id: 55,
    kgr_case_id: 7,
    problem_statement: "Does FrontFrame offer an SLA?",
    prepared_by: "rev-uuid",
    signed_off_at: null,
    signed_off_by: null,
    selected_candidate_id: null,
    qa_pair_id: null,
    kgr_resolution_candidates: [
      { id: 1, kgr_hypothesis_id: 100, presented_content: "Answer A", score: 0.8, rationale: "Directly responsive." },
      { id: 2, kgr_hypothesis_id: 101, presented_content: "Answer B", score: 0.3, rationale: "Off-topic." },
    ],
    ...overrides,
  };
}

describe("signOffKgrResolution", () => {
  it("rejects an unauthenticated caller before any write", async () => {
    global.fetch.mockResolvedValueOnce({ ok: false });
    const res = await signOffKgrResolution(mockRequest({ candidate_id: 1 }), ENV, "7", "bad-jwt", CH);
    expect(res.status).toBe(401);
    expect(supabaseFetchMock).not.toHaveBeenCalled();
    expect(supabaseRpcMock).not.toHaveBeenCalled();
  });

  it("rejects Staff (Management only), before any write", async () => {
    mockAuth({ role: "frontframe_staff" });
    const res = await signOffKgrResolution(mockRequest({ candidate_id: 1 }), ENV, "7", "staff-jwt", CH);
    expect(res.status).toBe(403);
    expect(supabaseRpcMock).not.toHaveBeenCalled();
  });

  it("404s when the case does not exist", async () => {
    mockAuth();
    supabaseFetchMock.mockResolvedValueOnce([]); // fetchCase
    const res = await signOffKgrResolution(mockRequest({ candidate_id: 1 }), ENV, "7", "admin-jwt", CH);
    expect(res.status).toBe(404);
    expect(supabaseRpcMock).not.toHaveBeenCalled();
  });

  it("409s when the case is not ready_for_decision, naming the actual status", async () => {
    mockAuth();
    supabaseFetchMock.mockResolvedValueOnce([{ id: 7, status: "in_development" }]);
    const res = await signOffKgrResolution(mockRequest({ candidate_id: 1 }), ENV, "7", "admin-jwt", CH);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("in_development");
    expect(supabaseRpcMock).not.toHaveBeenCalled();
  });

  it("404s when no resolution statement exists for the case", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "ready_for_decision" }]) // fetchCase
      .mockResolvedValueOnce([]); // fetchResolutionStatement - none
    const res = await signOffKgrResolution(mockRequest({ candidate_id: 1 }), ENV, "7", "admin-jwt", CH);
    expect(res.status).toBe(404);
    expect(supabaseRpcMock).not.toHaveBeenCalled();
  });

  it("409s with the existing decision record when already signed off", async () => {
    mockAuth();
    const signedStatement = baseStatement({ signed_off_at: "2026-09-05T00:00:00Z", signed_off_by: "rev-uuid", selected_candidate_id: 1 });
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "ready_for_decision" }])
      .mockResolvedValueOnce([signedStatement]);
    const res = await signOffKgrResolution(mockRequest({ candidate_id: 1 }), ENV, "7", "admin-jwt", CH);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.resolution_statement.id).toBe(55);
    expect(supabaseRpcMock).not.toHaveBeenCalled();
  });

  it("400s when candidate_id is not one of this statement's candidates", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "ready_for_decision" }])
      .mockResolvedValueOnce([baseStatement()]);
    const res = await signOffKgrResolution(mockRequest({ candidate_id: 999 }), ENV, "7", "admin-jwt", CH);
    expect(res.status).toBe(400);
    expect(supabaseRpcMock).not.toHaveBeenCalled();
  });

  it("409s with the corrected message and issue field when constitutional eligibility is flagged, and makes no RPC call", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "ready_for_decision" }]) // fetchCase
      .mockResolvedValueOnce([baseStatement()]) // fetchResolutionStatement
      .mockResolvedValueOnce([]); // constitution_provisions
    checkEligibilityMock.mockResolvedValueOnce({
      constitutionalCandidate: true,
      issue: "Requires Operator determination of guarantee authority",
    });

    const res = await signOffKgrResolution(mockRequest({ candidate_id: 1 }), ENV, "7", "admin-jwt", CH);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe(
      "This resolution appears to raise a constitutional question and cannot be signed off operationally. FrontFrame's KGR escalation path only applies before a case reaches this stage, so no automated next step exists here - bring this case to the Operator directly for constitutional review."
    );
    expect(body.issue).toBe("Requires Operator determination of guarantee authority");
    expect(supabaseRpcMock).not.toHaveBeenCalled();
  });

  it("happy path: calls the RPC with the STATEMENT's id (not the case's URL id) and returns the getKgrCase shape", async () => {
    mockAuth();
    const finalStatement = baseStatement({
      signed_off_at: "2026-09-05T00:00:00Z",
      signed_off_by: "rev-uuid",
      selected_candidate_id: 1,
      qa_pair_id: "qa-uuid-1",
      kgr_resolution_candidates: [
        { id: 1, kgr_hypothesis_id: 100, presented_content: "Answer A", score: 0.8, rationale: "Directly responsive." },
      ],
    });
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "ready_for_decision", research_notes: null, escalation_reason: null }]) // fetchCase
      .mockResolvedValueOnce([baseStatement()]) // fetchResolutionStatement
      .mockResolvedValueOnce([]) // constitution_provisions
      .mockResolvedValueOnce([{ id: 7, status: "ready_for_decision", research_notes: null, escalation_reason: null }]) // re-fetch case
      .mockResolvedValueOnce([{ id: 100, status: "accepted" }]) // re-fetch hypotheses
      .mockResolvedValueOnce([finalStatement]); // re-fetch statement
    checkEligibilityMock.mockResolvedValueOnce({ constitutionalCandidate: false, issue: null });
    supabaseRpcMock.mockResolvedValueOnce([{ statement_id: 55, qa_pair_id: "qa-uuid-1" }]);

    const res = await signOffKgrResolution(mockRequest({ candidate_id: 1 }), ENV, "7", "admin-jwt", CH);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.resolution_statement.signed_off_at).toBe("2026-09-05T00:00:00Z");
    expect(body.resolution_statement.qa_pair_id).toBe("qa-uuid-1");

    expect(supabaseRpcMock).toHaveBeenCalledTimes(1);
    const [, fnName, params] = supabaseRpcMock.mock.calls[0];
    expect(fnName).toBe("sign_off_kgr_resolution");
    // This is the exact regression this test guards against: the RPC must
    // receive the resolution STATEMENT's own id (55), never the case's URL
    // id ("7").
    expect(params.p_statement_id).toBe(55);
    expect(params.p_statement_id).not.toBe(7);
    expect(params.p_candidate_id).toBe(1);
    expect(params.p_signed_off_by).toBe("rev-uuid");
  });

  it("treats an 'already signed off' RPC error as a losing concurrent request: 409 with the re-fetched statement", async () => {
    mockAuth();
    const signedStatement = baseStatement({ signed_off_at: "2026-09-05T00:00:01Z", signed_off_by: "someone-else", selected_candidate_id: 2 });
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "ready_for_decision" }])
      .mockResolvedValueOnce([baseStatement()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([signedStatement]); // re-fetch after the RPC error
    checkEligibilityMock.mockResolvedValueOnce({ constitutionalCandidate: false, issue: null });
    supabaseRpcMock.mockRejectedValueOnce(new Error("statement 55 is already signed off"));

    const res = await signOffKgrResolution(mockRequest({ candidate_id: 1 }), ENV, "7", "admin-jwt", CH);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.resolution_statement.selected_candidate_id).toBe(2);
  });

  it("treats a 'candidate does not belong to statement' RPC error as a losing concurrent request when the re-fetch shows someone else already won: 409 with the winning decision", async () => {
    // This is the late-loser timing from the concurrency test: the RPC's own
    // candidate-existence check throws a different message than "already
    // signed off" because the winner's transaction had already pruned this
    // candidate's row before this call's RPC began - but the underlying
    // situation (someone else already completed sign-off) is identical, and
    // must produce the same clean 409, not a re-thrown/502'd error.
    mockAuth();
    const signedStatement = baseStatement({ signed_off_at: "2026-09-05T00:00:01Z", signed_off_by: "someone-else", selected_candidate_id: 2 });
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "ready_for_decision" }])
      .mockResolvedValueOnce([baseStatement()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([signedStatement]); // re-fetch after the RPC error
    checkEligibilityMock.mockResolvedValueOnce({ constitutionalCandidate: false, issue: null });
    supabaseRpcMock.mockRejectedValueOnce(new Error("candidate 1 does not belong to statement 55"));

    const res = await signOffKgrResolution(mockRequest({ candidate_id: 1 }), ENV, "7", "admin-jwt", CH);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toBe("This resolution statement has already been signed off");
    expect(body.resolution_statement.selected_candidate_id).toBe(2);
    expect(body.resolution_statement.signed_off_by).toBe("someone-else");
  });

  it("re-throws any other RPC error rather than swallowing it", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "ready_for_decision" }])
      .mockResolvedValueOnce([baseStatement()])
      .mockResolvedValueOnce([]);
    checkEligibilityMock.mockResolvedValueOnce({ constitutionalCandidate: false, issue: null });
    supabaseRpcMock.mockRejectedValueOnce(new Error("connection reset"));

    await expect(
      signOffKgrResolution(mockRequest({ candidate_id: 1 }), ENV, "7", "admin-jwt", CH)
    ).rejects.toThrow("connection reset");
  });

  it("re-throws a non-'already signed off' RPC error even after re-fetch, when the re-fetched statement is NOT signed off (no false-positive swallowing)", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "ready_for_decision" }])
      .mockResolvedValueOnce([baseStatement()])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([baseStatement()]); // re-fetch: still not signed off - genuine unrelated error
    checkEligibilityMock.mockResolvedValueOnce({ constitutionalCandidate: false, issue: null });
    supabaseRpcMock.mockRejectedValueOnce(new Error("candidate 1 does not belong to statement 55"));

    await expect(
      signOffKgrResolution(mockRequest({ candidate_id: 1 }), ENV, "7", "admin-jwt", CH)
    ).rejects.toThrow("candidate 1 does not belong to statement 55");
  });
});

// ── getKgrCase regression: resolution_statement embed carries the new columns ──

describe("getKgrCase resolution_statement select (Increment 4 columns)", () => {
  it("fetchResolutionStatement's select string includes the four new sign-off columns", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "ready_for_decision", research_notes: null, escalation_reason: null }])
      .mockResolvedValueOnce([])  // hypotheses
      .mockResolvedValueOnce([])  // resolution statement
      .mockResolvedValueOnce([]); // fetchSolutions
    await getKgrCase(ENV, "7", "admin-jwt", CH);
    const stmtCall = supabaseFetchMock.mock.calls.find((c) => c[1] === "kgr_resolution_statements");
    expect(stmtCall[2]).toContain("selected_candidate_id");
    expect(stmtCall[2]).toContain("signed_off_by");
    expect(stmtCall[2]).toContain("signed_off_at");
    expect(stmtCall[2]).toContain("qa_pair_id");
  });
});

// ── getKgrCase solutions (Increment 5) ──────────────────────────────────

describe("getKgrCase solutions (Increment 5)", () => {
  it("always includes solutions.active and solutions.withdrawn even when the table is empty", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "in_development", research_notes: null, escalation_reason: null }])
      .mockResolvedValueOnce([])  // hypotheses
      .mockResolvedValueOnce([])  // fetchResolutionStatement
      .mockResolvedValueOnce([]); // fetchSolutions - no solutions yet
    const res = await getKgrCase(ENV, "7", "admin-jwt", CH);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.solutions).toEqual({ active: [], withdrawn: [] });
  });

  it("separates active and withdrawn solutions by status", async () => {
    mockAuth();
    const activeSolution = {
      id: 1, kgr_hypothesis_id: 100, proposed_content: "Use caching", status: "active",
      submitted_by: "rev-uuid", origin: "human", score: null, rationale: null,
      constitutional_provisions_hash: null, problem_snapshot: null,
      withdrawn_by: null, withdrawn_reason: null, withdrawn_at: null, created_at: "2026-01-01T00:00:00Z",
    };
    const withdrawnSolution = {
      id: 2, kgr_hypothesis_id: 100, proposed_content: "Rebuild from scratch", status: "withdrawn",
      submitted_by: "rev-uuid", origin: "human", score: null, rationale: null,
      constitutional_provisions_hash: null, problem_snapshot: null,
      withdrawn_by: "rev-uuid", withdrawn_reason: "Out of scope", withdrawn_at: "2026-01-02T00:00:00Z", created_at: "2026-01-01T00:01:00Z",
    };
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "in_development", research_notes: null, escalation_reason: null }])
      .mockResolvedValueOnce([])                         // hypotheses
      .mockResolvedValueOnce([])                         // fetchResolutionStatement
      .mockResolvedValueOnce([activeSolution, withdrawnSolution]); // fetchSolutions
    const res = await getKgrCase(ENV, "7", "admin-jwt", CH);
    const body = await res.json();
    expect(body.solutions.active).toHaveLength(1);
    expect(body.solutions.active[0].id).toBe(1);
    expect(body.solutions.withdrawn).toHaveLength(1);
    expect(body.solutions.withdrawn[0].id).toBe(2);
  });

  it("fetchSolutions queries kgr_candidate_solutions filtered by kgr_case_id", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "in_development", research_notes: null, escalation_reason: null }])
      .mockResolvedValueOnce([])  // hypotheses
      .mockResolvedValueOnce([])  // fetchResolutionStatement
      .mockResolvedValueOnce([]); // fetchSolutions
    await getKgrCase(ENV, "7", "admin-jwt", CH);
    const solutionsCall = supabaseFetchMock.mock.calls.find((c) => c[1] === "kgr_candidate_solutions");
    expect(solutionsCall).toBeDefined();
    expect(solutionsCall[2]).toContain("kgr_case_id=eq.7");
    expect(solutionsCall[2]).toContain("status");
    expect(solutionsCall[2]).toContain("withdrawn_by");
  });

  it("fetchResolutionStatement select includes the five Increment 5 provenance columns", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "ready_for_decision", research_notes: null, escalation_reason: null }])
      .mockResolvedValueOnce([])  // hypotheses
      .mockResolvedValueOnce([])  // fetchResolutionStatement
      .mockResolvedValueOnce([]); // fetchSolutions
    await getKgrCase(ENV, "7", "admin-jwt", CH);
    const stmtCall = supabaseFetchMock.mock.calls.find((c) => c[1] === "kgr_resolution_statements");
    expect(stmtCall[2]).toContain("origin_solution_id");
    expect(stmtCall[2]).toContain("submitted_by");
    expect(stmtCall[2]).toContain("origin");
    expect(stmtCall[2]).toContain("constitutional_provisions_hash");
    expect(stmtCall[2]).toContain("problem_snapshot");
  });
});

// ── Falsified-hypothesis review ──────────────────────────────────────────

describe("listFalsifiedHypotheses", () => {
  it("rejects an unauthenticated caller", async () => {
    global.fetch.mockResolvedValueOnce({ ok: false });
    const res = await listFalsifiedHypotheses(mockRequest(), ENV, "bad-jwt", CH);
    expect(res.status).toBe(401);
    expect(supabaseFetchMock).not.toHaveBeenCalled();
  });

  it("Staff can call it (200)", async () => {
    mockAuth({ role: "frontframe_staff" });
    supabaseFetchMock.mockResolvedValueOnce([{ id: 100, description: "H1", test_notes: "wrong", kgr_case_id: 7 }]);
    const res = await listFalsifiedHypotheses(mockRequest(), ENV, "staff-jwt", CH);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveLength(1);
  });

  it("Management can call it too (200)", async () => {
    mockAuth();
    supabaseFetchMock.mockResolvedValueOnce([]);
    const res = await listFalsifiedHypotheses(mockRequest(), ENV, "admin-jwt", CH);
    expect(res.status).toBe(200);
  });

  it("queries status=eq.falsified and does not select research_notes", async () => {
    mockAuth();
    supabaseFetchMock.mockResolvedValueOnce([]);
    await listFalsifiedHypotheses(mockRequest(), ENV, "admin-jwt", CH);
    const [, table, query] = supabaseFetchMock.mock.calls[2];
    expect(table).toBe("kgr_hypotheses");
    expect(query).toContain("status=eq.falsified");
    expect(query).not.toContain("research_notes");
  });
});

describe("deleteFalsifiedHypothesis", () => {
  it("rejects an unauthenticated caller", async () => {
    global.fetch.mockResolvedValueOnce({ ok: false });
    const res = await deleteFalsifiedHypothesis(ENV, "100", "bad-jwt", CH);
    expect(res.status).toBe(401);
    expect(supabaseDeleteMock).not.toHaveBeenCalled();
  });

  it("rejects Staff (Management only)", async () => {
    mockAuth({ role: "frontframe_staff" });
    const res = await deleteFalsifiedHypothesis(ENV, "100", "staff-jwt", CH);
    expect(res.status).toBe(403);
    expect(supabaseDeleteMock).not.toHaveBeenCalled();
  });

  it("404s when the hypothesis does not exist", async () => {
    mockAuth();
    supabaseFetchMock.mockResolvedValueOnce([]);
    const res = await deleteFalsifiedHypothesis(ENV, "100", "admin-jwt", CH);
    expect(res.status).toBe(404);
    expect(supabaseDeleteMock).not.toHaveBeenCalled();
  });

  it("409s naming the actual status when it is not falsified, and makes no delete call", async () => {
    mockAuth();
    supabaseFetchMock.mockResolvedValueOnce([{ id: 100, status: "accepted" }]);
    const res = await deleteFalsifiedHypothesis(ENV, "100", "admin-jwt", CH);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toContain("accepted");
    expect(supabaseDeleteMock).not.toHaveBeenCalled();
  });

  it("Management can delete a falsified hypothesis (200)", async () => {
    mockAuth();
    supabaseFetchMock.mockResolvedValueOnce([{ id: 100, status: "falsified" }]);
    supabaseDeleteMock.mockResolvedValueOnce(undefined);
    const res = await deleteFalsifiedHypothesis(ENV, "100", "admin-jwt", CH);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.deleted).toBe("100");
    expect(supabaseDeleteMock).toHaveBeenCalledWith(ENV, "kgr_hypotheses", "100");
  });
});

// ── setKgrCaseTarget (migration 014 §4.1i) ────────────────────────────────
// Thin wrapper over the set_kgr_case_target RPC. Staff or Management. The
// handler validates resolution_target up front and maps RPC errors to codes;
// combination validation and the target_revision bump live in the RPC.
describe("setKgrCaseTarget", () => {
  it("rejects a missing/invalid JWT before any RPC", async () => {
    mockInvalidJwt();
    const res = await setKgrCaseTarget(mockRequest({ resolution_target: "qa_pair" }), ENV, "7", "bad-jwt", CH);
    expect(res.status).toBe(401);
    expect(supabaseRpcMock).not.toHaveBeenCalled();
  });

  it("rejects an out-of-enum resolution_target (400) without calling the RPC", async () => {
    mockAuth({ role: "frontframe_staff" });
    const res = await setKgrCaseTarget(mockRequest({ resolution_target: "process" }), ENV, "7", "staff-jwt", CH);
    expect(res.status).toBe(400);
    expect(supabaseRpcMock).not.toHaveBeenCalled();
  });

  it("Staff sets a replacement target; args are server-derived and forwarded", async () => {
    mockAuth({ id: "staff-uuid", role: "frontframe_staff" });
    supabaseRpcMock.mockResolvedValueOnce([{ id: 7 }]);                       // set_kgr_case_target
    supabaseFetchMock.mockResolvedValueOnce([{ id: 7, resolution_target: "qa_pair", supersedes_qa_pair_id: "qa-1", target_revision: 3 }]); // fetchCase

    const res = await setKgrCaseTarget(
      mockRequest({ resolution_target: "qa_pair", supersedes_qa_pair_id: "qa-1", p_reviewer: "attacker" }),
      ENV, "7", "staff-jwt", CH,
    );
    expect(res.status).toBe(200);
    const [, fn, args] = supabaseRpcMock.mock.calls[0];
    expect(fn).toBe("set_kgr_case_target");
    expect(args).toMatchObject({
      p_case_id: 7, p_target: "qa_pair", p_supersedes_qa_pair_id: "qa-1",
      p_sp_page: null, p_reviewer: "staff-uuid",
    });
  });

  it("passes a system_prompt page through as p_sp_page", async () => {
    mockAuth({ id: "admin-uuid" });
    supabaseRpcMock.mockResolvedValueOnce([{ id: 7 }]);
    supabaseFetchMock.mockResolvedValueOnce([{ id: 7, resolution_target: "system_prompt", target_system_prompt_page: "home" }]);
    const res = await setKgrCaseTarget(
      mockRequest({ resolution_target: "system_prompt", target_system_prompt_page: "home" }),
      ENV, "7", "admin-jwt", CH,
    );
    expect(res.status).toBe(200);
    const [, , args] = supabaseRpcMock.mock.calls[0];
    expect(args.p_sp_page).toBe("home");
    expect(args.p_supersedes_qa_pair_id).toBeNull();
  });

  it("maps the RPC 'in_development' guard to 409", async () => {
    mockAuth();
    supabaseRpcMock.mockRejectedValueOnce(new Error("case 7 is ready_for_decision - the target can only be changed while in_development"));
    const res = await setKgrCaseTarget(mockRequest({ resolution_target: "qa_pair" }), ENV, "7", "admin-jwt", CH);
    expect(res.status).toBe(409);
  });

  it("maps an RPC 'not found' to 404", async () => {
    mockAuth();
    supabaseRpcMock.mockRejectedValueOnce(new Error("case 7 not found"));
    const res = await setKgrCaseTarget(mockRequest({ resolution_target: "qa_pair" }), ENV, "7", "admin-jwt", CH);
    expect(res.status).toBe(404);
  });
});

// ── openCompanionCase (migration 014 §4.1j) ──────────────────────────────
// :id is the PARENT case; the handler reads its gap_resolution_request_id and
// calls open_companion_case with that + the sub-problem text.
describe("openCompanionCase", () => {
  it("rejects a missing/invalid JWT before any read", async () => {
    mockInvalidJwt();
    const res = await openCompanionCase(mockRequest({ problem_text: "x" }), ENV, "7", "bad-jwt", CH);
    expect(res.status).toBe(401);
    expect(supabaseRpcMock).not.toHaveBeenCalled();
  });

  it("404s when the parent case does not exist", async () => {
    mockAuth({ role: "frontframe_staff" });
    supabaseFetchMock.mockResolvedValueOnce([]);   // parent case lookup
    const res = await openCompanionCase(mockRequest({ problem_text: "sub-problem" }), ENV, "999", "staff-jwt", CH);
    expect(res.status).toBe(404);
    expect(supabaseRpcMock).not.toHaveBeenCalled();
  });

  it("400s a blank problem_text", async () => {
    mockAuth({ role: "frontframe_staff" });
    supabaseFetchMock.mockResolvedValueOnce([{ gap_resolution_request_id: 42 }]);
    const res = await openCompanionCase(mockRequest({ problem_text: "   " }), ENV, "7", "staff-jwt", CH);
    expect(res.status).toBe(400);
    expect(supabaseRpcMock).not.toHaveBeenCalled();
  });

  it("Staff opens a companion; p_parent_request_id is the parent's request, p_reviewer server-derived", async () => {
    mockAuth({ id: "staff-uuid", role: "frontframe_staff" });
    supabaseFetchMock
      .mockResolvedValueOnce([{ gap_resolution_request_id: 42 }])            // parent case lookup
      .mockResolvedValueOnce([{ id: 8, status: "in_development", resolution_target: "qa_pair", target_revision: 0 }]); // fetchCase(8)
    supabaseRpcMock.mockResolvedValueOnce([{ request_id: 99, case_id: 8 }]); // open_companion_case

    const res = await openCompanionCase(
      mockRequest({ problem_text: "the second corpus target", p_reviewer: "attacker" }),
      ENV, "7", "staff-jwt", CH,
    );
    expect(res.status).toBe(200);
    const [, fn, args] = supabaseRpcMock.mock.calls[0];
    expect(fn).toBe("open_companion_case");
    expect(args).toMatchObject({
      p_parent_request_id: 42, p_problem_text: "the second corpus target", p_reviewer: "staff-uuid",
    });
  });

  it("maps the RPC 'no case' guard to 409", async () => {
    mockAuth();
    supabaseFetchMock.mockResolvedValueOnce([{ gap_resolution_request_id: 42 }]);
    supabaseRpcMock.mockRejectedValueOnce(new Error("parent request 42 has no case - a companion hangs off a real case"));
    const res = await openCompanionCase(mockRequest({ problem_text: "x" }), ENV, "7", "admin-jwt", CH);
    expect(res.status).toBe(409);
  });
});

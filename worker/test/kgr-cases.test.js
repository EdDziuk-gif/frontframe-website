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
} = await import("../src/routes/kgr.js");

const CH = {};
const ENV = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
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
  vi.clearAllMocks();
});

// ── createKgrCase ────────────────────────────────────────────────────────

describe("createKgrCase", () => {
  it("rejects a missing/invalid JWT", async () => {
    mockInvalidJwt();
    const res = await createKgrCase(mockRequest({ gap_resolution_request_id: 1 }), ENV, "bad-jwt", CH);
    expect(res.status).toBe(401);
    expect(supabasePostMock).not.toHaveBeenCalled();
  });

  it("rejects a Staff caller - case creation is Management-only", async () => {
    mockAuth({ role: "frontframe_staff" });
    const res = await createKgrCase(mockRequest({ gap_resolution_request_id: 1 }), ENV, "staff-jwt", CH);
    expect(res.status).toBe(403);
    expect(supabasePostMock).not.toHaveBeenCalled();
  });

  it("rejects when the parent intake row is not authorized", async () => {
    mockAuth();
    supabaseFetchMock.mockResolvedValueOnce([{ id: 1, authorized_at: null }]); // parent lookup
    const res = await createKgrCase(mockRequest({ gap_resolution_request_id: 1 }), ENV, "admin-jwt", CH);
    expect(res.status).toBe(403);
    expect(supabasePostMock).not.toHaveBeenCalled();
  });

  it("rejects when the parent intake row does not exist", async () => {
    mockAuth();
    supabaseFetchMock.mockResolvedValueOnce([]); // parent lookup
    const res = await createKgrCase(mockRequest({ gap_resolution_request_id: 999 }), ENV, "admin-jwt", CH);
    expect(res.status).toBe(404);
  });

  it("is idempotent: a second call for the same intake row returns 409 with the existing case, not a duplicate", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 1, authorized_at: "2026-09-05T00:00:00.000Z" }]) // parent lookup
      .mockResolvedValueOnce([{ id: 42 }]) // existing kgr_cases lookup by gap_resolution_request_id
      .mockResolvedValueOnce([{ id: 42, status: "in_development" }]); // fetchCase(42)

    const res = await createKgrCase(mockRequest({ gap_resolution_request_id: 1 }), ENV, "admin-jwt", CH);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.case.id).toBe(42);
    expect(supabasePostMock).not.toHaveBeenCalled();
  });

  it("creates a case for a Management caller on an authorized row, created_by derived server-side (never caller-supplied)", async () => {
    mockAuth({ id: "delegate-uuid" });
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 1, authorized_at: "2026-09-05T00:00:00.000Z" }]) // parent lookup
      .mockResolvedValueOnce([]) // no existing case
      .mockResolvedValueOnce([{ id: 7, status: "in_development" }]); // fetchCase(7) after insert
    supabasePostMock.mockResolvedValueOnce([{ id: 7 }]);

    const res = await createKgrCase(
      mockRequest({ gap_resolution_request_id: 1, created_by: "attacker-uuid" }),
      ENV, "admin-jwt", CH,
    );

    expect(res.status).toBe(200);
    const [, table, payload] = supabasePostMock.mock.calls[0];
    expect(table).toBe("kgr_cases");
    expect(payload.created_by).toBe("delegate-uuid");
    expect(payload.gap_resolution_request_id).toBe(1);
    expect(payload.status).toBe("in_development");
  });
});

// ── development: Staff-permitted ────────────────────────────────────────

describe("Staff may develop an existing authorized case", () => {
  it("allows Staff to update research_notes", async () => {
    mockAuth({ role: "frontframe_staff", id: "staff-uuid" });
    supabaseFetchMock.mockResolvedValueOnce([{ id: 7, status: "in_development" }]); // fetchCase
    supabasePatchMock.mockResolvedValueOnce([{ id: 7 }]);

    const res = await updateKgrCase(mockRequest({ research_notes: "Found the CDN vendor page." }), ENV, "7", "staff-jwt", CH);
    expect(res.status).toBe(200);
    expect(supabasePatchMock).toHaveBeenCalledWith(ENV, "kgr_cases", "7", expect.objectContaining({
      research_notes: "Found the CDN vendor page.",
    }));
  });

  it("allows Staff to add a hypothesis, created_by derived server-side", async () => {
    mockAuth({ role: "frontframe_staff", id: "staff-uuid" });
    supabaseFetchMock.mockResolvedValueOnce([{ id: 7, status: "in_development" }]); // fetchCase
    supabasePostMock.mockResolvedValueOnce([{ id: 100 }]);

    const res = await addHypothesis(
      mockRequest({ description: "No formal SLA exists.", created_by: "attacker-uuid" }),
      ENV, "7", "staff-jwt", CH,
    );

    expect(res.status).toBe(200);
    const [, table, payload] = supabasePostMock.mock.calls[0];
    expect(table).toBe("kgr_hypotheses");
    expect(payload.created_by).toBe("staff-uuid");
    expect(payload.status).toBe("untested");
  });

  it("rejects edits to a frozen (non-in_development) case", async () => {
    mockAuth({ role: "frontframe_staff" });
    supabaseFetchMock.mockResolvedValueOnce([{ id: 7, status: "ready_for_decision" }]);
    const res = await updateKgrCase(mockRequest({ research_notes: "too late" }), ENV, "7", "staff-jwt", CH);
    expect(res.status).toBe(409);
    expect(supabasePatchMock).not.toHaveBeenCalled();
  });
});

// ── hypothesis disposition ──────────────────────────────────────────────

describe("updateHypothesis", () => {
  it("rejects a status other than falsified/accepted", async () => {
    mockAuth();
    supabaseFetchMock.mockResolvedValueOnce([{ id: 7, status: "in_development" }]); // fetchCase
    const res = await updateHypothesis(mockRequest({ status: "untested" }), ENV, "7", "100", "admin-jwt", CH);
    expect(res.status).toBe(400);
  });

  it("rejects accepting a hypothesis with no test_notes", async () => {
    mockAuth();
    supabaseFetchMock.mockResolvedValueOnce([{ id: 7, status: "in_development" }]); // fetchCase
    const res = await updateHypothesis(mockRequest({ status: "accepted" }), ENV, "7", "100", "admin-jwt", CH);
    expect(res.status).toBe(400);
    expect(supabasePatchMock).not.toHaveBeenCalled();
  });

  it("rejects falsifying a hypothesis with blank/whitespace-only test_notes", async () => {
    mockAuth();
    supabaseFetchMock.mockResolvedValueOnce([{ id: 7, status: "in_development" }]); // fetchCase
    const res = await updateHypothesis(mockRequest({ status: "falsified", test_notes: "   " }), ENV, "7", "100", "admin-jwt", CH);
    expect(res.status).toBe(400);
    expect(supabasePatchMock).not.toHaveBeenCalled();
  });

  it("rejects changing a hypothesis that is already disposed (not untested)", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "in_development" }]) // fetchCase
      .mockResolvedValueOnce([{ id: 100, status: "accepted" }]);    // hypothesis lookup
    const res = await updateHypothesis(mockRequest({ status: "falsified", test_notes: "No longer relevant." }), ENV, "7", "100", "admin-jwt", CH);
    expect(res.status).toBe(409);
    expect(supabasePatchMock).not.toHaveBeenCalled();
  });

  it("accepts a valid disposition from untested", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "in_development" }])
      .mockResolvedValueOnce([{ id: 100, status: "untested" }]);
    supabasePatchMock.mockResolvedValueOnce([{ id: 100, status: "accepted" }]);

    const res = await updateHypothesis(mockRequest({ status: "accepted", test_notes: "Confirmed via docs." }), ENV, "7", "100", "admin-jwt", CH);
    expect(res.status).toBe(200);
    expect(supabasePatchMock).toHaveBeenCalledWith(ENV, "kgr_hypotheses", "100", expect.objectContaining({
      status: "accepted", test_notes: "Confirmed via docs.",
    }));
  });

  it("trims test_notes before storing", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "in_development" }])
      .mockResolvedValueOnce([{ id: 100, status: "untested" }]);
    supabasePatchMock.mockResolvedValueOnce([{ id: 100, status: "falsified" }]);

    const res = await updateHypothesis(mockRequest({ status: "falsified", test_notes: "  Superseded by hypothesis: revised timeline theory.  " }), ENV, "7", "100", "admin-jwt", CH);
    expect(res.status).toBe(200);
    expect(supabasePatchMock).toHaveBeenCalledWith(ENV, "kgr_hypotheses", "100", expect.objectContaining({
      status: "falsified", test_notes: "Superseded by hypothesis: revised timeline theory.",
    }));
  });

  it("records a replacement's identity in the falsifying notes when a hypothesis is superseded (traceability is by note content, not a schema link)", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "in_development" }])
      .mockResolvedValueOnce([{ id: 100, status: "untested" }]);
    supabasePatchMock.mockResolvedValueOnce([{ id: 100, status: "falsified" }]);

    const replacementNote = 'Replaced by hypothesis #103 ("revised timeline theory") - original scope was too narrow.';
    const res = await updateHypothesis(mockRequest({ status: "falsified", test_notes: replacementNote }), ENV, "7", "100", "admin-jwt", CH);
    expect(res.status).toBe(200);
    expect(supabasePatchMock).toHaveBeenCalledWith(ENV, "kgr_hypotheses", "100", expect.objectContaining({
      test_notes: replacementNote,
    }));
  });
});

// ── readiness gate ───────────────────────────────────────────────────────

describe("readyKgrCase", () => {
  it("rejects with zero hypotheses", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "in_development" }]) // fetchCase
      .mockResolvedValueOnce([]);                                   // hypotheses
    const res = await readyKgrCase(ENV, "7", "admin-jwt", CH);
    expect(res.status).toBe(409);
    expect(supabasePatchMock).not.toHaveBeenCalled();
  });

  it("rejects with an untested hypothesis present, even alongside an accepted one", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "in_development" }])
      .mockResolvedValueOnce([{ status: "accepted" }, { status: "untested" }]);
    const res = await readyKgrCase(ENV, "7", "admin-jwt", CH);
    expect(res.status).toBe(409);
    expect(supabasePatchMock).not.toHaveBeenCalled();
  });

  it("rejects when all hypotheses are falsified (no accepted)", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "in_development" }])
      .mockResolvedValueOnce([{ status: "falsified" }, { status: "falsified" }]);
    const res = await readyKgrCase(ENV, "7", "admin-jwt", CH);
    expect(res.status).toBe(409);
    expect(supabasePatchMock).not.toHaveBeenCalled();
  });

  it("succeeds with zero untested and at least one accepted", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "in_development" }])
      .mockResolvedValueOnce([{ status: "accepted" }, { status: "falsified" }]);
    supabasePatchMock.mockResolvedValueOnce([{ id: 7, status: "ready_for_decision" }]);

    const res = await readyKgrCase(ENV, "7", "admin-jwt", CH);
    expect(res.status).toBe(200);
    expect(supabasePatchMock).toHaveBeenCalledWith(ENV, "kgr_cases", "7", expect.objectContaining({
      status: "ready_for_decision",
    }));
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

  it("escalates and preserves the reason when the eligibility check returns a candidate", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "in_development", research_notes: "notes" }])
      .mockResolvedValueOnce([{ description: "Does FrontFrame have authority to guarantee X" }])
      .mockResolvedValueOnce([]);
    checkEligibilityMock.mockResolvedValueOnce({ constitutionalCandidate: true, issue: "Requires Operator determination of guarantee authority" });
    supabasePatchMock.mockResolvedValueOnce([{ id: 7, status: "escalated" }]);

    const res = await escalateKgrCase(ENV, "7", "admin-jwt", CH);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.escalated).toBe(true);
    expect(supabasePatchMock).toHaveBeenCalledWith(ENV, "kgr_cases", "7", expect.objectContaining({
      status: "escalated",
      escalation_reason: "Requires Operator determination of guarantee authority",
    }));
  });

  it("is terminal: an already-escalated case rejects a further escalate call", async () => {
    mockAuth();
    supabaseFetchMock.mockResolvedValueOnce([{ id: 7, status: "escalated" }]);
    const res = await escalateKgrCase(ENV, "7", "admin-jwt", CH);
    expect(res.status).toBe(409);
    expect(checkEligibilityMock).not.toHaveBeenCalled();
  });

  it("an escalated case rejects further edits (evidence frozen)", async () => {
    mockAuth();
    supabaseFetchMock.mockResolvedValueOnce([{ id: 7, status: "escalated" }]);
    const res = await updateKgrCase(mockRequest({ research_notes: "x" }), ENV, "7", "admin-jwt", CH);
    expect(res.status).toBe(409);
    expect(supabasePatchMock).not.toHaveBeenCalled();
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
      ]);

    const res = await getKgrCase(ENV, "7", "admin-jwt", CH);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.research_notes).toBe("notes");
    expect(body.hypotheses).toHaveLength(2);
    expect(body.hypotheses.map((h) => h.status)).toEqual(["falsified", "accepted"]);
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
      .mockResolvedValueOnce([]);

    const res = await getKgrCase(ENV, "7", "admin-jwt", CH);
    const body = await res.json();
    expect(body.gap_resolution_requests?.questions?.question_text).toBe("Does FrontFrame offer an SLA?");

    const [, , query] = supabaseFetchMock.mock.calls[2]; // after mockAuth's two reviewer lookups
    expect(query).toContain("gap_resolution_requests(questions(question_text))");
  });

  it("getKgrCase embeds a null resolution_statement when none exists yet", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "ready_for_decision", research_notes: null, escalation_reason: null }])
      .mockResolvedValueOnce([])   // hypotheses
      .mockResolvedValueOnce([]);  // fetchResolutionStatement - none saved
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

describe("prepareResolutionStatement", () => {
  it("rejects an unauthorized caller before touching the case", async () => {
    global.fetch.mockResolvedValueOnce({ ok: false });
    const res = await prepareResolutionStatement(mockRequest({ candidates: [] }), ENV, "7", "bad-jwt", CH);
    expect(res.status).toBe(401);
    expect(supabaseFetchMock).not.toHaveBeenCalled();
    expect(callAnthropicMock).not.toHaveBeenCalled();
  });

  it("rejects a case that is still in_development (409, no scoring call)", async () => {
    mockAuth();
    supabaseFetchMock.mockResolvedValueOnce([{ id: 7, status: "in_development" }]);
    const res = await prepareResolutionStatement(mockRequest({ candidates: [] }), ENV, "7", "admin-jwt", CH);
    expect(res.status).toBe(409);
    expect(callAnthropicMock).not.toHaveBeenCalled();
    expect(supabaseRpcMock).not.toHaveBeenCalled();
  });

  it("rejects an escalated case (409, no scoring call)", async () => {
    mockAuth();
    supabaseFetchMock.mockResolvedValueOnce([{ id: 7, status: "escalated" }]);
    const res = await prepareResolutionStatement(mockRequest({ candidates: [] }), ENV, "7", "admin-jwt", CH);
    expect(res.status).toBe(409);
    expect(callAnthropicMock).not.toHaveBeenCalled();
  });

  it("rejects candidates missing an accepted hypothesis", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "ready_for_decision", gap_resolution_request_id: 1 }]) // fetchCase
      .mockResolvedValueOnce([])  // fetchResolutionStatement - none yet
      .mockResolvedValueOnce([
        { id: 100, status: "accepted" },
        { id: 101, status: "accepted" },
      ]); // fetchHypotheses
    const res = await prepareResolutionStatement(
      mockRequest({ candidates: [{ hypothesis_id: 100, presented_content: "Answer A" }] }),
      ENV, "7", "admin-jwt", CH
    );
    expect(res.status).toBe(400);
    expect(callAnthropicMock).not.toHaveBeenCalled();
  });

  it("rejects candidates including an extra (non-accepted) hypothesis id", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "ready_for_decision", gap_resolution_request_id: 1 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 100, status: "accepted" },
        { id: 101, status: "falsified" },
      ]);
    const res = await prepareResolutionStatement(
      mockRequest({ candidates: [
        { hypothesis_id: 100, presented_content: "Answer A" },
        { hypothesis_id: 101, presented_content: "Answer B" },
      ] }),
      ENV, "7", "admin-jwt", CH
    );
    expect(res.status).toBe(400);
    expect(callAnthropicMock).not.toHaveBeenCalled();
  });

  it("rejects a duplicate hypothesis_id in candidates", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "ready_for_decision", gap_resolution_request_id: 1 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 100, status: "accepted" }]);
    const res = await prepareResolutionStatement(
      mockRequest({ candidates: [
        { hypothesis_id: 100, presented_content: "Answer A" },
        { hypothesis_id: 100, presented_content: "Answer A again" },
      ] }),
      ENV, "7", "admin-jwt", CH
    );
    expect(res.status).toBe(400);
    expect(callAnthropicMock).not.toHaveBeenCalled();
  });

  it("rejects blank presented_content", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "ready_for_decision", gap_resolution_request_id: 1 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ id: 100, status: "accepted" }]);
    const res = await prepareResolutionStatement(
      mockRequest({ candidates: [{ hypothesis_id: 100, presented_content: "   " }] }),
      ENV, "7", "admin-jwt", CH
    );
    expect(res.status).toBe(400);
    expect(callAnthropicMock).not.toHaveBeenCalled();
  });

  it("scores every accepted candidate and saves them together via the RPC, tied to one problem_statement", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{
        id: 7, status: "ready_for_decision", gap_resolution_request_id: 1,
        gap_resolution_requests: { questions: { question_text: "Does FrontFrame offer an SLA?" } },
      }]) // fetchCase
      .mockResolvedValueOnce([])  // fetchResolutionStatement - none yet
      .mockResolvedValueOnce([
        { id: 100, status: "accepted" },
        { id: 101, status: "accepted" },
        { id: 102, status: "falsified" },
      ]) // fetchHypotheses
      .mockResolvedValueOnce([{  // final re-fetch of the saved statement
        id: 55, kgr_case_id: 7, problem_statement: "Does FrontFrame offer an SLA?", prepared_by: "rev-uuid",
        kgr_resolution_candidates: [
          { id: 1, kgr_hypothesis_id: 100, presented_content: "Answer A", score: 0.8, rationale: "Directly responsive." },
          { id: 2, kgr_hypothesis_id: 101, presented_content: "Answer B", score: 0.3, rationale: "Off-topic." },
        ],
      }]);
    callAnthropicMock
      .mockResolvedValueOnce(scoreResponse(0.8, "Directly responsive."))
      .mockResolvedValueOnce(scoreResponse(0.3, "Off-topic."));
    supabaseRpcMock.mockResolvedValueOnce(55);

    const res = await prepareResolutionStatement(
      mockRequest({ candidates: [
        { hypothesis_id: 100, presented_content: "Answer A" },
        { hypothesis_id: 101, presented_content: "Answer B" },
      ] }),
      ENV, "7", "admin-jwt", CH
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBe(55);
    expect(body.kgr_resolution_candidates).toHaveLength(2);

    // The low-scored candidate (0.3) is still persisted - no threshold gates it.
    expect(supabaseRpcMock).toHaveBeenCalledTimes(1);
    const [, fnName, params] = supabaseRpcMock.mock.calls[0];
    expect(fnName).toBe("save_kgr_resolution_statement");
    expect(params.p_prepared_by).toBe("rev-uuid"); // server-derived, never caller-supplied
    expect(params.p_problem_statement).toBe("Does FrontFrame offer an SLA?");
    expect(params.p_candidates).toHaveLength(2);
    expect(params.p_candidates.find((c) => c.hypothesis_id === 101).score).toBe(0.3);
  });

  it("leaves nothing written when scoring fails partway through", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{
        id: 7, status: "ready_for_decision", gap_resolution_request_id: 1,
        gap_resolution_requests: { questions: { question_text: "Does FrontFrame offer an SLA?" } },
      }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { id: 100, status: "accepted" },
        { id: 101, status: "accepted" },
      ]);
    callAnthropicMock
      .mockResolvedValueOnce(scoreResponse(0.8, "Directly responsive."))
      .mockRejectedValueOnce(new Error("model unavailable"));

    const res = await prepareResolutionStatement(
      mockRequest({ candidates: [
        { hypothesis_id: 100, presented_content: "Answer A" },
        { hypothesis_id: 101, presented_content: "Answer B" },
      ] }),
      ENV, "7", "admin-jwt", CH
    );
    expect(res.status).toBe(502);
    expect(supabaseRpcMock).not.toHaveBeenCalled();
  });

  it("returns the existing statement (409) on a repeat call, without rescoring", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "ready_for_decision", gap_resolution_request_id: 1 }]) // fetchCase
      .mockResolvedValueOnce([{ id: 55, kgr_case_id: 7, problem_statement: "Does FrontFrame offer an SLA?" }]); // existing statement
    const res = await prepareResolutionStatement(
      mockRequest({ candidates: [{ hypothesis_id: 100, presented_content: "Answer A" }] }),
      ENV, "7", "admin-jwt", CH
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.resolution_statement.id).toBe(55);
    expect(callAnthropicMock).not.toHaveBeenCalled();
    expect(supabaseRpcMock).not.toHaveBeenCalled();
  });

  it("handles a concurrent-race loss gracefully: the RPC's unique_violation resolves to a 409 with the winner's statement", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{
        id: 7, status: "ready_for_decision", gap_resolution_request_id: 1,
        gap_resolution_requests: { questions: { question_text: "Does FrontFrame offer an SLA?" } },
      }])
      .mockResolvedValueOnce([])  // no existing statement seen at check time
      .mockResolvedValueOnce([{ id: 100, status: "accepted" }])
      .mockResolvedValueOnce([{ id: 55, kgr_case_id: 7, problem_statement: "Does FrontFrame offer an SLA?" }]); // winner, found on re-fetch
    callAnthropicMock.mockResolvedValueOnce(scoreResponse(0.8, "Directly responsive."));
    supabaseRpcMock.mockRejectedValueOnce(new Error("duplicate key value violates unique constraint"));

    const res = await prepareResolutionStatement(
      mockRequest({ candidates: [{ hypothesis_id: 100, presented_content: "Answer A" }] }),
      ENV, "7", "admin-jwt", CH
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.resolution_statement.id).toBe(55);
  });

  it("re-fetching the case after preparation returns the identical persisted statement", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "ready_for_decision", research_notes: null, escalation_reason: null }])
      .mockResolvedValueOnce([])  // hypotheses
      .mockResolvedValueOnce([{
        id: 55, kgr_case_id: 7, problem_statement: "Does FrontFrame offer an SLA?",
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
      .mockResolvedValueOnce([]) // hypotheses
      .mockResolvedValueOnce([]); // resolution statement
    await getKgrCase(ENV, "7", "admin-jwt", CH);
    const stmtCall = supabaseFetchMock.mock.calls.find((c) => c[1] === "kgr_resolution_statements");
    expect(stmtCall[2]).toContain("selected_candidate_id");
    expect(stmtCall[2]).toContain("signed_off_by");
    expect(stmtCall[2]).toContain("signed_off_at");
    expect(stmtCall[2]).toContain("qa_pair_id");
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

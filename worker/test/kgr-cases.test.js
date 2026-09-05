import { beforeEach, describe, expect, it, vi } from "vitest";

// Phase F Candidate 2, Increment 2 — KGR case development record.
// Scope: kgr_cases / kgr_hypotheses lifecycle only. No resolution statement,
// scoring, sign-off, promulgation, or notification path exists yet, so none
// of that is exercised here - this increment is a development record only.

const supabaseFetchMock = vi.fn();
const supabasePostMock  = vi.fn();
const supabasePatchMock = vi.fn();
const callAnthropicMock = vi.fn();
const checkEligibilityMock = vi.fn();

vi.mock("../src/shared/supabase.js", () => ({
  supabaseFetch: (...a) => supabaseFetchMock(...a),
  supabasePost:  (...a) => supabasePostMock(...a),
  supabasePatch: (...a) => supabasePatchMock(...a),
  supabasePatchByField: vi.fn(),
  supabaseRpc:   vi.fn(),
  supabaseUpsert: vi.fn(),
  supabaseDelete: vi.fn(),
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

  it("rejects changing a hypothesis that is already disposed (not untested)", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "in_development" }]) // fetchCase
      .mockResolvedValueOnce([{ id: 100, status: "accepted" }]);    // hypothesis lookup
    const res = await updateHypothesis(mockRequest({ status: "falsified" }), ENV, "7", "100", "admin-jwt", CH);
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
});

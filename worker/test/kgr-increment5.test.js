import { beforeEach, describe, expect, it, vi } from "vitest";

// Phase F Candidate 2, Increment 5 — human-contributed candidate solutions.
// Worker layer: the submit / withdraw handlers, the equal-rigor sequence
// (constitutional screen -> score -> atomic RPC), reject-without-write on a
// screen hit or a scoring failure, idempotent retry, and the deploy-window
// mutation gate. The database-level guarantees (serialization, coverage rule,
// N:1 snapshot, N:1-safe pruning) are in supabase/tests/010_012_kgr_increment5.test.mjs.

const supabaseFetchMock = vi.fn();
const supabasePostMock  = vi.fn();
const supabasePatchMock = vi.fn();
const supabaseRpcMock   = vi.fn();
const callAnthropicMock = vi.fn();
const checkEligibilityMock = vi.fn();

vi.mock("../src/shared/supabase.js", () => ({
  supabaseFetch: (...a) => supabaseFetchMock(...a),
  supabasePost:  (...a) => supabasePostMock(...a),
  supabasePatch: (...a) => supabasePatchMock(...a),
  supabasePatchByField: vi.fn(),
  supabaseRpc:   (...a) => supabaseRpcMock(...a),
  supabaseUpsert: vi.fn(),
  supabaseDelete: vi.fn(),
  supabaseHeaders: () => ({}),
}));

vi.mock("../src/shared/runtime.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, callAnthropic: (...a) => callAnthropicMock(...a), sendSms: vi.fn() };
});

vi.mock("../src/shared/scoring.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, checkConstitutionalEligibility: (...a) => checkEligibilityMock(...a) };
});

global.fetch = vi.fn();

const { submitKgrSolution, withdrawKgrSolution } = await import("../src/routes/kgr.js");

const CH = {};
// RATE_LIMIT_KV stub reports "not paused"; the gate fails closed without it.
const ENV = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k", RATE_LIMIT_KV: { get: async () => null } };
const mockRequest = (body = {}) => ({ json: () => Promise.resolve(body) });

function mockAuth({ id = "rev-uuid", role = "frontframe_admin", active = true, can_amend_constitution = false } = {}) {
  global.fetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ email: "r@frontframe.co" }) });
  supabaseFetchMock
    .mockResolvedValueOnce([{ id, role, active, can_amend_constitution }]);
}
const mockInvalidJwt = () => global.fetch.mockResolvedValueOnce({ ok: false });
const scoreJson = (score, rationale) => JSON.stringify({ score, rationale });

// Case in_development with an accepted hypothesis #100 and a frozen
// contribution problem snapshot already set.
function mockCaseAndAcceptedHyp({
  caseRow = { id: 7, status: "in_development", gap_resolution_request_id: 1, contribution_problem_snapshot: "How does X work?" },
  hyps = [{ id: 100, status: "accepted" }],
  prior = [],
} = {}) {
  supabaseFetchMock
    .mockResolvedValueOnce([caseRow]) // fetchCase
    .mockResolvedValueOnce(hyps)      // fetchHypotheses
    .mockResolvedValueOnce(prior);    // prior submission_key lookup
}

beforeEach(() => vi.clearAllMocks());

describe("submitKgrSolution — auth and validation", () => {
  it("401s an unauthenticated caller, before any read", async () => {
    mockInvalidJwt();
    const res = await submitKgrSolution(mockRequest({}), ENV, "7", "bad", CH);
    expect(res.status).toBe(401);
    expect(supabaseFetchMock).not.toHaveBeenCalled();
  });

  it("403s a role that is neither Management nor Staff", async () => {
    mockAuth({ role: "contractor" });
    const res = await submitKgrSolution(mockRequest({}), ENV, "7", "jwt", CH);
    expect(res.status).toBe(403);
  });

  it("404s when the case does not exist", async () => {
    mockAuth();
    supabaseFetchMock.mockResolvedValueOnce([]); // fetchCase
    const res = await submitKgrSolution(mockRequest({ hypothesis_id: 1, proposed_content: "x", origin: "human", submission_key: "k" }), ENV, "7", "jwt", CH);
    expect(res.status).toBe(404);
  });

  it("409s when the case is not in_development", async () => {
    mockAuth();
    supabaseFetchMock.mockResolvedValueOnce([{ id: 7, status: "ready_for_decision" }]);
    const res = await submitKgrSolution(mockRequest({ hypothesis_id: 1, proposed_content: "x", origin: "human", submission_key: "k" }), ENV, "7", "jwt", CH);
    expect(res.status).toBe(409);
  });

  it("400s on missing / invalid fields", async () => {
    for (const body of [
      {},
      { hypothesis_id: 0, proposed_content: "x", origin: "human", submission_key: "k" },
      { hypothesis_id: 1, proposed_content: "  ", origin: "human", submission_key: "k" },
      { hypothesis_id: 1, proposed_content: "x", origin: "management", submission_key: "k" },
      { hypothesis_id: 1, proposed_content: "x", origin: "human", submission_key: " " },
    ]) {
      vi.clearAllMocks();
      mockAuth();
      supabaseFetchMock.mockResolvedValueOnce([{ id: 7, status: "in_development" }]);
      const res = await submitKgrSolution(mockRequest(body), ENV, "7", "jwt", CH);
      expect(res.status).toBe(400);
      expect(supabaseRpcMock).not.toHaveBeenCalled();
    }
  });

  it("404s when the hypothesis is not on the case; 409s when it is not accepted", async () => {
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "in_development" }])
      .mockResolvedValueOnce([{ id: 100, status: "untested" }]);
    const res1 = await submitKgrSolution(mockRequest({ hypothesis_id: 999, proposed_content: "x", origin: "human", submission_key: "k" }), ENV, "7", "jwt", CH);
    expect(res1.status).toBe(404);

    vi.clearAllMocks();
    mockAuth();
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: 7, status: "in_development" }])
      .mockResolvedValueOnce([{ id: 100, status: "untested" }]);
    const res2 = await submitKgrSolution(mockRequest({ hypothesis_id: 100, proposed_content: "x", origin: "human", submission_key: "k" }), ENV, "7", "jwt", CH);
    expect(res2.status).toBe(409);
    expect(supabaseRpcMock).not.toHaveBeenCalled();
  });
});

describe("submitKgrSolution — equal-rigor sequence", () => {
  it("422s on a constitutional screen hit: no score call, no RPC, case not escalated", async () => {
    mockAuth();
    mockCaseAndAcceptedHyp();
    supabaseFetchMock.mockResolvedValueOnce([]); // constitution_provisions
    checkEligibilityMock.mockResolvedValueOnce({ constitutionalCandidate: true, issue: "authority question" });

    const res = await submitKgrSolution(
      mockRequest({ hypothesis_id: 100, proposed_content: "an answer", origin: "human", submission_key: "k1" }),
      ENV, "7", "jwt", CH
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.issue).toBe("authority question");
    expect(callAnthropicMock).not.toHaveBeenCalled(); // scorer never runs
    expect(supabaseRpcMock).not.toHaveBeenCalled();
    expect(supabasePatchMock).not.toHaveBeenCalled(); // no escalation write
  });

  it("502s when scoring throws: nothing written", async () => {
    mockAuth();
    mockCaseAndAcceptedHyp();
    supabaseFetchMock.mockResolvedValueOnce([]); // provisions
    checkEligibilityMock.mockResolvedValueOnce({ constitutionalCandidate: false, issue: null });
    callAnthropicMock.mockRejectedValueOnce(new Error("model unavailable"));

    const res = await submitKgrSolution(
      mockRequest({ hypothesis_id: 100, proposed_content: "an answer", origin: "human", submission_key: "k1" }),
      ENV, "7", "jwt", CH
    );
    expect(res.status).toBe(502);
    expect(supabaseRpcMock).not.toHaveBeenCalled();
  });

  it("201 happy path: screens, scores once, then calls submit_kgr_solution with server-derived args", async () => {
    mockAuth({ id: "staff-a", role: "frontframe_staff" });
    mockCaseAndAcceptedHyp();
    supabaseFetchMock.mockResolvedValueOnce([]); // provisions
    checkEligibilityMock.mockResolvedValueOnce({ constitutionalCandidate: false, issue: null });
    callAnthropicMock.mockResolvedValueOnce(scoreJson(0.66, "Reasonably on point."));
    supabaseRpcMock.mockResolvedValueOnce([{ id: 501, status: "active", proposed_content: "an answer" }]);

    const res = await submitKgrSolution(
      mockRequest({ hypothesis_id: 100, proposed_content: "an answer", origin: "assistant_assisted", submission_key: "k1", score: 0.99, submitted_by: "attacker" }),
      ENV, "7", "jwt", CH
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.solution.id).toBe(501);

    expect(callAnthropicMock).toHaveBeenCalledTimes(1); // exactly one score call
    const [, fnName, params] = supabaseRpcMock.mock.calls[0];
    expect(fnName).toBe("submit_kgr_solution");
    expect(params.p_submitted_by).toBe("staff-a");      // server-derived, never body-supplied
    expect(params.p_score).toBe(0.66);                  // from the scorer, not body.score
    expect(params.p_origin).toBe("assistant_assisted");
    expect(params.p_problem_snapshot).toBe("How does X work?"); // the case's frozen snapshot
    expect(typeof params.p_provisions_hash).toBe("string");
    expect(params.p_provisions_hash.length).toBeGreaterThan(0);
    expect(params.p_submission_key).toBe("k1");
  });

  it("derives the problem text from the origin question when no snapshot is set yet", async () => {
    mockAuth();
    mockCaseAndAcceptedHyp({
      caseRow: { id: 7, status: "in_development", gap_resolution_request_id: 1, contribution_problem_snapshot: null, gap_resolution_requests: { questions: { question_text: "Origin question?" } } },
    });
    supabaseFetchMock.mockResolvedValueOnce([]); // provisions
    checkEligibilityMock.mockResolvedValueOnce({ constitutionalCandidate: false, issue: null });
    callAnthropicMock.mockResolvedValueOnce(scoreJson(0.5, "ok"));
    supabaseRpcMock.mockResolvedValueOnce([{ id: 502 }]);

    await submitKgrSolution(
      mockRequest({ hypothesis_id: 100, proposed_content: "x", origin: "human", submission_key: "k1" }),
      ENV, "7", "jwt", CH
    );
    const [, , params] = supabaseRpcMock.mock.calls[0];
    expect(params.p_problem_snapshot).toBe("Origin question?");
  });
});

describe("submitKgrSolution — idempotent retry", () => {
  it("200s and does not re-score when the same key + same content was already recorded", async () => {
    mockAuth();
    mockCaseAndAcceptedHyp({ prior: [{ id: 501, proposed_content: "an answer" }] });
    supabaseFetchMock.mockResolvedValueOnce([{ id: 501, status: "active", proposed_content: "an answer" }]); // re-read the row

    const res = await submitKgrSolution(
      mockRequest({ hypothesis_id: 100, proposed_content: "an answer", origin: "human", submission_key: "k1" }),
      ENV, "7", "jwt", CH
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.solution.id).toBe(501);
    expect(callAnthropicMock).not.toHaveBeenCalled();
    expect(supabaseRpcMock).not.toHaveBeenCalled();
  });

  it("409s when the same key was used for different content", async () => {
    mockAuth();
    mockCaseAndAcceptedHyp({ prior: [{ id: 501, proposed_content: "the original answer" }] });

    const res = await submitKgrSolution(
      mockRequest({ hypothesis_id: 100, proposed_content: "a DIFFERENT answer", origin: "human", submission_key: "k1" }),
      ENV, "7", "jwt", CH
    );
    expect(res.status).toBe(409);
    expect(supabaseRpcMock).not.toHaveBeenCalled();
  });
});

describe("withdrawKgrSolution", () => {
  it("400s on a blank reason, before the RPC", async () => {
    mockAuth();
    const res = await withdrawKgrSolution(mockRequest({ reason: "  " }), ENV, "7", "501", "jwt", CH);
    expect(res.status).toBe(400);
    expect(supabaseRpcMock).not.toHaveBeenCalled();
  });

  it("200 happy path: calls withdraw_kgr_solution with the actor id and role", async () => {
    mockAuth({ id: "staff-a", role: "frontframe_staff" });
    supabaseRpcMock.mockResolvedValueOnce([{ id: 501, status: "withdrawn", withdrawn_reason: "superseded" }]);
    const res = await withdrawKgrSolution(mockRequest({ reason: "superseded" }), ENV, "7", "501", "jwt", CH);
    expect(res.status).toBe(200);
    const [, fnName, params] = supabaseRpcMock.mock.calls[0];
    expect(fnName).toBe("withdraw_kgr_solution");
    expect(params.p_case_id).toBe(7);
    expect(params.p_solution_id).toBe(501);
    expect(params.p_actor_id).toBe("staff-a");
    expect(params.p_actor_role).toBe("frontframe_staff");
    expect(params.p_reason).toBe("superseded");
  });

  it("maps the RPC's authority error to 403", async () => {
    mockAuth({ role: "frontframe_staff" });
    supabaseRpcMock.mockRejectedValueOnce(new Error("Supabase RPC withdraw_kgr_solution failed: only the contributor or Management may withdraw this solution"));
    const res = await withdrawKgrSolution(mockRequest({ reason: "x" }), ENV, "7", "501", "jwt", CH);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).not.toContain("Supabase RPC");
  });

  it("maps 'is not on case' to 404 and other guard failures to 409", async () => {
    mockAuth();
    supabaseRpcMock.mockRejectedValueOnce(new Error("Supabase RPC withdraw_kgr_solution failed: solution 501 is not on case 7"));
    const res1 = await withdrawKgrSolution(mockRequest({ reason: "x" }), ENV, "7", "501", "jwt", CH);
    expect(res1.status).toBe(404);

    vi.clearAllMocks();
    mockAuth();
    supabaseRpcMock.mockRejectedValueOnce(new Error("case 7 is ready_for_decision - solutions can no longer be withdrawn"));
    const res2 = await withdrawKgrSolution(mockRequest({ reason: "x" }), ENV, "7", "501", "jwt", CH);
    expect(res2.status).toBe(409);
  });
});

describe("KGR mutation gate (deploy-window pause)", () => {
  const pausedEnv = { ...ENV, RATE_LIMIT_KV: { get: vi.fn().mockResolvedValue("true") } };

  it("503s a solution submit while paused, after auth, before any DB read or RPC", async () => {
    mockAuth();
    const res = await submitKgrSolution(
      mockRequest({ hypothesis_id: 100, proposed_content: "x", origin: "human", submission_key: "k1" }),
      pausedEnv, "7", "jwt", CH
    );
    expect(res.status).toBe(503);
    expect(supabaseFetchMock).toHaveBeenCalledTimes(1); // only mockAuth's reviewer lookup
    expect(supabaseRpcMock).not.toHaveBeenCalled();
  });

  it("503s a withdrawal while paused", async () => {
    mockAuth();
    const res = await withdrawKgrSolution(mockRequest({ reason: "x" }), pausedEnv, "7", "501", "jwt", CH);
    expect(res.status).toBe(503);
    expect(supabaseRpcMock).not.toHaveBeenCalled();
  });

  it("does not gate when the KV flag is absent or not 'true'", async () => {
    const openEnv = { ...ENV, RATE_LIMIT_KV: { get: vi.fn().mockResolvedValue(null) } };
    mockAuth();
    supabaseFetchMock.mockResolvedValueOnce([]); // fetchCase -> 404 path, but past the gate
    const res = await submitKgrSolution(
      mockRequest({ hypothesis_id: 100, proposed_content: "x", origin: "human", submission_key: "k1" }),
      openEnv, "7", "jwt", CH
    );
    expect(res.status).toBe(404); // reached the handler body
  });

  it("FAILS CLOSED (503) when the KV binding is missing entirely", async () => {
    const noKvEnv = { SUPABASE_URL: ENV.SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY: "k" }; // no RATE_LIMIT_KV
    mockAuth();
    const res = await submitKgrSolution(
      mockRequest({ hypothesis_id: 100, proposed_content: "x", origin: "human", submission_key: "k1" }),
      noKvEnv, "7", "jwt", CH
    );
    expect(res.status).toBe(503);
    expect(supabaseRpcMock).not.toHaveBeenCalled();
  });

  it("FAILS CLOSED (503) when the KV read throws", async () => {
    const throwEnv = { ...ENV, RATE_LIMIT_KV: { get: vi.fn().mockRejectedValue(new Error("KV unavailable")) } };
    mockAuth();
    const res = await withdrawKgrSolution(mockRequest({ reason: "x" }), throwEnv, "7", "501", "jwt", CH);
    expect(res.status).toBe(503);
    expect(supabaseRpcMock).not.toHaveBeenCalled();
  });
});

describe("submitKgrSolution — concurrent-first-contribution snapshot race", () => {
  it("re-reads and re-scores against the stored snapshot when the RPC reports a mismatch, then retries once", async () => {
    mockAuth({ id: "staff-b", role: "frontframe_staff" });
    // First fetchCase: no snapshot yet, so the handler derives from the origin question.
    mockCaseAndAcceptedHyp({
      caseRow: { id: 7, status: "in_development", gap_resolution_request_id: 1, contribution_problem_snapshot: null, gap_resolution_requests: { questions: { question_text: "Derived-A" } } },
    });
    supabaseFetchMock.mockResolvedValueOnce([]); // provisions (screen)
    checkEligibilityMock.mockResolvedValueOnce({ constitutionalCandidate: false, issue: null });
    callAnthropicMock
      .mockResolvedValueOnce(scoreJson(0.6, "scored vs Derived-A"))  // first score
      .mockResolvedValueOnce(scoreJson(0.7, "re-scored vs stored")); // re-score after mismatch
    supabaseRpcMock.mockRejectedValueOnce(new Error("Supabase RPC submit_kgr_solution failed: problem snapshot mismatch - re-read the case and re-score against contribution_problem_snapshot"));
    // Handler re-fetches the case; another writer set the snapshot in the meantime.
    supabaseFetchMock.mockResolvedValueOnce([{ id: 7, status: "in_development", gap_resolution_request_id: 1, contribution_problem_snapshot: "Stored-B" }]);
    supabaseRpcMock.mockResolvedValueOnce([{ id: 777, status: "active" }]);

    const res = await submitKgrSolution(
      mockRequest({ hypothesis_id: 100, proposed_content: "my answer", origin: "human", submission_key: "k1" }),
      ENV, "7", "jwt", CH
    );
    expect(res.status).toBe(201);
    expect(callAnthropicMock).toHaveBeenCalledTimes(2);
    // The retry RPC call used the stored snapshot and its re-score.
    const retryArgs = supabaseRpcMock.mock.calls[1][2];
    expect(retryArgs.p_problem_snapshot).toBe("Stored-B");
    expect(retryArgs.p_score).toBe(0.7);
  });
});

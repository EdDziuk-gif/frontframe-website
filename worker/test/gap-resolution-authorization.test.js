import { beforeEach, describe, expect, it, vi } from "vitest";

// Phase F Candidate 2, Increment 1 — KGR intake authorization gate.
// Scope: authorizeGapResolutionRequest only. No research, model call,
// notification, resolution, or promulgation is exercised by this feature,
// so none of that is tested here — this increment is infrastructure only.

const supabaseFetchMock = vi.fn();
const supabasePatchMock = vi.fn();

vi.mock("../src/shared/supabase.js", () => ({
  supabaseFetch: (...a) => supabaseFetchMock(...a),
  supabasePost:  vi.fn(),
  supabasePatch: (...a) => supabasePatchMock(...a),
  supabasePatchByField: vi.fn(),
  supabaseRpc:   vi.fn(),
  supabaseUpsert: vi.fn(),
  supabaseDelete: vi.fn(),
  supabaseHeaders: () => ({}),
}));

vi.mock("../src/shared/runtime.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual };
});

// fetch is used by getReviewerAuthority for /auth/v1/user
global.fetch = vi.fn();

const { authorizeGapResolutionRequest } = await import("../src/routes/outreach.js");

const CH = {};
const ENV = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
};

function mockRequest(body = {}) {
  return { method: "PATCH", json: () => Promise.resolve(body), headers: new Map() };
}

// Mocks the getReviewerAuthority(env, jwt) call chain: /auth/v1/user, then
// reviewers, then reviewer_roles.
function mockReviewerAuth({ id = "rev-uuid", role = "frontframe_admin", active = true, canAmend = false } = {}) {
  global.fetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({ email: "ed@frontframe.co" }),
  });
  supabaseFetchMock
    .mockResolvedValueOnce([{ id, role, active }])                       // reviewers
    .mockResolvedValueOnce([{ roles: { can_amend_constitution: canAmend } }]); // reviewer_roles
}

function mockInvalidJwt() {
  global.fetch.mockResolvedValueOnce({ ok: false });
}

describe("authorizeGapResolutionRequest (Phase F Candidate 2, Increment 1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects a missing/invalid JWT before any write", async () => {
    mockInvalidJwt();
    const res = await authorizeGapResolutionRequest(mockRequest(), ENV, "1", "bad-jwt", CH);
    expect(res.status).toBe(401);
    expect(supabasePatchMock).not.toHaveBeenCalled();
  });

  it("rejects a Staff (frontframe_staff) caller — Management authority required", async () => {
    mockReviewerAuth({ role: "frontframe_staff" });
    const res = await authorizeGapResolutionRequest(mockRequest(), ENV, "1", "staff-jwt", CH);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error).toMatch(/Management authority required/);
    expect(supabasePatchMock).not.toHaveBeenCalled();
  });

  it("rejects authorization of a nonexistent row", async () => {
    mockReviewerAuth();
    supabaseFetchMock.mockResolvedValueOnce([]); // gap_resolution_requests lookup
    const res = await authorizeGapResolutionRequest(mockRequest(), ENV, "999", "admin-jwt", CH);
    expect(res.status).toBe(404);
    expect(supabasePatchMock).not.toHaveBeenCalled();
  });

  it("rejects re-authorization of an already-authorized row (idempotency/one-way transition)", async () => {
    mockReviewerAuth();
    supabaseFetchMock.mockResolvedValueOnce([
      { id: "1", authorized_at: "2026-09-04T00:00:00.000Z" },
    ]);
    const res = await authorizeGapResolutionRequest(mockRequest({ permitted_scope: "x" }), ENV, "1", "admin-jwt", CH);
    expect(res.status).toBe(409);
    expect(supabasePatchMock).not.toHaveBeenCalled();
  });

  it("authorizes an open row for a Management caller: authorized_by is derived from the authenticated reviewer, never caller-supplied", async () => {
    mockReviewerAuth({ id: "delegate-uuid", role: "frontframe_admin" });
    supabaseFetchMock.mockResolvedValueOnce([{ id: "1", authorized_at: null }]);
    supabasePatchMock.mockResolvedValueOnce([{ id: "1", authorized_by: "delegate-uuid" }]);

    const res = await authorizeGapResolutionRequest(
      mockRequest({ permitted_scope: "Investigate SLA/uptime policy", authorized_by: "attacker-uuid" }),
      ENV, "1", "admin-jwt", CH,
    );

    expect(res.status).toBe(200);
    expect(supabasePatchMock).toHaveBeenCalledTimes(1);
    const [, table, id, payload] = supabasePatchMock.mock.calls[0];
    expect(table).toBe("gap_resolution_requests");
    expect(id).toBe("1");
    // Caller-supplied authorized_by must never reach the write — this is
    // the same defect class Candidate 1 found and fixed for submitted_by.
    expect(payload.authorized_by).toBe("delegate-uuid");
    expect(payload.permitted_scope).toBe("Investigate SLA/uptime policy");
    expect(typeof payload.authorized_at).toBe("string");
  });

  it("accepts a Management caller with no permitted_scope supplied (nullable field)", async () => {
    mockReviewerAuth();
    supabaseFetchMock.mockResolvedValueOnce([{ id: "2", authorized_at: null }]);
    supabasePatchMock.mockResolvedValueOnce([{ id: "2" }]);

    const res = await authorizeGapResolutionRequest(mockRequest({}), ENV, "2", "admin-jwt", CH);

    expect(res.status).toBe(200);
    const [, , , payload] = supabasePatchMock.mock.calls[0];
    expect(payload.permitted_scope).toBeNull();
  });

  it("triggers no research, model call, notification, resolution, or promulgation — only the two/three fields are written", async () => {
    mockReviewerAuth({ id: "op-uuid" });
    supabaseFetchMock.mockResolvedValueOnce([{ id: "3", authorized_at: null }]);
    supabasePatchMock.mockResolvedValueOnce([{ id: "3" }]);

    await authorizeGapResolutionRequest(mockRequest({ permitted_scope: "x" }), ENV, "3", "admin-jwt", CH);

    const [, table, , payload] = supabasePatchMock.mock.calls[0];
    expect(table).toBe("gap_resolution_requests");
    expect(Object.keys(payload).sort()).toEqual(["authorized_at", "authorized_by", "permitted_scope"]);
  });
});

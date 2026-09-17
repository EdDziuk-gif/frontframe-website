import { beforeEach, describe, expect, it, vi } from "vitest";

// Migration 014 (KGR corpus-write governance) removed authorizeGapResolutionRequest
// entirely — Start Case (start_kgr_case RPC) now stamps authorized_at/authorized_by
// atomically. What remains on the Unresolved Questions queue read/delete path:
//   * getGapResolutionRequests takes a `state` filter (actionable | resolved | all)
//   * deleteGapResolutionRequest is Management-only and 409s on a linked/
//     resolved/escalated request.

const supabaseFetchMock  = vi.fn();
const supabaseDeleteMock = vi.fn();

vi.mock("../src/shared/supabase.js", () => ({
  supabaseFetch:  (...a) => supabaseFetchMock(...a),
  supabasePost:   vi.fn(),
  supabasePatch:  vi.fn(),
  supabasePatchByField: vi.fn(),
  supabaseRpc:    vi.fn(),
  supabaseUpsert: vi.fn(),
  supabaseDelete: (...a) => supabaseDeleteMock(...a),
  supabaseHeaders: () => ({}),
}));

vi.mock("../src/shared/runtime.js", async (importOriginal) => ({ ...(await importOriginal()) }));

global.fetch = vi.fn();

const { getGapResolutionRequests, deleteGapResolutionRequest } = await import("../src/routes/outreach.js");

const CH = {};
const ENV = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-key" };

function mockReviewerAuth({ id = "rev-uuid", role = "frontframe_admin", active = true, can_amend_constitution = false } = {}) {
  global.fetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ email: "ed@frontframe.co" }) });
  supabaseFetchMock
    .mockResolvedValueOnce([{ id, role, active, can_amend_constitution }]);    // reviewers
}

beforeEach(() => { vi.clearAllMocks(); });

describe("getGapResolutionRequests state filter", () => {
  it("defaults to actionable — excludes resolved and escalated", async () => {
    supabaseFetchMock.mockResolvedValueOnce([]);
    const res = await getGapResolutionRequests({ url: "https://x/admin/gap-resolution-requests" }, ENV, "jwt", CH);
    expect(res.status).toBe(200);
    const q = supabaseFetchMock.mock.calls[0][2];
    expect(q).toContain("resolved_at=is.null");
    expect(q).toContain("escalated_at=is.null");
    expect(q).toContain("kgr_cases");   // embeds the linked case so the UI can show Open Case
  });

  it("state=resolved returns resolved history", async () => {
    supabaseFetchMock.mockResolvedValueOnce([]);
    await getGapResolutionRequests({ url: "https://x/admin/gap-resolution-requests?state=resolved" }, ENV, "jwt", CH);
    const q = supabaseFetchMock.mock.calls[0][2];
    expect(q).toContain("resolved_at=not.is.null");
    expect(q).toContain("order=resolved_at.desc");
  });

  it("state=all applies no state filter", async () => {
    supabaseFetchMock.mockResolvedValueOnce([]);
    await getGapResolutionRequests({ url: "https://x/admin/gap-resolution-requests?state=all" }, ENV, "jwt", CH);
    const q = supabaseFetchMock.mock.calls[0][2];
    expect(q).not.toContain("resolved_at=is.null");
    expect(q).not.toContain("resolved_at=not.is.null");
  });

  it("an unknown state value is a 400", async () => {
    const res = await getGapResolutionRequests({ url: "https://x/admin/gap-resolution-requests?state=garbage" }, ENV, "jwt", CH);
    expect(res.status).toBe(400);
    expect(supabaseFetchMock).not.toHaveBeenCalled();
  });

  it("a missing JWT is a 401 before any read", async () => {
    const res = await getGapResolutionRequests({ url: "https://x/admin/gap-resolution-requests" }, ENV, null, CH);
    expect(res.status).toBe(401);
  });
});

describe("deleteGapResolutionRequest", () => {
  it("rejects a Staff caller — Management authority required", async () => {
    mockReviewerAuth({ role: "frontframe_staff" });
    const res = await deleteGapResolutionRequest(ENV, "5", "jwt", CH);
    expect(res.status).toBe(403);
    expect(supabaseDeleteMock).not.toHaveBeenCalled();
  });

  it("404s a nonexistent row", async () => {
    mockReviewerAuth();
    supabaseFetchMock.mockResolvedValueOnce([]);   // row lookup
    const res = await deleteGapResolutionRequest(ENV, "999", "jwt", CH);
    expect(res.status).toBe(404);
  });

  it("409s a request that already has a case", async () => {
    mockReviewerAuth();
    supabaseFetchMock.mockResolvedValueOnce([{ id: 5, resolved_at: null, escalated_at: null, kgr_cases: [{ id: 9 }] }]);
    const res = await deleteGapResolutionRequest(ENV, "5", "jwt", CH);
    expect(res.status).toBe(409);
    expect(supabaseDeleteMock).not.toHaveBeenCalled();
  });

  it("409s a resolved request", async () => {
    mockReviewerAuth();
    supabaseFetchMock.mockResolvedValueOnce([{ id: 5, resolved_at: "2026-09-09T00:00:00Z", escalated_at: null, kgr_cases: [] }]);
    const res = await deleteGapResolutionRequest(ENV, "5", "jwt", CH);
    expect(res.status).toBe(409);
  });

  it("deletes an unlinked, unresolved, non-escalated request for a Management caller", async () => {
    mockReviewerAuth();
    supabaseFetchMock.mockResolvedValueOnce([{ id: 5, resolved_at: null, escalated_at: null, kgr_cases: [] }]);
    supabaseDeleteMock.mockResolvedValueOnce({});
    const res = await deleteGapResolutionRequest(ENV, "5", "jwt", CH);
    expect(res.status).toBe(200);
    expect(supabaseDeleteMock).toHaveBeenCalledWith(ENV, "gap_resolution_requests", "5", "jwt");
  });
});

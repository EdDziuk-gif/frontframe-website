import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";

// Phase F candidate 1 — constitutional amendment proposals and authorization incidents.
// Tests cover: proposal lifecycle, Operator-only authority enforcement,
// stale-text rejection, authorization-incident aggregation, SMS rate-limiting,
// and SMS content-safety (no raw attacker-supplied strings in the message body).

const supabaseFetchMock = vi.fn();
const supabasePostMock  = vi.fn();
const supabasePatchMock = vi.fn();
const supabaseRpcMock   = vi.fn();
const sendSmsMock       = vi.fn().mockResolvedValue({ success: true });

vi.mock("../src/shared/supabase.js", () => ({
  supabaseFetch: (...a) => supabaseFetchMock(...a),
  supabasePost:  (...a) => supabasePostMock(...a),
  supabasePatch: (...a) => supabasePatchMock(...a),
  supabaseRpc:   (...a) => supabaseRpcMock(...a),
  supabaseHeaders: () => ({}),
  supabaseDelete: vi.fn(),
  supabasePatchByField: vi.fn(),
  supabaseUpsert: vi.fn(),
}));

vi.mock("../src/shared/runtime.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, sendSms: (...a) => sendSmsMock(...a) };
});

// fetch is used by getReviewerAuthority for /auth/v1/user
global.fetch = vi.fn();

const {
  getReviewerAuthority,
  computeFingerprint,
  recordDeniedAction,
  createProposal,
  listProposals,
  getProposal,
  updateProposal,
  submitProposal,
  reopenProposal,
  returnProposal,
  rejectProposal,
  promulgateProposal,
  listAmendments,
  listProvisions,
  listAuthorizationIncidents,
  updateAuthorizationIncident,
} = await import("../src/routes/constitution.js");

// ── Helpers ────────────────────────────────────────────────────────────────

const CH = {};
const ENV = {
  SUPABASE_URL:             "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "service-key",
  RATE_LIMIT_KV: {
    get: vi.fn().mockResolvedValue(null),
    put: vi.fn().mockResolvedValue(undefined),
  },
};

function fakeCtx() {
  const pending = [];
  return {
    waitUntil: (p) => pending.push(p),
    flush: () => Promise.allSettled(pending),
  };
}

function mockRequest(body = {}, method = "POST") {
  return {
    method,
    json: () => Promise.resolve(body),
    headers: new Map(),
  };
}

// Sets up fetch to return a valid Supabase auth user + reviewer with given role flags.
function mockOperatorAuth(id = "op-uuid") {
  global.fetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({ email: "ed@frontframe.co" }),
  });
  supabaseFetchMock
    .mockResolvedValueOnce([{ id, role: "frontframe_admin", active: true }]) // reviewers
    .mockResolvedValueOnce([{ roles: { can_amend_constitution: true } }]);   // reviewer_roles
}

function mockStaffAuth(id = "staff-uuid") {
  global.fetch.mockResolvedValueOnce({
    ok: true,
    json: () => Promise.resolve({ email: "staff@frontframe.co" }),
  });
  supabaseFetchMock
    .mockResolvedValueOnce([{ id, role: "frontframe_staff", active: true }])
    .mockResolvedValueOnce([{ roles: { can_amend_constitution: false } }]);
}

const VALID_PROPOSAL = {
  constitutional_matter:              "Test matter",
  factual_context:                    "Test context",
  material_assumptions:               "Test assumptions",
  proposed_decision:                  "Test decision",
  affected_provision_number:          "1",
  expected_preceding_text:            "Original text",
  proposed_resulting_text:            "New text",
  interactions_with_other_provisions: "None",
  no_conflict_explanation:            "No conflicts",
  source_type:                        "Staff",
};

beforeEach(() => {
  vi.clearAllMocks();
  ENV.RATE_LIMIT_KV.get.mockResolvedValue(null);
  ENV.RATE_LIMIT_KV.put.mockResolvedValue(undefined);
  sendSmsMock.mockResolvedValue({ success: true });
});

// ── Proposal creation ──────────────────────────────────────────────────────

describe("createProposal", () => {
  it("accepts a valid proposal from each permitted source_type", async () => {
    const sourceTypes = ["Staff", "Operator", "Delegate", "assistant", "outside_resource"];
    // Queue auth mocks for all 5 calls (getReviewerAuthority runs first in each)
    for (const _ of sourceTypes) {
      mockStaffAuth();
      supabasePostMock.mockResolvedValueOnce([{ id: 1, status: "draft" }]);
    }
    for (const source_type of sourceTypes) {
      const req = mockRequest({ ...VALID_PROPOSAL, source_type });
      const res = await createProposal(req, ENV, "jwt", CH);
      expect(res.status).toBe(201);
    }
    expect(supabasePostMock).toHaveBeenCalledTimes(5);
  });

  it("sets status to draft regardless of what caller supplies", async () => {
    mockStaffAuth();
    supabasePostMock.mockResolvedValueOnce([{ id: 1, status: "draft" }]);
    const req = mockRequest({ ...VALID_PROPOSAL, status: "promulgated" });
    await createProposal(req, ENV, "jwt", CH);
    expect(supabasePostMock.mock.calls[0][2]).toMatchObject({ status: "draft" });
  });

  it("sets submitted_by from the authenticated reviewer, ignoring any value in the body", async () => {
    mockStaffAuth("resolver-uuid");
    supabasePostMock.mockResolvedValueOnce([{ id: 1, status: "draft", submitted_by: "resolver-uuid" }]);
    const req = mockRequest({ ...VALID_PROPOSAL, submitted_by: "attacker-uuid" });
    const res = await createProposal(req, ENV, "jwt", CH);
    expect(res.status).toBe(201);
    expect(supabasePostMock.mock.calls[0][2].submitted_by).toBe("resolver-uuid");
    expect(supabasePostMock.mock.calls[0][2].submitted_by).not.toBe("attacker-uuid");
  });

  it("sets submitted_by to null when the caller has no reviewers row (assistant path)", async () => {
    // getReviewerAuthority returns null when /auth/v1/user fails
    global.fetch.mockResolvedValueOnce({ ok: false });
    supabasePostMock.mockResolvedValueOnce([{ id: 1, status: "draft", submitted_by: null }]);
    const req = mockRequest({ ...VALID_PROPOSAL, submitted_by: "attacker-uuid" });
    const res = await createProposal(req, ENV, "jwt", CH);
    expect(res.status).toBe(201);
    expect(supabasePostMock.mock.calls[0][2].submitted_by).toBeNull();
  });

  it("rejects an invalid source_type", async () => {
    mockStaffAuth();
    const req = mockRequest({ ...VALID_PROPOSAL, source_type: "hacker" });
    const res = await createProposal(req, ENV, "jwt", CH);
    expect(res.status).toBe(400);
    expect(supabasePostMock).not.toHaveBeenCalled();
  });

  it("rejects a request missing required fields", async () => {
    mockStaffAuth();
    const { constitutional_matter: _, ...incomplete } = VALID_PROPOSAL;
    const req = mockRequest(incomplete);
    const res = await createProposal(req, ENV, "jwt", CH);
    expect(res.status).toBe(400);
    expect(supabasePostMock).not.toHaveBeenCalled();
  });

  it("rejects a new-provision proposal without proposed_provision_title", async () => {
    mockStaffAuth();
    const req = mockRequest({
      ...VALID_PROPOSAL,
      affected_provision_number:  null,
      expected_preceding_text:    null,
    });
    const res = await createProposal(req, ENV, "jwt", CH);
    expect(res.status).toBe(400);
    expect(supabasePostMock).not.toHaveBeenCalled();
  });

  it("accepts a new-provision proposal when proposed_provision_title is supplied", async () => {
    mockStaffAuth();
    supabasePostMock.mockResolvedValueOnce([{ id: 2, status: "draft" }]);
    const req = mockRequest({
      ...VALID_PROPOSAL,
      affected_provision_number: null,
      expected_preceding_text:   null,
      proposed_provision_title:  "New Provision Title",
    });
    const res = await createProposal(req, ENV, "jwt", CH);
    expect(res.status).toBe(201);
    expect(supabasePostMock.mock.calls[0][2]).toMatchObject({
      affected_provision_number: null,
      expected_preceding_text:   null,
      proposed_provision_title:  "New Provision Title",
    });
  });
});

// ── Proposal lifecycle ─────────────────────────────────────────────────────

describe("submitProposal", () => {
  it("transitions draft → pending_review when all required fields are present", async () => {
    supabaseFetchMock.mockResolvedValueOnce([{ id: 1, status: "draft", ...VALID_PROPOSAL }]);
    supabasePatchMock.mockResolvedValueOnce([{ id: 1, status: "pending_review" }]);
    const res = await submitProposal(mockRequest({}), ENV, "1", "jwt", CH);
    expect(res.status).toBe(200);
    expect(supabasePatchMock.mock.calls[0][3]).toMatchObject({ status: "pending_review" });
  });

  it("rejects submission of a non-draft proposal", async () => {
    supabaseFetchMock.mockResolvedValueOnce([{ id: 1, status: "pending_review", ...VALID_PROPOSAL }]);
    const res = await submitProposal(mockRequest({}), ENV, "1", "jwt", CH);
    expect(res.status).toBe(409);
    expect(supabasePatchMock).not.toHaveBeenCalled();
  });

  it("rejects submission when a required field is blank", async () => {
    supabaseFetchMock.mockResolvedValueOnce([{
      id: 1, status: "draft",
      ...VALID_PROPOSAL, constitutional_matter: "",
    }]);
    const res = await submitProposal(mockRequest({}), ENV, "1", "jwt", CH);
    expect(res.status).toBe(422);
  });
});

describe("returnProposal", () => {
  it("Operator can return a pending_review proposal to returned status", async () => {
    mockOperatorAuth();
    supabaseFetchMock.mockResolvedValueOnce([{ id: 1, status: "pending_review" }]);
    supabasePatchMock.mockResolvedValueOnce([{ id: 1, status: "returned" }]);
    const res = await returnProposal(mockRequest({ review_notes: "Needs more detail" }), ENV, fakeCtx(), "1", "jwt", CH);
    expect(res.status).toBe(200);
    expect(supabasePatchMock.mock.calls[0][3]).toMatchObject({ status: "returned", review_notes: "Needs more detail" });
  });

  it("non-Operator gets 403 and proposal is not modified", async () => {
    mockStaffAuth();
    supabaseRpcMock.mockResolvedValueOnce({ id: 99, occurrence_count: 1 });
    const ctx = fakeCtx();
    const res = await returnProposal(mockRequest({}), ENV, ctx, "1", "jwt", CH);
    await ctx.flush();
    expect(res.status).toBe(403);
    expect(supabasePatchMock).not.toHaveBeenCalled();
    expect(supabaseRpcMock).toHaveBeenCalledWith(ENV, "record_authorization_incident", expect.objectContaining({
      p_attempted_action: "return_proposal",
      p_target_object:    "constitution_amendment_proposals:1",
    }));
  });
});

describe("rejectProposal", () => {
  it("Operator can reject a pending_review proposal", async () => {
    mockOperatorAuth();
    supabaseFetchMock.mockResolvedValueOnce([{ id: 1, status: "pending_review" }]);
    supabasePatchMock.mockResolvedValueOnce([{ id: 1, status: "rejected" }]);
    const res = await rejectProposal(mockRequest({ review_notes: "Out of scope" }), ENV, fakeCtx(), "1", "jwt", CH);
    expect(res.status).toBe(200);
    expect(supabasePatchMock.mock.calls[0][3]).toMatchObject({ status: "rejected" });
  });

  it("non-Operator gets 403 without modifying the proposal", async () => {
    mockStaffAuth();
    supabaseRpcMock.mockResolvedValueOnce({ id: 100, occurrence_count: 1 });
    const ctx = fakeCtx();
    const res = await rejectProposal(mockRequest({}), ENV, ctx, "1", "jwt", CH);
    await ctx.flush();
    expect(res.status).toBe(403);
    expect(supabasePatchMock).not.toHaveBeenCalled();
  });
});

describe("reopenProposal", () => {
  it("transitions returned → draft", async () => {
    supabaseFetchMock.mockResolvedValueOnce([{ id: 1, status: "returned" }]);
    supabasePatchMock.mockResolvedValueOnce([{ id: 1, status: "draft" }]);
    const res = await reopenProposal(mockRequest({}), ENV, "1", "jwt", CH);
    expect(res.status).toBe(200);
    expect(supabasePatchMock.mock.calls[0][3]).toMatchObject({ status: "draft" });
  });

  it("rejects reopen of a non-returned proposal", async () => {
    supabaseFetchMock.mockResolvedValueOnce([{ id: 1, status: "draft" }]);
    const res = await reopenProposal(mockRequest({}), ENV, "1", "jwt", CH);
    expect(res.status).toBe(409);
    expect(supabasePatchMock).not.toHaveBeenCalled();
  });
});

describe("promulgateProposal", () => {
  it("Operator successfully promulgates via atomic RPC", async () => {
    mockOperatorAuth("op-uuid");
    supabaseRpcMock.mockResolvedValueOnce({
      amendment_id: 42, proposal_id: 1, provision_number: "1",
    });
    const ctx = fakeCtx();
    const res = await promulgateProposal(mockRequest({}), ENV, ctx, "1", "jwt", CH);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.amendment_id).toBe(42);
    expect(supabaseRpcMock).toHaveBeenCalledWith(ENV, "promulgate_constitutional_amendment", {
      p_proposal_id: 1,
      p_operator_id: "op-uuid",
    });
  });

  it("non-Operator gets 403 — RPC is never called, proposal is not modified", async () => {
    mockStaffAuth();
    supabaseRpcMock
      .mockResolvedValueOnce({ id: 101, occurrence_count: 1 }); // only the incident RPC
    const ctx = fakeCtx();
    const res = await promulgateProposal(mockRequest({}), ENV, ctx, "1", "jwt", CH);
    await ctx.flush();
    expect(res.status).toBe(403);
    // promulgate RPC not called; only record_authorization_incident RPC was called
    expect(supabaseRpcMock).toHaveBeenCalledTimes(1);
    expect(supabaseRpcMock.mock.calls[0][1]).toBe("record_authorization_incident");
  });

  it("returns 409 with a stale-text message when the RPC raises stale_text", async () => {
    mockOperatorAuth();
    supabaseRpcMock.mockRejectedValueOnce(
      new Error("Supabase RPC promulgate_constitutional_amendment failed: stale_text: provision 1 has changed"),
    );
    const res = await promulgateProposal(mockRequest({}), ENV, fakeCtx(), "1", "jwt", CH);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error).toMatch(/stale text/i);
  });

  it("returns 409 with a descriptive message for proposal_not_pending", async () => {
    mockOperatorAuth();
    supabaseRpcMock.mockRejectedValueOnce(
      new Error("Supabase RPC failed: proposal_not_pending: draft"),
    );
    const res = await promulgateProposal(mockRequest({}), ENV, fakeCtx(), "1", "jwt", CH);
    expect(res.status).toBe(409);
  });

  it("new-provision path: RPC called with correct proposal id and no preceding text", async () => {
    mockOperatorAuth("op-uuid");
    supabaseRpcMock.mockResolvedValueOnce({
      amendment_id: 55, proposal_id: 7, provision_number: "11",
    });
    const res = await promulgateProposal(mockRequest({}), ENV, fakeCtx(), "7", "jwt", CH);
    expect(res.status).toBe(200);
    expect(supabaseRpcMock.mock.calls[0][2]).toMatchObject({ p_proposal_id: 7 });
  });
});

// ── Authorization incident aggregation ────────────────────────────────────

describe("recordDeniedAction — fingerprint aggregation", () => {
  it("first occurrence: calls RPC with insert path and sends SMS", async () => {
    supabaseRpcMock.mockResolvedValueOnce({ id: 1, occurrence_count: 1 });
    ENV.RATE_LIMIT_KV.get.mockResolvedValueOnce(null);

    const ctx = fakeCtx();
    await recordDeniedAction(ENV, ctx, {
      actingReviewerId:   "staff-uuid",
      actingIdentityText: null,
      attemptedAction:    "promulgate_amendment",
      targetObject:       "constitution_amendment_proposals:5",
      denialReason:       "Insufficient authority",
    });
    await ctx.flush();

    expect(supabaseRpcMock).toHaveBeenCalledWith(ENV, "record_authorization_incident", expect.objectContaining({
      p_attempted_action: "promulgate_amendment",
      p_target_object:    "constitution_amendment_proposals:5",
    }));
    expect(sendSmsMock).toHaveBeenCalledTimes(1);
    expect(ENV.RATE_LIMIT_KV.put).toHaveBeenCalledTimes(1);
  });

  it("second occurrence with same fingerprint: RPC increments, SMS suppressed by rate limit", async () => {
    supabaseRpcMock.mockResolvedValueOnce({ id: 1, occurrence_count: 2 });
    ENV.RATE_LIMIT_KV.get.mockResolvedValueOnce("1"); // SMS already sent

    const ctx = fakeCtx();
    await recordDeniedAction(ENV, ctx, {
      actingReviewerId:   "staff-uuid",
      actingIdentityText: null,
      attemptedAction:    "promulgate_amendment",
      targetObject:       "constitution_amendment_proposals:5",
      denialReason:       "Insufficient authority",
    });
    await ctx.flush();

    expect(supabaseRpcMock).toHaveBeenCalledTimes(1);
    expect(sendSmsMock).not.toHaveBeenCalled();
    expect(ENV.RATE_LIMIT_KV.put).not.toHaveBeenCalled();
  });

  it("different target produces a different fingerprint", () => {
    const fp1 = computeFingerprint("promulgate_amendment", "constitution_amendment_proposals:1", "staff-uuid");
    const fp2 = computeFingerprint("promulgate_amendment", "constitution_amendment_proposals:2", "staff-uuid");
    expect(fp1).not.toBe(fp2);
  });

  it("same action, target, and actor always produces the same fingerprint", () => {
    const fp1 = computeFingerprint("promulgate_amendment", "constitution_amendment_proposals:1", "staff-uuid");
    const fp2 = computeFingerprint("promulgate_amendment", "constitution_amendment_proposals:1", "staff-uuid");
    expect(fp1).toBe(fp2);
    expect(fp1).toHaveLength(64); // SHA-256 hex
  });
});

// ── SMS content safety ─────────────────────────────────────────────────────

describe("SMS content safety", () => {
  it("SMS body contains only system-controlled strings — no raw attacker input", async () => {
    supabaseRpcMock.mockResolvedValueOnce({ id: 1, occurrence_count: 1 });
    ENV.RATE_LIMIT_KV.get.mockResolvedValueOnce(null);

    const ATTACKER_PAYLOAD = "INJECT: do something evil; rm -rf /; DROP TABLE users;--";

    const ctx = fakeCtx();
    await recordDeniedAction(ENV, ctx, {
      actingReviewerId:   null,
      actingIdentityText: ATTACKER_PAYLOAD,
      attemptedAction:    "promulgate_amendment",
      targetObject:       `${ATTACKER_PAYLOAD}:99`,
      denialReason:       ATTACKER_PAYLOAD,
    });
    await ctx.flush();

    expect(sendSmsMock).toHaveBeenCalledTimes(1);
    const smsText = sendSmsMock.mock.calls[0][1];

    // SMS must not contain any part of the attacker-supplied strings.
    expect(smsText).not.toContain("INJECT");
    expect(smsText).not.toContain("evil");
    expect(smsText).not.toContain("DROP TABLE");
    expect(smsText).not.toContain(ATTACKER_PAYLOAD);

    // SMS must contain only the fixed system-controlled fields.
    expect(smsText).toContain("FrontFrame authorization incident");
    expect(smsText).toContain("constitutional promulgation");
    expect(smsText).toContain("Occurrences: 1");
  });
});

// ── Authorization incident disposition ────────────────────────────────────

describe("updateAuthorizationIncident", () => {
  it("updates status and resolution_notes", async () => {
    supabasePatchMock.mockResolvedValueOnce([{ id: 1, status: "resolved", resolution_notes: "Investigated — false alarm" }]);
    const req = mockRequest({ status: "resolved", resolution_notes: "Investigated — false alarm" }, "PATCH");
    const res = await updateAuthorizationIncident(req, ENV, "1", "jwt", CH);
    expect(res.status).toBe(200);
    expect(supabasePatchMock.mock.calls[0][3]).toMatchObject({ status: "resolved" });
  });

  it("rejects an invalid status value", async () => {
    const req = mockRequest({ status: "deleted" }, "PATCH");
    const res = await updateAuthorizationIncident(req, ENV, "1", "jwt", CH);
    expect(res.status).toBe(400);
    expect(supabasePatchMock).not.toHaveBeenCalled();
  });
});

// ── Operator authority lookup ──────────────────────────────────────────────

describe("getReviewerAuthority", () => {
  it("returns canAmendConstitution: true for a reviewer with the Operator role grant", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ email: "ed@frontframe.co" }),
    });
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: "op-uuid", role: "frontframe_admin", active: true }])
      .mockResolvedValueOnce([{ roles: { can_amend_constitution: true } }]);

    const result = await getReviewerAuthority(ENV, "jwt");
    expect(result.canAmendConstitution).toBe(true);
    expect(result.id).toBe("op-uuid");
  });

  it("returns canAmendConstitution: false for a Staff reviewer", async () => {
    global.fetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ email: "staff@frontframe.co" }),
    });
    supabaseFetchMock
      .mockResolvedValueOnce([{ id: "staff-uuid", role: "frontframe_staff", active: true }])
      .mockResolvedValueOnce([{ roles: { can_amend_constitution: false } }]);

    const result = await getReviewerAuthority(ENV, "jwt");
    expect(result.canAmendConstitution).toBe(false);
  });

  it("returns null when JWT auth fails", async () => {
    global.fetch.mockResolvedValueOnce({ ok: false });
    const result = await getReviewerAuthority(ENV, "bad-jwt");
    expect(result).toBeNull();
  });

  it("returns null when no JWT supplied", async () => {
    const result = await getReviewerAuthority(ENV, null);
    expect(result).toBeNull();
  });
});

// ── Route protection (structural — no JWT bypasses admin routes) ───────────

describe("route protection", () => {
  it("all constitution and authorization-incident routes are under /admin/ or protected prefix", async () => {
    const { ROUTES } = await import("../src/index.js");
    const constitutionRoutes = ROUTES.filter(
      (r) => r.path.includes("/constitution/") || r.path.includes("/authorization-incidents"),
    );
    expect(constitutionRoutes.length).toBeGreaterThan(0);
    for (const r of constitutionRoutes) {
      expect(r.path.startsWith("/admin/")).toBe(true);
    }
  });
});

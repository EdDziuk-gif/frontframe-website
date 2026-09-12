import { beforeEach, describe, expect, it, vi } from "vitest";

// /chat has no path-level protection (isProtectedRoute("/chat") === false,
// see router.contract.test.js) — it's the public visitor-chat endpoint, and it
// trusts whatever `page` value the POST body claims. The "admin" page's
// system_prompt is written for signed-in staff, so handleChat must reject an
// unauthenticated page:"admin" request before it ever looks up that content,
// while leaving every other page value exactly as unauthenticated as before.

const supabaseFetchMock = vi.fn();

vi.mock("../src/shared/supabase.js", () => ({
  supabaseFetch:  (...a) => supabaseFetchMock(...a),
  supabasePost:   vi.fn(),
  supabasePatch:  vi.fn(),
  supabasePatchByField: vi.fn(),
  supabaseRpc:    vi.fn(),
  supabaseUpsert: vi.fn(),
  supabaseDelete: vi.fn(),
  supabaseHeaders: () => ({}),
}));

vi.mock("../src/shared/runtime.js", async (importOriginal) => ({ ...(await importOriginal()) }));

global.fetch = vi.fn();

const { handleChat } = await import("../src/routes/chat.js");

const ENV = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-key" };
const CH = {};
const CTX = { waitUntil: () => {} };

function makeRequest(bodyObj, { jwt = null } = {}) {
  const headers = new Map();
  if (jwt) headers.set("Authorization", `Bearer ${jwt}`);
  return {
    json: () => Promise.resolve(bodyObj),
    headers: { get: (k) => headers.get(k) ?? null },
  };
}

function mockValidReviewer({ role = "frontframe_staff" } = {}) {
  global.fetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ email: "staff@frontframe.co" }) });
  supabaseFetchMock
    .mockResolvedValueOnce([{ id: "rev-1", role, active: true }])                // reviewers
    .mockResolvedValueOnce([{ roles: { can_amend_constitution: false } }]);      // reviewer_roles
}

beforeEach(() => { vi.clearAllMocks(); });

describe("admin page auth gate on /chat", () => {
  it("rejects page:admin with no Authorization header, before any lookup", async () => {
    const res = await handleChat(makeRequest({ page: "admin", message: "hi" }), ENV, CTX, CH);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(global.fetch).not.toHaveBeenCalled();
    expect(supabaseFetchMock).not.toHaveBeenCalled();
  });

  it("rejects page:admin when the JWT doesn't resolve to an active reviewer", async () => {
    global.fetch.mockResolvedValueOnce({ ok: false });
    const res = await handleChat(makeRequest({ page: "admin", message: "hi" }, { jwt: "bad-jwt" }), ENV, CTX, CH);
    expect(res.status).toBe(401);
  });

  it("passes page:admin through to the normal pipeline for an active reviewer", async () => {
    mockValidReviewer();
    supabaseFetchMock.mockResolvedValueOnce([{ mode: "disabled" }]); // config kill-switch, cheapest way past the gate
    const res = await handleChat(makeRequest({ page: "admin", message: "hi" }, { jwt: "good-jwt" }), ENV, CTX, CH);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.mode).toBe("disabled");
  });

  it("leaves every other page value unauthenticated, exactly as before", async () => {
    supabaseFetchMock.mockResolvedValueOnce([{ mode: "disabled" }]); // config kill-switch
    const res = await handleChat(makeRequest({ page: "home", message: "hi" }), ENV, CTX, CH);
    expect(res.status).toBe(200);
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

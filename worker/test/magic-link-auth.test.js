import { beforeEach, describe, expect, it, vi } from "vitest";

// Admin login (public/js/auth.js) moved from OTP-via-Supabase-SDK to this
// magic-link route: OTP hit Supabase's own built-in email rate limit hard
// under repeated testing, with nothing in our control to raise it. This
// route uses the Supabase Admin API + Resend instead, bypassing that limit.
//
// Regression guard: an earlier version of this route checked the caller's
// email against a single hardcoded ADMIN_EMAIL constant, and always
// generated/sent the link to that same constant regardless of who asked -
// which would have locked out every reviewer but Ed, the moment OTP login
// was retired. Authorization must check the reviewers table (any active
// reviewer), and the link must go to the actual requesting email.

const supabaseFetchMock = vi.fn();
const sendResendEmailMock = vi.fn().mockResolvedValue({ success: true, status: "sent" });
global.fetch = vi.fn();

vi.mock("../src/shared/runtime.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, sendResendEmail: (...a) => sendResendEmailMock(...a) };
});

vi.mock("../src/shared/supabase.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, supabaseFetch: (...a) => supabaseFetchMock(...a) };
});

const { handleMagicLink } = await import("../src/routes/auth.js");

const ENV = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-key" };
const CORS = {};
const req = (body) => ({ json: () => Promise.resolve(body) });

beforeEach(() => {
  supabaseFetchMock.mockReset();
  sendResendEmailMock.mockClear();
  global.fetch.mockReset();
});

describe("handleMagicLink — reviewers-table authorization", () => {
  it("401/400s when email is missing", async () => {
    const res = await handleMagicLink(req({}), ENV, CORS);
    expect(res.status).toBe(400);
    expect(supabaseFetchMock).not.toHaveBeenCalled();
  });

  it("rejects an email with no active reviewer row", async () => {
    supabaseFetchMock.mockResolvedValueOnce([]);
    const res = await handleMagicLink(req({ email: "stranger@example.com" }), ENV, CORS);
    expect(res.status).toBe(403);
    expect(global.fetch).not.toHaveBeenCalled();
    expect(sendResendEmailMock).not.toHaveBeenCalled();
  });

  it("rejects a reviewer row that exists but is inactive", async () => {
    supabaseFetchMock.mockResolvedValueOnce([{ email: "former@frontframe.co", active: false }]);
    const res = await handleMagicLink(req({ email: "former@frontframe.co" }), ENV, CORS);
    expect(res.status).toBe(403);
  });

  it("sends the link to a non-admin active reviewer, not to a hardcoded admin email", async () => {
    supabaseFetchMock.mockResolvedValueOnce([{ email: "staff@frontframe.co", active: true }]);
    global.fetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ action_link: "https://example.supabase.co/magic?token=abc" }) });

    const res = await handleMagicLink(req({ email: "staff@frontframe.co" }), ENV, CORS);
    expect(res.status).toBe(200);

    // The generate_link call must ask for the requesting reviewer's own email.
    const genLinkBody = JSON.parse(global.fetch.mock.calls[0][1].body);
    expect(genLinkBody.email).toBe("staff@frontframe.co");

    // The email must go to that same reviewer, never a different constant.
    expect(sendResendEmailMock).toHaveBeenCalledTimes(1);
    expect(sendResendEmailMock.mock.calls[0][1]).toBe("staff@frontframe.co");
  });

  it("still works for Ed, now via the reviewers table rather than a hardcoded constant", async () => {
    supabaseFetchMock.mockResolvedValueOnce([{ email: "ed@frontframe.co", active: true }]);
    global.fetch.mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ action_link: "https://example.supabase.co/magic?token=xyz" }) });

    const res = await handleMagicLink(req({ email: "ed@frontframe.co" }), ENV, CORS);
    expect(res.status).toBe(200);
    expect(sendResendEmailMock.mock.calls[0][1]).toBe("ed@frontframe.co");
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

// Root cause this closes: SMS is the only handoff notification, sent via
// Surge. When SURGE_API_KEY is invalid (as it was in production — a 401
// from Surge, discovered via wrangler tail), every handoff notification was
// silently dropped with nothing else to catch it — the leads/lead_alerts
// rows still got written, but Ed never heard about it. The Resend email is
// an independent backup: it fires on its own promise, not chained after the
// lead_alerts write or the SMS, so it still goes out even if either of those
// fails.

const sendResendEmailMock = vi.fn().mockResolvedValue({ success: true, status: "sent" });
const sendSmsMock = vi.fn().mockResolvedValue({ success: false, status: "invalid_api_key" });
const supabasePostMock = vi.fn();
const supabaseFetchMock = vi.fn().mockResolvedValue([]);

vi.mock("../src/shared/runtime.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, sendResendEmail: (...a) => sendResendEmailMock(...a), sendSms: (...a) => sendSmsMock(...a) };
});

vi.mock("../src/shared/supabase.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    supabasePost: (...a) => supabasePostMock(...a),
    supabaseFetch: (...a) => supabaseFetchMock(...a),
    supabasePatchByField: vi.fn().mockResolvedValue([]),
  };
});

const { captureContactHandoff } = await import("../src/routes/intake.js");

const ENV = {};
const fakeCtx = () => ({ waitUntil: (p) => { if (p && typeof p.catch === "function") p.catch(() => {}); } });

beforeEach(() => {
  sendResendEmailMock.mockClear();
  sendSmsMock.mockClear();
  supabasePostMock.mockReset();
  supabaseFetchMock.mockClear();
  supabaseFetchMock.mockResolvedValue([]); // no prior alert -> not deduped
});

describe("captureContactHandoff — Resend backup email", () => {
  it("sends a backup email to the admin with name, contact, and transcript", async () => {
    supabasePostMock.mockResolvedValue([{ id: 1, alert_id: 1 }]);
    await captureContactHandoff(ENV, fakeCtx(), {
      session_id: "s1", name: "Sam Visitor", contact: "sam@example.com", method: "email",
      summary: "Wants a callback about pricing", transcript: "Visitor: Hi\nAssistant: Hello",
    });
    expect(sendResendEmailMock).toHaveBeenCalledTimes(1);
    const [, to, subject, html] = sendResendEmailMock.mock.calls[0];
    expect(to).toBe("ed@frontframe.co");
    expect(subject).toContain("Sam Visitor");
    expect(html).toContain("sam@example.com");
    expect(html).toContain("Wants a callback about pricing");
    expect(html).toContain("Visitor: Hi");
  });

  it("still sends the email when the SMS fails (the actual production gap)", async () => {
    supabasePostMock.mockResolvedValue([{ id: 1, alert_id: 1 }]);
    await captureContactHandoff(ENV, fakeCtx(), { session_id: "s2", name: "Jo", contact: "555-0100", method: "phone" });
    expect(sendSmsMock).toHaveBeenCalled();
    expect(sendResendEmailMock).toHaveBeenCalledTimes(1);
  });

  it("still sends the email when the lead_alerts write fails", async () => {
    supabasePostMock.mockImplementation((env, table) =>
      table === "lead_alerts" ? Promise.reject(new Error("db down")) : Promise.resolve([{ id: 1 }]));
    await captureContactHandoff(ENV, fakeCtx(), { session_id: "s3", name: "Robin", contact: "robin@example.com", method: "email" });
    expect(sendResendEmailMock).toHaveBeenCalledTimes(1);
  });

  it("escapes HTML in visitor-supplied fields (name, summary, transcript)", async () => {
    supabasePostMock.mockResolvedValue([{ id: 1, alert_id: 1 }]);
    await captureContactHandoff(ENV, fakeCtx(), {
      session_id: "s4", name: "<script>alert(1)</script>", contact: "x@example.com", method: "email",
      summary: "<b>bold</b>", transcript: "Visitor: <img src=x>",
    });
    const html = sendResendEmailMock.mock.calls[0][3];
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("does not send an email when deduped (a prior alert already exists for this session)", async () => {
    supabaseFetchMock.mockResolvedValue([{ alert_id: 99 }]);
    await captureContactHandoff(ENV, fakeCtx(), { session_id: "s5", name: "Dup", contact: "dup@example.com", method: "email" });
    expect(sendResendEmailMock).not.toHaveBeenCalled();
    expect(supabasePostMock).not.toHaveBeenCalled();
  });
});

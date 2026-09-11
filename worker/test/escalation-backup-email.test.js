import { beforeEach, describe, expect, it, vi } from "vitest";

// Escalation (the model's own "_escalate" marker for a hot/urgent signal,
// distinct from the ordinary [COLLECTED] handoff) had its own SMS-only alert
// path in chat.js, never routed through captureContactHandoff — so it had
// the same single-point-of-failure gap the handoff path had before its
// Resend backup was added: an invalid/missing SURGE_API_KEY silently dropped
// every escalation alert with nothing else to catch it.

const callAnthropicMock = vi.fn();
const sendResendEmailMock = vi.fn().mockResolvedValue({ success: true, status: "sent" });
const sendSmsMock = vi.fn().mockResolvedValue({ success: false, status: "invalid_api_key" });
const supabasePostMock = vi.fn().mockResolvedValue([{ id: 1, alert_id: 1 }]);
const supabaseFetchMock = vi.fn().mockResolvedValue([]);

vi.mock("../src/shared/runtime.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    callAnthropic: (...a) => callAnthropicMock(...a),
    sendResendEmail: (...a) => sendResendEmailMock(...a),
    sendSms: (...a) => sendSmsMock(...a),
  };
});

vi.mock("../src/shared/supabase.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    supabaseFetch: (...a) => supabaseFetchMock(...a),
    supabasePost: (...a) => supabasePostMock(...a),
    supabasePatchByField: vi.fn().mockResolvedValue([]),
  };
});

const { handleSingleTurn } = await import("../src/routes/chat.js");

const CONFIG = { build_version: "test", stage_gate: "build" };
const fakeCtx = () => ({ waitUntil: (p) => { if (p && typeof p.catch === "function") p.catch(() => {}); } });

beforeEach(() => {
  callAnthropicMock.mockReset();
  sendResendEmailMock.mockClear();
  sendSmsMock.mockClear();
  supabasePostMock.mockClear();
  supabaseFetchMock.mockClear();
});

describe("escalation — Resend backup email", () => {
  it("sends a backup email when the model emits an _escalate marker, even though the SMS fails", async () => {
    callAnthropicMock.mockResolvedValueOnce(
      "I'd love to get you set up right away.\n" +
      '{"_escalate": true, "reason": "Visitor said they want to sign up today", "prospect": "Jordan"}'
    );

    const result = await handleSingleTurn(
      {}, fakeCtx(), CONFIG, "", "combined-prompt", "I want to sign up today, can someone call me?",
      [], "home", "session-esc-1", "visitor_chat",
    );

    expect(sendSmsMock).toHaveBeenCalled();
    expect(sendResendEmailMock).toHaveBeenCalledTimes(1);
    const [, to, subject, html] = sendResendEmailMock.mock.calls[0];
    expect(to).toBe("ed@frontframe.co");
    expect(subject).toContain("Jordan");
    expect(html).toContain("Jordan");
    expect(html).toContain("Visitor said they want to sign up today");
    expect(result.isWithheld).toBe(false);
  });

  it("still sends the email when the lead_alerts write fails", async () => {
    supabasePostMock.mockRejectedValueOnce(new Error("db down"));
    callAnthropicMock.mockResolvedValueOnce(
      'Sure thing.\n{"_escalate": true, "reason": "urgent", "prospect": "Robin"}'
    );

    await handleSingleTurn(
      {}, fakeCtx(), CONFIG, "", "combined-prompt", "Call me now please",
      [], "home", "session-esc-2", "visitor_chat",
    );

    expect(sendResendEmailMock).toHaveBeenCalledTimes(1);
  });

  it("escapes HTML in model-supplied escalation fields", async () => {
    callAnthropicMock.mockResolvedValueOnce(
      'Ok.\n{"_escalate": true, "reason": "<script>alert(1)</script>", "prospect": "<b>Sam</b>"}'
    );

    await handleSingleTurn(
      {}, fakeCtx(), CONFIG, "", "combined-prompt", "Call me",
      [], "home", "session-esc-3", "visitor_chat",
    );

    const html = sendResendEmailMock.mock.calls[0][3];
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

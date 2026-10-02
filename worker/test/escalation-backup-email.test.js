import { beforeEach, describe, expect, it, vi } from "vitest";

// The model's "_escalate" marker used to email and text the Operator on its own
// authority, before the visitor had agreed to anything. As of 2026-10-01
// (Decisions 1 and 21) it only signals that the visitor wants a person; the
// server asks, shows the visitor exactly what will be sent, and sends it only
// after a yes (see handoff-flow.test.js).

const callAnthropicMock = vi.fn();
const sendResendEmailMock = vi.fn().mockResolvedValue({ success: true, status: "sent" });
const sendSmsMock = vi.fn().mockResolvedValue({ success: false, status: "invalid_api_key" });
const supabasePostMock = vi.fn().mockResolvedValue([{ id: 1, alert_id: 1 }]);
// The active Operator row. Fictional values on purpose: the code must follow this
// row, not any address written in the source.
const OPERATOR_ROW = { display_name: "Pat", email: "pat@operator.example" };
const OPERATOR = { resolved: true, email: OPERATOR_ROW.email, displayName: OPERATOR_ROW.display_name, notifyEmail: OPERATOR_ROW.email };
const fetchImpl = (_env, table) => Promise.resolve(table === "reviewers" ? [OPERATOR_ROW] : []);
const supabaseFetchMock = vi.fn().mockImplementation(fetchImpl);

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

describe("escalation marker — nothing leaves the site before the visitor agrees", () => {
  it("an _escalate marker sends no email or text and writes no alert or lead", async () => {
    callAnthropicMock.mockResolvedValueOnce(
      "I'd love to get you set up right away.\n" +
      '{"_escalate": true, "reason": "Visitor said they want to sign up today", "prospect": "Jordan"}'
    );

    const result = await handleSingleTurn(
      {}, fakeCtx(), CONFIG, "", "combined-prompt", "I want to sign up today, can someone call me?",
      [], "home", "session-esc-1", "visitor_chat",
    );

    expect(result.handoffRequested).toBe(true);
    expect(result.response).toBe("");
    expect(sendSmsMock).not.toHaveBeenCalled();
    expect(sendResendEmailMock).not.toHaveBeenCalled();
    expect(supabasePostMock).not.toHaveBeenCalled();
  });

  it("model-supplied marker details are ignored, not relayed", async () => {
    callAnthropicMock.mockResolvedValueOnce(
      'Ok.\n{"_escalate": true, "reason": "<script>alert(1)</script>", "prospect": "<b>Sam</b>", "contact_value": "sam@example.com"}'
    );
    const result = await handleSingleTurn(
      {}, fakeCtx(), CONFIG, "", "combined-prompt", "Call me",
      [], "home", "session-esc-3", "visitor_chat",
    );
    expect(result.handoffRequested).toBe(true);
    expect(JSON.stringify(result)).not.toContain("sam@example.com");
    expect(sendResendEmailMock).not.toHaveBeenCalled();
  });
});

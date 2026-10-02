import { beforeEach, describe, expect, it, vi } from "vitest";

// Contact handoff, as of 2026-10-01 (repair plan items 1 and 21): the model can
// no longer collect contact details or create a lead. Its escalation, research
// and [COLLECTED] markers only signal that the visitor wants a person; the server
// then runs the dialogue (see handoff-flow.test.js).

const callAnthropicMock = vi.fn();
const supabasePostMock = vi.fn().mockResolvedValue([{ id: 1, alert_id: 1 }]);
const supabaseFetchMock = vi.fn();

vi.mock("../src/shared/runtime.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, callAnthropic: (...a) => callAnthropicMock(...a) };
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

const { COLLECTED_PATTERN } = await import("../src/shared/runtime.js");
const { captureContactHandoff, inferContactMethod } = await import("../src/routes/intake.js");
const { handleSingleTurn, resolveGapMessage } = await import("../src/routes/chat.js");

const fakeCtx = () => ({ waitUntil: (p) => { if (p && typeof p.catch === "function") p.catch(() => {}); } });
const CONFIG = { build_version: "test", stage_gate: "build" };
// The active Operator row. Fictional values on purpose: the code must follow this
// row, not any address written in the source.
const OPERATOR_ROW = { display_name: "Pat", email: "pat@operator.example" };
const OPERATOR = { resolved: true, email: OPERATOR_ROW.email, displayName: OPERATOR_ROW.display_name, notifyEmail: OPERATOR_ROW.email };
const RESOLVE_GAP_MESSAGE = resolveGapMessage(OPERATOR);

// supabaseFetch is called as supabaseFetch(env, table, query). Used here for
// the handoff dedupe check (lead_alerts) and for threshold_config.
function fetchImpl(_env, table) {
  if (table === "threshold_config") return Promise.resolve([{ threshold_low: 0.4, threshold_high: 0.9 }]);
  if (table === "lead_alerts") return Promise.resolve([]); // no prior alert -> not deduped
  if (table === "reviewers") return Promise.resolve([OPERATOR_ROW]);
  return Promise.resolve([]);
}

beforeEach(() => {
  callAnthropicMock.mockReset();
  supabasePostMock.mockClear();
  supabaseFetchMock.mockReset();
  supabaseFetchMock.mockImplementation(fetchImpl);
});

describe("COLLECTED_PATTERN", () => {
  it("captures the JSON object from a well-formed marker", () => {
    const m = 'Thanks!\n[COLLECTED:{"name":"Ed","contact":"ed@frontframe.co","method":"email"}]'.match(COLLECTED_PATTERN);
    expect(m).toBeTruthy();
    expect(JSON.parse(m[1])).toEqual({ name: "Ed", contact: "ed@frontframe.co", method: "email" });
  });

  it("tolerates whitespace and newlines inside and around the marker", () => {
    const m = '[COLLECTED: {\n  "name": "A B",\n  "contact": "480-360-0069"\n} ]'.match(COLLECTED_PATTERN);
    expect(m).toBeTruthy();
    expect(JSON.parse(m[1]).contact).toBe("480-360-0069");
  });

  it("does not match ordinary prose", () => {
    expect("we collected the info".match(COLLECTED_PATTERN)).toBeNull();
  });

  it("strips cleanly, leaving the closing message", () => {
    const raw = 'Got it — Ed will follow up.\n[COLLECTED:{"name":"Ed","contact":"x@y.com"}]';
    expect(raw.replace(COLLECTED_PATTERN, "").trim()).toBe("Got it — Ed will follow up.");
  });
});

describe("inferContactMethod", () => {
  it("honours an explicit method", () => {
    expect(inferContactMethod("text", "x@y.com")).toBe("text");
  });
  it("infers email from an @ address", () => {
    expect(inferContactMethod("", "ed@frontframe.co")).toBe("email");
    expect(inferContactMethod(undefined, "ed@frontframe.co")).toBe("email");
  });
  it("infers phone otherwise", () => {
    expect(inferContactMethod("", "4803600069")).toBe("phone");
  });
});

describe("captureContactHandoff", () => {
  it("writes a lead (email set) and a lead_alert", async () => {
    await captureContactHandoff({}, fakeCtx(), {
      session_id: "s1", name: "Ed Dziuk", contact: "ed@frontframe.co", method: "email",
      zip: "85251", summary: "wants a call about pricing", source: "agent",
    });
    const tables = supabasePostMock.mock.calls.map((c) => c[1]);
    expect(tables).toContain("leads");
    expect(tables).toContain("lead_alerts");
    const leadPayload = supabasePostMock.mock.calls.find((c) => c[1] === "leads")[2];
    expect(leadPayload.email).toBe("ed@frontframe.co");
    expect(leadPayload.phone).toBeNull();
    expect(leadPayload.notes).toContain("85251");
  });

  it("de-dupes on an existing recent lead_alert for the same session", async () => {
    supabaseFetchMock.mockImplementation((_env, table) =>
      table === "lead_alerts" ? Promise.resolve([{ alert_id: 99 }]) : fetchImpl(_env, table));
    const res = await captureContactHandoff({}, fakeCtx(), {
      session_id: "s1", name: "Ed", contact: "ed@frontframe.co",
    });
    expect(res.deduped).toBe(true);
    expect(supabasePostMock).not.toHaveBeenCalled();
  });
});

describe("handleSingleTurn — handoff markers only signal that the visitor wants a person", () => {
  const args = (message, history, reply) => {
    callAnthropicMock.mockResolvedValueOnce(reply);
    return handleSingleTurn({}, fakeCtx(), CONFIG, "", "combined-prompt", message, history, "home", "s1", "visitor_chat");
  };

  it("a [COLLECTED] marker saves nothing and sends nothing; the model's text is not shown", async () => {
    const r = await args(
      "Ed Dziuk, ed@frontframe.co, zip 85251",
      [],
      'Perfect — Ed will be in touch.\n[COLLECTED:{"name":"Ed Dziuk","contact":"ed@frontframe.co","method":"email","zip":"85251","summary":"pricing question"}]',
    );
    expect(r.handoffRequested).toBe(true);
    expect(r.response).toBe("");
    expect(callAnthropicMock).toHaveBeenCalledTimes(1); // generation only; no scoring
    expect(supabasePostMock).not.toHaveBeenCalled();     // no lead, no alert
  });

  it("a _research marker creates no lead", async () => {
    const r = await args("Can you research X for me?", [],
      'Sure.\n{"_research": true, "name": "Ann", "contact": "ann@example.com", "question": "X"}');
    expect(r.handoffRequested).toBe(true);
    expect(supabasePostMock).not.toHaveBeenCalled();
  });

  it("still withholds when the model reports a knowledge gap", async () => {
    const r = await args(
      "just give me your best guess",
      [],
      'I can only say what is written down.\n{"_knowledge_gap": true, "missing": "the refund policy"}',
    );
    expect(r.isWithheld).toBe(true);
    expect(r.handoffRequested).toBeUndefined();
    expect(r.response).toBe(RESOLVE_GAP_MESSAGE);
  });

  it("scores a normal question as before", async () => {
    callAnthropicMock
      .mockResolvedValueOnce("The Standard tier is $3,000.")            // generation
      .mockResolvedValueOnce('{"score":0.95,"rationale":"Directly answers."}'); // SCR
    const r = await handleSingleTurn({}, fakeCtx(), CONFIG, "", "combined-prompt",
      "How much is Standard?", [], "home", "s1", "visitor_chat");
    expect(r.handoffRequested).toBeUndefined();
    expect(callAnthropicMock).toHaveBeenCalledTimes(2); // generation + SCR both ran
    expect(supabasePostMock.mock.calls.map((c) => c[1])).toContain("questions");
  });
});

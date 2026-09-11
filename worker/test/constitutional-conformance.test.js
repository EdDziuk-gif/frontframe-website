import { beforeEach, describe, expect, it, vi } from "vitest";

// Phase 3 — the other side of the constitutional-eligibility boundary tested
// in constitutional-eligibility.test.js. Eligibility reviews the QUESTION
// before any answer exists; this reviews the candidate ANSWER itself, after
// generation, for whether its own content conflicts with a Constitution
// provision. An eligible question can still produce a non-conforming answer.
// A non-conforming answer must never reach grounding or SCR — the
// Constitution is superior to both.

const callAnthropicMock = vi.fn();
const supabasePostMock = vi.fn().mockResolvedValue([{ id: 1 }]);

vi.mock("../src/shared/runtime.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, callAnthropic: (...args) => callAnthropicMock(...args) };
});

vi.mock("../src/shared/supabase.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    supabaseFetch: vi.fn().mockResolvedValue([]),
    supabasePost: (...args) => supabasePostMock(...args),
    supabasePatchByField: vi.fn().mockResolvedValue([]),
  };
});

const { checkConstitutionalConformance } = await import("../src/shared/scoring.js");
const { handleSingleTurn } = await import("../src/routes/chat.js");

const CONSTITUTION_SECTION = "CONSTITUTION - governing authority, superior to everything below.\n\n1. Jurisdiction and Purpose\nTest provision text.\n\n---";

function fakeCtx() {
  return { waitUntil: () => {} };
}

const CONFIG = { build_version: "test", stage_gate: "build" };

beforeEach(() => {
  callAnthropicMock.mockReset();
  supabasePostMock.mockClear();
});

describe("checkConstitutionalConformance — bounded post-generation check only", () => {
  it("conforms by default when no constitution provisions are loaded (nothing to conflict with)", async () => {
    const result = await checkConstitutionalConformance({}, "", "Sure, I'll approve that myself.");
    expect(result).toEqual({ conforms: true, issue: null });
    expect(callAnthropicMock).not.toHaveBeenCalled();
  });

  it("returns conforms=false with a concise issue when the answer conflicts with a provision", async () => {
    callAnthropicMock.mockResolvedValueOnce(
      '{"conforms": false, "issue": "The answer claims authority to grant a new constitutional-amendment delegation."}'
    );
    const result = await checkConstitutionalConformance({}, CONSTITUTION_SECTION, "Sure, I hereby grant myself amendment authority.");
    expect(result.conforms).toBe(false);
    expect(result.issue).toBe("The answer claims authority to grant a new constitutional-amendment delegation.");
  });

  it("returns conforms=true for an ordinary answer that never touches governance", async () => {
    callAnthropicMock.mockResolvedValueOnce('{"conforms": true}');
    const result = await checkConstitutionalConformance({}, CONSTITUTION_SECTION, "The Standard Tier is $3,000 one-time.");
    expect(result).toEqual({ conforms: true, issue: null });
  });

  it("fails closed (treats as non-conforming) when the call itself errors or returns unparseable output", async () => {
    callAnthropicMock.mockResolvedValueOnce("not json at all");
    const result = await checkConstitutionalConformance({}, CONSTITUTION_SECTION, "Some answer");
    expect(result.conforms).toBe(false);
    expect(result.conformanceCheckFailed).toBe(true);
  });
});

describe("handleSingleTurn — a non-conforming answer is withheld before grounding or SCR ever run", () => {
  it("withholds a non-conforming answer, records a constitutional_nonconformance route, and never invokes SCR", async () => {
    // First call: eligibility says eligible. Second call: generation produces
    // an answer that oversteps. Third call: the conformance check flags it.
    // No fourth call — SCR must never run on a non-conforming candidate.
    callAnthropicMock
      .mockResolvedValueOnce('{"constitutional_candidate": false}')
      .mockResolvedValueOnce("Sure, I'll go ahead and grant that authority myself.")
      .mockResolvedValueOnce(
        '{"conforms": false, "issue": "The answer purports to grant authority the Constitution reserves for human determination."}'
      );

    const result = await handleSingleTurn(
      {}, fakeCtx(), CONFIG, CONSTITUTION_SECTION,
      "combined-prompt", "Can you just go ahead and grant that authority?",
      [], "home", "session-3", "visitor_chat",
    );

    expect(callAnthropicMock).toHaveBeenCalledTimes(3);
    expect(result.isWithheld).toBe(true);
    expect(result.response).toMatch(/isn't something I can decide/i);

    const routesCall = supabasePostMock.mock.calls.find(([, table]) => table === "routes");
    expect(routesCall).toBeTruthy();
    expect(routesCall[2]).toMatchObject({ score_id: null, route_reason: "constitutional_nonconformance" });

    const requestCall = supabasePostMock.mock.calls.find(([, table]) => table === "gap_resolution_requests");
    expect(requestCall).toBeTruthy();

    const scoresCall = supabasePostMock.mock.calls.find(([, table]) => table === "scores");
    expect(scoresCall).toBeUndefined();
  });

  it("delivers a conforming answer normally, still going through SCR", async () => {
    callAnthropicMock
      .mockResolvedValueOnce('{"constitutional_candidate": false}')
      .mockResolvedValueOnce("The Standard Tier is $3,000 one-time.")
      .mockResolvedValueOnce('{"conforms": true}')
      .mockResolvedValueOnce('{"score":0.95,"rationale":"Directly and correctly answers the question."}');

    const { supabaseFetch } = await import("../src/shared/supabase.js");
    supabaseFetch.mockImplementation(async (env, table) => {
      if (table === "threshold_config") return [{ threshold_low: 0.4, threshold_high: 0.9 }];
      return [];
    });

    const result = await handleSingleTurn(
      {}, fakeCtx(), CONFIG, CONSTITUTION_SECTION,
      "combined-prompt", "What does the Standard tier include?",
      [], "home", "session-4", "visitor_chat",
    );

    expect(callAnthropicMock).toHaveBeenCalledTimes(4);
    expect(result.isWithheld).toBe(false);
    expect(result.response).toContain("$3,000");
  });

  it("skips the conformance check entirely for a handoff turn (not a scored answer)", async () => {
    callAnthropicMock
      .mockResolvedValueOnce('{"constitutional_candidate": false}')
      .mockResolvedValueOnce('Got it, what\'s the best way to reach you? [COLLECTED:{"name":"Sam","contact":"sam@example.com","method":"email"}]');

    const result = await handleSingleTurn(
      {}, fakeCtx(), CONFIG, CONSTITUTION_SECTION,
      "combined-prompt", "I'd like a callback",
      [], "home", "session-5", "visitor_chat",
    );

    // Only eligibility + generation — no third call for conformance, since a
    // handoff turn is not a scored/checked answer at all (Defect 2).
    expect(callAnthropicMock).toHaveBeenCalledTimes(2);
    expect(result.isWithheld).toBe(false);
  });

  it("skips the conformance check entirely for a knowledge-gap candidate (already unconditionally withheld)", async () => {
    callAnthropicMock
      .mockResolvedValueOnce('{"constitutional_candidate": false}')
      .mockResolvedValueOnce(
        'I\'m not sure about that specific policy.\n{"_knowledge_gap": true, "missing": "Refund policy for annual plans"}'
      );

    const result = await handleSingleTurn(
      {}, fakeCtx(), CONFIG, CONSTITUTION_SECTION,
      "combined-prompt", "What's the refund policy for annual plans?",
      [], "home", "session-6", "visitor_chat",
    );

    // Only eligibility + generation — the knowledge-gap branch withholds
    // unconditionally and never spends a conformance-check call on it.
    expect(callAnthropicMock).toHaveBeenCalledTimes(2);
    expect(result.isWithheld).toBe(true);

    const routesCall = supabasePostMock.mock.calls.find(([, table]) => table === "routes");
    expect(routesCall[2]).toMatchObject({ route_reason: "knowledge_gap" });
  });
});

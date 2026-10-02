import { beforeEach, describe, expect, it, vi } from "vitest";

// Defect 95ebc11f — when the generation call marks its answer {"_kb_grounded": true},
// the answer is verified for FIDELITY to the promulgated corpus instead of being sent
// to appropriateness scoring (which has no corpus and structurally under-scores
// promulgated content). Reuses the live threshold_config. SOURCE self-contradiction
// withholds and files a content defect. Decision 0034 item 7 (amended 2026-10-01): a score below the
// low threshold, or no usable Verifier result, withholds and escalates; it never falls back to SCR.

const callAnthropicMock = vi.fn();
const supabasePostMock = vi.fn();
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

const { KB_GROUNDED_PATTERN } = await import("../src/shared/runtime.js");
const { parseGroundingResult, createGroundingLifecycle } = await import("../src/shared/scoring.js");
const { handleSingleTurn, resolveGapMessage } = await import("../src/routes/chat.js");

const fakeCtx = () => ({ waitUntil: (p) => { if (p && typeof p.catch === "function") p.catch(() => {}); } });
const CONFIG = { build_version: "test", stage_gate: "build" };
// The active Operator row. Fictional values on purpose: the code must follow this
// row, not any address written in the source.
const OPERATOR_ROW = { display_name: "Pat", email: "pat@operator.example" };
const OPERATOR = { resolved: true, email: OPERATOR_ROW.email, displayName: OPERATOR_ROW.display_name, notifyEmail: OPERATOR_ROW.email };
const RESOLVE_GAP_MESSAGE = resolveGapMessage(OPERATOR);
const CORPUS = "SYSTEM PROMPT ...\n\nKnowledge Base:\n\nQ: What does the Professional tier add?\nA: Everything in Standard plus advanced client management, multi-service booking, priority build and support, and extended maintenance.";

// supabasePost returns an incrementing id per table so route/score ids are inspectable.
let seq;
function postImpl(_env, table) {
  seq += 1;
  return Promise.resolve([{ id: seq, alert_id: seq }]);
}
function fetchImpl(_env, table) {
  if (table === "threshold_config") return Promise.resolve([{ threshold_low: 0.4, threshold_high: 0.9 }]);
  if (table === "reviewers") return Promise.resolve([OPERATOR_ROW]);
  return Promise.resolve([]);
}
const postsTo = (table) => supabasePostMock.mock.calls.filter((c) => c[1] === table);

beforeEach(() => {
  seq = 0;
  callAnthropicMock.mockReset();
  supabasePostMock.mockReset().mockImplementation(postImpl);
  supabaseFetchMock.mockReset().mockImplementation(fetchImpl);
});

describe("parseGroundingResult", () => {
  it("parses score + rationale + source_conflict", () => {
	expect(parseGroundingResult('{"score":0.9,"rationale":"Supported.","source_conflict":false}'))
	  .toEqual({ score: 0.9, rationale: "Supported.", sourceConflict: false });
  });
  it("defaults source_conflict to false when omitted", () => {
	expect(parseGroundingResult('{"score":0.8,"rationale":"Fine."}').sourceConflict).toBe(false);
  });
  it("rejects invalid JSON and out-of-range scores", () => {
	expect(() => parseGroundingResult("not json")).toThrow();
	expect(() => parseGroundingResult('{"score":1.4,"rationale":"x"}')).toThrow();
  });
});

describe("KB_GROUNDED_PATTERN", () => {
  it("matches and strips a trailing marker", () => {
	const r = 'The Professional tier adds X.\n{"_kb_grounded": true}';
	expect(r.match(KB_GROUNDED_PATTERN)).toBeTruthy();
	expect(r.replace(KB_GROUNDED_PATTERN, "").trim()).toBe("The Professional tier adds X.");
  });
  it("does not match a mid-reply mention", () => {
	expect('I could set {"_kb_grounded": true} but I will not.'.match(KB_GROUNDED_PATTERN)).toBeNull();
  });
});

describe("createGroundingLifecycle", () => {
  const run = (answer = "A") =>
	createGroundingLifecycle({}, { question: "Q", answer, corpus: CORPUS, askedBy: "s1", source: "visitor_chat" });

  it("verified grounded → respond_strong, route_reason kb_grounded, no gap request", async () => {
	callAnthropicMock.mockResolvedValueOnce('{"score":0.95,"rationale":"Fully supported by SOURCE.","source_conflict":false}');
	const r = await run();
	expect(r.route).toBe("respond_strong");
	expect(r.routeReason).toBe("kb_grounded");
	const routePayload = postsTo("routes")[0][2];
	expect(routePayload.route_reason).toBe("kb_grounded");
	expect(routePayload.route_decision).toBe("respond_strong");
	expect(postsTo("scores")[0][2].rationale).toMatch(/^\[grounding\]/);
	expect(postsTo("gap_resolution_requests")).toHaveLength(0);
	expect(callAnthropicMock).toHaveBeenCalledTimes(1); // grounding only, no SCR
  });

  it("mid-band grounding score → respond_limited", async () => {
	callAnthropicMock.mockResolvedValueOnce('{"score":0.6,"rationale":"Mostly supported.","source_conflict":false}');
	expect((await run()).route).toBe("respond_limited");
  });

  it("source_conflict → resolve_gap route_reason source_conflict + gap request", async () => {
	callAnthropicMock.mockResolvedValueOnce('{"score":0.5,"rationale":"SOURCE gives two different prices.","source_conflict":true}');
	const r = await run();
	expect(r.route).toBe("source_conflict");
	expect(r.sourceConflict).toBe(true);
	expect(postsTo("routes")[0][2]).toMatchObject({ route_decision: "resolve_gap", route_reason: "source_conflict" });
	expect(postsTo("gap_resolution_requests")).toHaveLength(1);
	expect(callAnthropicMock).toHaveBeenCalledTimes(1); // no SCR
  });

  it("grounding below the low threshold → withheld, grounding_below_floor route, gap request, SCR never called", async () => {
	callAnthropicMock.mockResolvedValueOnce('{"score":0.15,"rationale":"Adds claims not in SOURCE.","source_conflict":false}');
	const r = await run();
	expect(r.route).toBe("resolve_gap");
	expect(r.routeReason).toBe("grounding_below_floor");
	expect(r.groundingFailed).toBe(false); // the Verifier worked; the answer failed it
	expect(r.groundingScore).toBe(0.15);
	expect(postsTo("routes")[0][2]).toMatchObject({ route_decision: "resolve_gap", route_reason: "grounding_below_floor" });
	expect(postsTo("scores")).toHaveLength(1); // the grounding score only; no SCR score
	expect(postsTo("gap_resolution_requests")).toHaveLength(1);
	expect(callAnthropicMock).toHaveBeenCalledTimes(1); // Verifier only
  });

  it("score exactly at the low threshold is not below the floor", async () => {
	callAnthropicMock.mockResolvedValueOnce('{"score":0.4,"rationale":"Barely supported.","source_conflict":false}');
	const r = await run();
	expect(r.route).toBe("respond_limited");
	expect(r.routeReason).toBe("kb_grounded");
  });

  it("verifier returns bad JSON → withheld, grounding_unavailable route, no score row, SCR never called", async () => {
	callAnthropicMock.mockResolvedValueOnce("garbage not json");
	const r = await run();
	expect(r.route).toBe("resolve_gap");
	expect(r.routeReason).toBe("grounding_unavailable");
	expect(r.groundingFailed).toBe(true);
	expect(r.groundingScore).toBeNull(); // no score fabricated
	expect(r.groundingRationale).toMatch(/invalid JSON/);
	expect(postsTo("scores")).toHaveLength(0);
	const routePayload = postsTo("routes")[0][2];
	expect(routePayload).toMatchObject({ route_decision: "resolve_gap", route_reason: "grounding_unavailable" });
	expect(routePayload.score_id).toBeNull();
	expect(postsTo("gap_resolution_requests")).toHaveLength(1);
	expect(callAnthropicMock).toHaveBeenCalledTimes(1);
  });

  it.each([
	["call error", () => callAnthropicMock.mockRejectedValueOnce(new Error("Anthropic API 529"))],
	["score out of range", () => callAnthropicMock.mockResolvedValueOnce('{"score":1.7,"rationale":"x","source_conflict":false}')],
	["missing rationale", () => callAnthropicMock.mockResolvedValueOnce('{"score":0.9,"source_conflict":false}')],
  ])("verifier %s → withheld as grounding_unavailable, never delivered", async (_label, arrange) => {
	arrange();
	const r = await run();
	expect(r.route).toBe("resolve_gap");
	expect(r.routeReason).toBe("grounding_unavailable");
	expect(r.groundingFailed).toBe(true);
	expect(callAnthropicMock).toHaveBeenCalledTimes(1);
  });
});

describe("handleSingleTurn — _kb_grounded", () => {
  const turn = (reply, history = []) => {
	callAnthropicMock.mockResolvedValueOnce(reply);
	return handleSingleTurn({}, fakeCtx(), CONFIG, "", "combined", "What does the Professional tier add?", history, "home", "s1", "visitor_chat", CORPUS);
  };

  it("verified grounded → delivered, marker stripped, SCR never called", async () => {
	callAnthropicMock.mockReset();
	callAnthropicMock
	  .mockResolvedValueOnce('The Professional tier adds advanced client management and multi-service booking.\n{"_kb_grounded": true}')
	  .mockResolvedValueOnce('{"score":0.96,"rationale":"Supported.","source_conflict":false}');
	const r = await handleSingleTurn({}, fakeCtx(), CONFIG, "", "combined", "Q", [], "home", "s1", "visitor_chat", CORPUS);
	expect(r.isWithheld).toBe(false);
	expect(r.response).toBe("The Professional tier adds advanced client management and multi-service booking.");
	expect(r.response).not.toMatch(/_kb_grounded/);
	expect(callAnthropicMock).toHaveBeenCalledTimes(2); // generation + grounding, no SCR
	expect(postsTo("routes")[0][2].route_reason).toBe("kb_grounded");
  });

  it("source_conflict → withheld + a content/major defect", async () => {
	callAnthropicMock.mockReset();
	callAnthropicMock
	  .mockResolvedValueOnce('Standard is $3,000.\n{"_kb_grounded": true}')
	  .mockResolvedValueOnce('{"score":0.4,"rationale":"SOURCE states two different Standard prices.","source_conflict":true}');
	const r = await handleSingleTurn({}, fakeCtx(), CONFIG, "", "combined", "Q", [], "home", "s1", "visitor_chat", CORPUS);
	expect(r.isWithheld).toBe(true);
	expect(r.response).toBe(RESOLVE_GAP_MESSAGE);
	const defect = postsTo("defects")[0][2];
	expect(defect).toMatchObject({ area: "content", severity: "major" });
	expect(defect.description).toMatch(/\[corpus-conflict\]/);
  });

  it("grounding below the floor → withheld and escalated, no SCR, no delivery, no defect (the gap request is the record)", async () => {
	callAnthropicMock.mockReset();
	callAnthropicMock
	  .mockResolvedValueOnce('Professional includes unlimited revisions.\n{"_kb_grounded": true}')
	  .mockResolvedValueOnce('{"score":0.1,"rationale":"Unlimited revisions are not in SOURCE.","source_conflict":false}');
	const r = await handleSingleTurn({}, fakeCtx(), CONFIG, "", "combined", "Q", [], "home", "s1", "visitor_chat", CORPUS);
	expect(r.isWithheld).toBe(true);
	expect(r.response).toBe(RESOLVE_GAP_MESSAGE);
	expect(callAnthropicMock).toHaveBeenCalledTimes(2); // generation + Verifier; SCR never called
	expect(postsTo("routes")[0][2]).toMatchObject({ route_decision: "resolve_gap", route_reason: "grounding_below_floor" });
	expect(postsTo("gap_resolution_requests")).toHaveLength(1);
	expect(postsTo("defects")).toHaveLength(0);
  });

  it("Verifier failure → withheld and escalated, never delivered, and an [agentic] defect is filed", async () => {
	callAnthropicMock.mockReset();
	callAnthropicMock
	  .mockResolvedValueOnce('Standard is $3,000.\n{"_kb_grounded": true}')
	  .mockRejectedValueOnce(new Error("Anthropic API 529"));
	const r = await handleSingleTurn({}, fakeCtx(), CONFIG, "", "combined", "Q", [], "home", "s1", "visitor_chat", CORPUS);
	expect(r.isWithheld).toBe(true);
	expect(r.response).toBe(RESOLVE_GAP_MESSAGE);
	expect(r.response).not.toMatch(/\$3,000/);
	expect(callAnthropicMock).toHaveBeenCalledTimes(2); // generation + failed Verifier; no SCR
	expect(postsTo("routes")[0][2]).toMatchObject({ route_decision: "resolve_gap", route_reason: "grounding_unavailable" });
	const defect = postsTo("defects")[0][2];
	expect(defect.description).toMatch(/Grounding Verifier produced no usable result/);
  });

  it("both markers present → knowledge-gap wins (withheld via gap path)", async () => {
	callAnthropicMock.mockReset();
	callAnthropicMock.mockResolvedValueOnce(
	  'Partial answer.\n{"_kb_grounded": true}\n{"_knowledge_gap": true, "missing": "the cancellation policy"}',
	);
	const r = await handleSingleTurn({}, fakeCtx(), CONFIG, "", "combined", "Q", [], "home", "s1", "visitor_chat", CORPUS);
	expect(r.isWithheld).toBe(true);
	expect(r.response).toBe(RESOLVE_GAP_MESSAGE);
	// grounding verification never ran
	expect(callAnthropicMock).toHaveBeenCalledTimes(1);
  });

  it("no marker → ordinary SCR path unchanged", async () => {
	callAnthropicMock.mockReset();
	callAnthropicMock
	  .mockResolvedValueOnce("A plain answer with no marker.")
	  .mockResolvedValueOnce('{"score":0.95,"rationale":"Directly answers."}');
	const r = await handleSingleTurn({}, fakeCtx(), CONFIG, "", "combined", "Q", [], "home", "s1", "visitor_chat", CORPUS);
	expect(r.isWithheld).toBe(false);
	expect(postsTo("routes")[0][2].route_reason).toBe("scr");
	expect(callAnthropicMock).toHaveBeenCalledTimes(2);
  });
});

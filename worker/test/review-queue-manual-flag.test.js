import { beforeEach, describe, expect, it, vi } from "vitest";

// Manual counterpart to the review_queue rows chat.js's auto-evaluator writes
// (flag_source: "auto"). Lets a reviewer flag a response they saw directly —
// live testing, a visitor complaint — without a stored session transcript to
// pull from. Lands in the same table/queue, status "candidate".

const supabasePostMock = vi.fn();

vi.mock("../src/shared/supabase.js", () => ({
  supabaseFetch:  vi.fn(),
  supabasePost:   (...a) => supabasePostMock(...a),
  supabasePatch:  vi.fn(),
  supabasePatchByField: vi.fn(),
  supabaseRpc:    vi.fn(),
  supabaseUpsert: vi.fn(),
  supabaseDelete: vi.fn(),
  supabaseHeaders: () => ({}),
}));

const { createReviewQueueItem } = await import("../src/routes/outreach.js");

const ENV = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "service-key" };
const CH = {};

function req(body) {
  return { json: () => Promise.resolve(body) };
}

beforeEach(() => { vi.clearAllMocks(); });

describe("createReviewQueueItem — manual challenge entry point", () => {
  it("401s without a JWT", async () => {
    const res = await createReviewQueueItem(req({}), ENV, null, CH);
    expect(res.status).toBe(401);
    expect(supabasePostMock).not.toHaveBeenCalled();
  });

  it("400s when visitor_message or bot_response is missing", async () => {
    const res = await createReviewQueueItem(req({ visitor_message: "  " }), ENV, "jwt", CH);
    expect(res.status).toBe(400);
    expect(supabasePostMock).not.toHaveBeenCalled();
  });

  it("creates a candidate row with flag_source 'manual' and no auto score/reasoning", async () => {
    supabasePostMock.mockResolvedValueOnce([{ id: 1 }]);
    const res = await createReviewQueueItem(
      req({ visitor_message: "What does the Standard tier include?", bot_response: "It includes X.", notes: "Missing the payment terms." }),
      ENV, "jwt", CH,
    );
    expect(res.status).toBe(201);
    expect(supabasePostMock).toHaveBeenCalledWith(ENV, "review_queue", {
      flagged_turn: { visitor_message: "What does the Standard tier include?", bot_response: "It includes X." },
      flag_source: "manual",
      status: "candidate",
      notes: "Missing the payment terms.",
    }, "jwt");
  });

  it("stores notes as null when omitted", async () => {
    supabasePostMock.mockResolvedValueOnce([{ id: 2 }]);
    await createReviewQueueItem(req({ visitor_message: "Q", bot_response: "A" }), ENV, "jwt", CH);
    expect(supabasePostMock.mock.calls[0][2].notes).toBeNull();
  });
});

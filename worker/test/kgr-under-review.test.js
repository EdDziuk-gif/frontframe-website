import { beforeEach, describe, expect, it, vi } from "vitest";

// Migration 014 §3.4a — the "under active review" set.
// underReviewQaPairIds(env, page) returns the ids of implemented qa_pairs, on
// the given page scope, that an OPEN KGR replacement case is reworking:
//   * resolution_target = 'qa_pair' AND supersedes_qa_pair_id IS NOT NULL
//   * no signed-off kgr_resolution_statement for that case (any case status,
//     including escalated)
// chat.js prepends the disclosure caveat to each such pair's answer.

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

const { underReviewQaPairIds } = await import("../src/routes/kgr.js");

const ENV = { SUPABASE_URL: "https://example.supabase.co", SUPABASE_SERVICE_ROLE_KEY: "k" };

beforeEach(() => { vi.clearAllMocks(); });

describe("underReviewQaPairIds", () => {
  it("only ever asks kgr_cases for qa_pair replacement targets", async () => {
    supabaseFetchMock.mockResolvedValueOnce([]);   // kgr_cases
    await underReviewQaPairIds(ENV, "home");
    const [, table, query] = supabaseFetchMock.mock.calls[0];
    expect(table).toBe("kgr_cases");
    expect(query).toContain("resolution_target=eq.qa_pair");
    expect(query).toContain("supersedes_qa_pair_id=not.is.null");
  });

  it("includes a pair reworked by an in_development replacement case", async () => {
    supabaseFetchMock
      .mockResolvedValueOnce([{ supersedes_qa_pair_id: "qa-1", kgr_resolution_statements: [] }])
      .mockResolvedValueOnce([{ id: "qa-1" }]);
    const ids = await underReviewQaPairIds(ENV, "home");
    expect(ids).toEqual(["qa-1"]);
  });

  it("still includes a pair whose replacement case is escalated (statement not signed off)", async () => {
    supabaseFetchMock
      .mockResolvedValueOnce([{ supersedes_qa_pair_id: "qa-2", kgr_resolution_statements: [{ signed_off_at: null }] }])
      .mockResolvedValueOnce([{ id: "qa-2" }]);
    const ids = await underReviewQaPairIds(ENV, "home");
    expect(ids).toEqual(["qa-2"]);
  });

  it("excludes a pair once its replacement case has a signed-off statement", async () => {
    supabaseFetchMock.mockResolvedValueOnce([
      { supersedes_qa_pair_id: "qa-3", kgr_resolution_statements: [{ signed_off_at: "2026-09-09T00:00:00Z" }] },
    ]);
    const ids = await underReviewQaPairIds(ENV, "home");
    expect(ids).toEqual([]);
    expect(supabaseFetchMock).toHaveBeenCalledTimes(1);   // no qa_pairs lookup when the set is empty
  });

  it("one signed-off case does not clear another still-open case's pair", async () => {
    supabaseFetchMock
      .mockResolvedValueOnce([
        { supersedes_qa_pair_id: "qa-open",   kgr_resolution_statements: [] },
        { supersedes_qa_pair_id: "qa-closed", kgr_resolution_statements: [{ signed_off_at: "2026-09-09T00:00:00Z" }] },
      ])
      .mockResolvedValueOnce([{ id: "qa-open" }]);
    const ids = await underReviewQaPairIds(ENV, "home");
    expect(ids).toEqual(["qa-open"]);
    const qaQuery = supabaseFetchMock.mock.calls[1][2];
    expect(qaQuery).toContain('id=in.("qa-open")');
    expect(qaQuery).not.toContain("qa-closed");
  });

  it("restricts the qa_pairs lookup to implemented rows on the page scope", async () => {
    supabaseFetchMock
      .mockResolvedValueOnce([{ supersedes_qa_pair_id: "qa-9", kgr_resolution_statements: [] }])
      .mockResolvedValueOnce([]);
    await underReviewQaPairIds(ENV, "yours");
    const qaQuery = supabaseFetchMock.mock.calls[1][2];
    expect(qaQuery).toContain("status=eq.implemented");
    expect(qaQuery).toContain("or=(page.eq.all,page.eq.yours)");
  });

  it("returns only the pairs the page-scoped lookup confirms are served", async () => {
    supabaseFetchMock
      .mockResolvedValueOnce([
        { supersedes_qa_pair_id: "qa-a", kgr_resolution_statements: [] },
        { supersedes_qa_pair_id: "qa-b", kgr_resolution_statements: [] },
      ])
      .mockResolvedValueOnce([{ id: "qa-a" }]);   // qa-b is on another page / not implemented
    const ids = await underReviewQaPairIds(ENV, "home");
    expect(ids).toEqual(["qa-a"]);
  });

  it("throws when the kgr_cases read does not return an array (caller serves without the caveat)", async () => {
    supabaseFetchMock.mockResolvedValueOnce({ error: "boom" });
    await expect(underReviewQaPairIds(ENV, "home")).rejects.toThrow();
  });
});

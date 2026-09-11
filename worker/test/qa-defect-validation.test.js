import { beforeEach, describe, expect, it, vi } from "vitest";

// Defect 2f57a6b5: the defect write routes passed area/severity/disposition/
// status straight through, so a value outside the DB CHECK constraint became an
// opaque PostgREST 500 (client saw "Failed to fetch"). These routes now
// validate up front and 400 — with CORS headers — instead.
//
// The Q&A write validation that used to live here is gone: migration 014 (KGR
// corpus-write governance) removed createQaPair / updateQaPair / deleteQaPair
// entirely — qa_pairs is written only by KGR sign-off.

const supabasePostMock = vi.fn().mockResolvedValue([{ id: "row-1" }]);
const supabasePatchMock = vi.fn().mockResolvedValue([{ id: "row-1" }]);
const supabaseDeleteMock = vi.fn().mockResolvedValue(undefined);

vi.mock("../src/shared/supabase.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    supabasePost: (...a) => supabasePostMock(...a),
    supabasePatch: (...a) => supabasePatchMock(...a),
    supabaseDelete: (...a) => supabaseDeleteMock(...a),
    supabaseFetch: vi.fn().mockResolvedValue([{ build_version: "vT", stage_gate: "build" }]),
  };
});

const { createDefect, updateDefect, deleteDefect } = await import("../src/routes/operations.js");

const CORS = { "Access-Control-Allow-Origin": "*" };
const req = (obj) => ({ json: async () => obj });

beforeEach(() => {
  supabasePostMock.mockClear();
  supabasePatchMock.mockClear();
});

describe("createDefect / updateDefect validation", () => {
  it("createDefect rejects area=agentic_scoring and severity=high", async () => {
    expect((await createDefect(req({ area: "agentic_scoring", description: "d", severity: "major" }), {}, "jwt", CORS)).status).toBe(400);
    expect((await createDefect(req({ area: "bot", description: "d", severity: "high" }), {}, "jwt", CORS)).status).toBe(400);
    expect(supabasePostMock).not.toHaveBeenCalled();
  });

  it("createDefect accepts a valid triple", async () => {
    const res = await createDefect(req({ area: "bot", description: "d", severity: "major" }), {}, "jwt", CORS);
    expect(res.status).toBe(201);
  });

  it("updateDefect rejects an out-of-enum status", async () => {
    const res = await updateDefect(req({ status: "closed" }), {}, "id1", "jwt", CORS);
    expect(res.status).toBe(400);
    expect(supabasePatchMock).not.toHaveBeenCalled();
  });

  it("updateDefect passes status=resolved through", async () => {
    const res = await updateDefect(req({ status: "resolved" }), {}, "id1", "jwt", CORS);
    expect(res.status).toBe(200);
    expect(supabasePatchMock).toHaveBeenCalled();
  });

  it("deleteDefect removes a defect that isn't being fixed right now", async () => {
    const res = await deleteDefect({}, "id1", "jwt", CORS);
    expect(res.status).toBe(200);
    expect(supabaseDeleteMock).toHaveBeenCalledWith({}, "defects", "id1", "jwt");
  });
});

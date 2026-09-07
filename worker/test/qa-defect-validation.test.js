import { beforeEach, describe, expect, it, vi } from "vitest";

// Defect 2f57a6b5: the Q&A and defect write routes passed status/page/area/
// severity/disposition straight through, so a value outside the DB CHECK
// constraint became an opaque PostgREST 500 (client saw "Failed to fetch").
// These routes now validate up front and 400 — with CORS headers — instead.

const supabasePostMock = vi.fn().mockResolvedValue([{ id: "row-1" }]);
const supabasePatchMock = vi.fn().mockResolvedValue([{ id: "row-1" }]);

vi.mock("../src/shared/supabase.js", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    supabasePost: (...a) => supabasePostMock(...a),
    supabasePatch: (...a) => supabasePatchMock(...a),
    supabaseFetch: vi.fn().mockResolvedValue([{ build_version: "vT", stage_gate: "build" }]),
  };
});

const { createQaPair, updateQaPair } = await import("../src/routes/content.js");
const { createDefect, updateDefect } = await import("../src/routes/operations.js");

const CORS = { "Access-Control-Allow-Origin": "*" };
const req = (obj) => ({ json: async () => obj });

beforeEach(() => {
  supabasePostMock.mockClear();
  supabasePatchMock.mockClear();
});

async function body(res) { return JSON.parse(await res.text()); }

describe("updateQaPair validation", () => {
  it("rejects an out-of-enum status with a 400 that carries CORS headers", async () => {
    const res = await updateQaPair(req({ status: "dismissed" }), {}, "id1", CORS);
    expect(res.status).toBe(400);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect((await body(res)).error).toMatch(/under_review/);
    expect(supabasePatchMock).not.toHaveBeenCalled();
  });

  it("rejects an unknown page", async () => {
    const res = await updateQaPair(req({ page: "hompage" }), {}, "id1", CORS);
    expect(res.status).toBe(400);
    expect(supabasePatchMock).not.toHaveBeenCalled();
  });

  it("passes a valid status through to the DB", async () => {
    const res = await updateQaPair(req({ status: "under_review" }), {}, "id1", CORS);
    expect(res.status).toBe(200);
    expect(supabasePatchMock).toHaveBeenCalledWith({}, "qa_pairs", "id1", { status: "under_review" });
  });

  it("still 400s when no fields are supplied", async () => {
    const res = await updateQaPair(req({}), {}, "id1", CORS);
    expect(res.status).toBe(400);
    expect((await body(res)).error).toMatch(/No fields/);
  });
});

describe("createQaPair validation", () => {
  it("rejects an out-of-enum status", async () => {
    const res = await createQaPair(req({ question: "q", answer: "a", status: "dismissed" }), {}, CORS);
    expect(res.status).toBe(400);
    expect(supabasePostMock).not.toHaveBeenCalled();
  });

  it("now accepts and forwards a valid status (previously ignored)", async () => {
    const res = await createQaPair(req({ question: "q", answer: "a", page: "yours", status: "implemented" }), {}, CORS);
    expect(res.status).toBe(201);
    expect(supabasePostMock).toHaveBeenCalledWith({}, "qa_pairs", { question: "q", answer: "a", page: "yours", status: "implemented" });
  });

  it("defaults page to all and omits status when not given", async () => {
    await createQaPair(req({ question: "q", answer: "a" }), {}, CORS);
    expect(supabasePostMock).toHaveBeenCalledWith({}, "qa_pairs", { question: "q", answer: "a", page: "all" });
  });
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
});

import { describe, expect, it } from "vitest";
import { buildQaPairsQuery } from "../src/shared/runtime.js";

describe("Q&A corpus query for visitor generation", () => {
  it("restricts the corpus to promulgated (implemented) pairs", () => {
    expect(buildQaPairsQuery("home")).toContain("status=eq.implemented");
  });

  it("keeps the shared-core + page-specific OR filter", () => {
    expect(buildQaPairsQuery("home")).toContain("or=(page.eq.all,page.eq.home)");
  });

  it("preserves deterministic ordering", () => {
    expect(buildQaPairsQuery("home")).toContain("order=created_at.asc");
  });

  it("only selects the fields generation needs", () => {
    expect(buildQaPairsQuery("home")).toContain("select=question,answer");
  });

  it("URL-encodes the page value", () => {
    expect(buildQaPairsQuery("a b")).toContain("page.eq.a%20b");
    expect(buildQaPairsQuery("ADVISOR")).toContain("page.eq.ADVISOR");
  });

  it("ANDs status with the page filter (status is its own top-level param)", () => {
    const q = buildQaPairsQuery("yours");
    expect(q.startsWith("?")).toBe(true);
    expect(q).toMatch(/&status=eq\.implemented(&|$)/);
    // no page value other than 'all' and the requested page is referenced
    expect(q).not.toContain("page.eq.discovery");
  });
});

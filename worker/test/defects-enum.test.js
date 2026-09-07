import { describe, expect, it } from "vitest";
import { agenticDefect, coerceDefectArea, coerceDefectSeverity } from "../src/routes/chat.js";

// The defects table CHECK constraints reject anything outside:
//   area     ∈ {bot, ui, content, form, payment, contract, other}
//   severity ∈ {blocking, major, minor, cosmetic}
// The chat pipeline previously wrote area:"agentic_scoring" / severity:"high"
// (and "conversation"/"low" fallbacks), so every self-reported defect was
// silently dropped. These helpers keep every write inside the enums.

describe("defect enum coercion", () => {
  it("passes through valid area / severity", () => {
    expect(coerceDefectArea("ui")).toBe("ui");
    expect(coerceDefectArea("content")).toBe("content");
    expect(coerceDefectSeverity("blocking")).toBe("blocking");
    expect(coerceDefectSeverity("cosmetic")).toBe("cosmetic");
  });

  it("maps out-of-enum values to safe defaults", () => {
    expect(coerceDefectArea("agentic_scoring")).toBe("bot");
    expect(coerceDefectArea("conversation")).toBe("bot");
    expect(coerceDefectArea(undefined)).toBe("bot");
    expect(coerceDefectSeverity("high")).toBe("minor");
    expect(coerceDefectSeverity("low")).toBe("minor");
    expect(coerceDefectSeverity(null)).toBe("minor");
  });

  it("agenticDefect produces a constraint-valid payload with an [agentic] tag", () => {
    const p = agenticDefect({ build_version: "v9", stage_gate: "build" }, "Phase D scoring pipeline failed: boom");
    expect(p.area).toBe("bot");
    expect(p.severity).toBe("major");
    expect(p.disposition).toBe("retain");
    expect(p.description).toBe("[agentic] Phase D scoring pipeline failed: boom");
    expect(p.build_version).toBe("v9");
    expect(p.stage_gate).toBe("build");
  });

  it("agenticDefect tolerates a missing config", () => {
    const p = agenticDefect({}, "x");
    expect(p.build_version).toBe("unknown");
    expect(p.stage_gate).toBe("build");
  });
});

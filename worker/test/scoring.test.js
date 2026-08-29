import { describe, expect, it } from "vitest";
import { parseScoringResult, routeScore } from "../src/shared/scoring.js";

describe("Phase D Scoring Consumer routing", () => {
  it("routes below the lower threshold to resolve_gap", () => {
    expect(routeScore(0.39, 0.40, 0.90)).toBe("resolve_gap");
  });

  it("routes the lower boundary to respond_limited", () => {
    expect(routeScore(0.40, 0.40, 0.90)).toBe("respond_limited");
  });

  it("routes the middle band to respond_limited", () => {
    expect(routeScore(0.75, 0.40, 0.90)).toBe("respond_limited");
  });

  it("routes the upper boundary to respond_strong", () => {
    expect(routeScore(0.90, 0.40, 0.90)).toBe("respond_strong");
  });

  it("routes above the upper threshold to respond_strong", () => {
    expect(routeScore(0.98, 0.40, 0.90)).toBe("respond_strong");
  });

  it("rejects invalid threshold configurations", () => {
    expect(() => routeScore(0.5, 0.9, 0.4)).toThrow();
    expect(() => routeScore(0.5, 0.4, 0.4)).toThrow();
  });
});

describe("Phase D Scoring Agent output parsing", () => {
  it("accepts the required JSON contract", () => {
    expect(parseScoringResult('{"score":0.82,"rationale":"The answer directly addresses the request."}'))
      .toEqual({ score: 0.82, rationale: "The answer directly addresses the request." });
  });

  it("accepts a fenced JSON object defensively", () => {
    expect(parseScoringResult('```json\n{"score":0.5,"rationale":"Residual ambiguity limits confidence."}\n```'))
      .toEqual({ score: 0.5, rationale: "Residual ambiguity limits confidence." });
  });

  it("rejects malformed or out-of-range output", () => {
    expect(() => parseScoringResult("not json")).toThrow();
    expect(() => parseScoringResult('{"score":1.2,"rationale":"Too high."}')).toThrow();
    expect(() => parseScoringResult('{"score":0.5,"rationale":""}')).toThrow();
  });
});

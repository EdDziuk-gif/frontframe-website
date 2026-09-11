import { describe, expect, it } from "vitest";
import { parseJsonObject } from "../src/shared/runtime.js";

// Root-cause regression test for the 2026-09-11 production incident: every
// "return exactly one JSON object and no other text" call in the pipeline
// (eligibility, conformance, SCR scoring, grounding, decomposition) assumed
// the whole cleaned response WAS that JSON object and passed it straight to
// JSON.parse. The fast model doesn't always honor "no other text" as
// reliably as the full model — it can append a blank line and trailing
// commentary after an otherwise-correct object — which threw a SyntaxError
// and made every one of these checks fail closed on every single request.

describe("parseJsonObject — tolerates trailing/leading text around the JSON object", () => {
  it("parses a bare JSON object with no surrounding text", () => {
    expect(parseJsonObject('{"constitutional_candidate": false}')).toEqual({ constitutional_candidate: false });
  });

  it("strips markdown code fences", () => {
    expect(parseJsonObject('```json\n{"score":0.9,"rationale":"fine"}\n```')).toEqual({ score: 0.9, rationale: "fine" });
  });

  it("ignores trailing prose after the JSON object (the actual production failure mode)", () => {
    const raw = '{"constitutional_candidate": false}\n\nThis question is a routine pricing inquiry with no governance implications.';
    expect(parseJsonObject(raw)).toEqual({ constitutional_candidate: false });
  });

  it("ignores leading prose before the JSON object", () => {
    const raw = 'Sure, here is my answer:\n{"conforms": true}';
    expect(parseJsonObject(raw)).toEqual({ conforms: true });
  });

  it("does not miscount braces that appear inside a quoted string value", () => {
    const raw = '{"conforms": false, "issue": "Claims authority over {special} pricing exceptions."}';
    expect(parseJsonObject(raw)).toEqual({ conforms: false, issue: "Claims authority over {special} pricing exceptions." });
  });

  it("does not miscount an escaped quote inside a string value", () => {
    const raw = '{"rationale": "The visitor asked \\"what does it cost\\" and got a direct answer."}';
    expect(parseJsonObject(raw).rationale).toBe('The visitor asked "what does it cost" and got a direct answer.');
  });

  it("throws when no JSON object is present", () => {
    expect(() => parseJsonObject("not json at all")).toThrow();
  });

  it("throws on an unterminated JSON object", () => {
    expect(() => parseJsonObject('{"score": 0.5, "rationale": "cut off')).toThrow();
  });
});

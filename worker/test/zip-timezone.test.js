import { describe, expect, it } from "vitest";
import { localTimeNow, timezoneForZip, timezoneLabel } from "../src/shared/zip-timezone.js";

// The Operator uses the zone to time a call back (Ed's stated purpose for the zip).
describe("timezoneForZip", () => {
  it.each([
    ["85251", "America/Phoenix"],      // Scottsdale: no daylight saving
    ["10001", "America/New_York"],
    ["60601", "America/Chicago"],
    ["80202", "America/Denver"],
    ["90210", "America/Los_Angeles"],
    ["96813", "Pacific/Honolulu"],
    ["99501", "America/Anchorage"],
    ["79901", "America/Denver"],       // El Paso
    ["75201", "America/Chicago"],      // Dallas
    ["32501", "America/Chicago"],      // Pensacola (panhandle)
    ["33101", "America/New_York"],     // Miami
    ["37201", "America/Chicago"],      // Nashville
    ["37902", "America/New_York"],     // Knoxville
    ["40202", "America/New_York"],     // Louisville
    ["42101", "America/Chicago"],      // Bowling Green KY
    ["89101", "America/Los_Angeles"],  // Las Vegas
    ["00901", "America/Puerto_Rico"],
    ["85251-1234", "America/Phoenix"],
  ])("%s -> %s", (zip, tz) => expect(timezoneForZip(zip)).toBe(tz));

  it("returns null for anything it cannot place", () => {
    for (const z of ["", null, undefined, "abc", "1234", "96910", "09001", "34001", "96201", "000000", "84"])
      expect(timezoneForZip(z)).toBeNull();
  });

  it("labels and local time", () => {
    expect(timezoneLabel("America/Phoenix")).toContain("Arizona");
    expect(timezoneLabel("America/Chicago")).toBe("Central time");
    expect(localTimeNow("America/Phoenix", new Date("2026-10-02T01:01:00Z"))).toBe("6:01 PM");
    expect(localTimeNow(null)).toBeNull();
    expect(localTimeNow("Not/AZone")).toBeNull();
  });
});

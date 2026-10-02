// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: zip code -> time zone
// ════════════════════════════════════════════════════════════════════════════
//
// So the Operator knows when to return a call (Ed's stated purpose for asking
// the visitor's zip). A fixed lookup on the first three digits of a US zip code:
// no model, nothing sent anywhere. It is a best guess, not a fact: a handful of
// areas sit on a time-zone border, and the lookup picks the zone most of that
// three-digit area is in. The visitor sees the result in the text they approve,
// and the Operator sees it labelled "(from zip)".
//
// Ranges are [first, last, IANA zone] on the three-digit prefix, inclusive. The
// first matching range wins; a null zone means "no zone to give".

const R = [
  // Military and overseas mail (APO/FPO) has no local time zone to give.
  [90, 99, null],
  [340, 340, null],
  [962, 966, null],
  [5, 5, "America/New_York"],        // Holtsville NY (IRS)
  [6, 9, "America/Puerto_Rico"],     // PR, VI
  [10, 199, "America/New_York"],     // New England, NY, NJ, PA, DE
  [200, 299, "America/New_York"],    // DC, MD, VA, WV, NC, SC
  [300, 319, "America/New_York"],    // GA
  [320, 323, "America/New_York"],    // FL (east of the Apalachicola River)
  [324, 325, "America/Chicago"],     // FL panhandle (Panama City, Pensacola)
  [326, 349, "America/New_York"],    // FL
  [350, 369, "America/Chicago"],     // AL
  [370, 372, "America/Chicago"],     // TN (Nashville)
  [373, 379, "America/New_York"],    // TN (Chattanooga, Knoxville, Tri-Cities)
  [380, 385, "America/Chicago"],     // TN (Memphis)
  [386, 397, "America/Chicago"],     // MS
  [398, 399, "America/New_York"],    // GA (Albany)
  [400, 418, "America/New_York"],    // KY (Louisville, Lexington, east)
  [420, 427, "America/Chicago"],     // KY (west)
  [430, 459, "America/New_York"],    // OH
  [460, 462, "America/New_York"],    // IN
  [463, 464, "America/Chicago"],     // IN (Gary area)
  [465, 475, "America/New_York"],    // IN
  [476, 477, "America/Chicago"],     // IN (Evansville)
  [478, 479, "America/New_York"],    // IN
  [480, 497, "America/New_York"],    // MI
  [498, 499, "America/Chicago"],     // MI (Upper Peninsula, Wisconsin border)
  [500, 528, "America/Chicago"],     // IA
  [530, 549, "America/Chicago"],     // WI
  [550, 567, "America/Chicago"],     // MN
  [570, 576, "America/Chicago"],     // SD (east)
  [577, 577, "America/Denver"],      // SD (Rapid City)
  [580, 585, "America/Chicago"],     // ND
  [586, 588, "America/Denver"],      // ND (southwest)
  [590, 599, "America/Denver"],      // MT
  [600, 629, "America/Chicago"],     // IL
  [630, 658, "America/Chicago"],     // MO
  [660, 676, "America/Chicago"],     // KS
  [677, 679, "America/Denver"],      // KS (west)
  [680, 692, "America/Chicago"],     // NE
  [693, 693, "America/Denver"],      // NE (panhandle)
  [700, 714, "America/Chicago"],     // LA
  [716, 729, "America/Chicago"],     // AR
  [730, 749, "America/Chicago"],     // OK
  [750, 797, "America/Chicago"],     // TX
  [798, 799, "America/Denver"],      // TX (El Paso)
  [800, 816, "America/Denver"],      // CO
  [820, 831, "America/Denver"],      // WY
  [832, 834, "America/Denver"],      // ID (south)
  [835, 835, "America/Los_Angeles"], // ID (Lewiston)
  [836, 837, "America/Denver"],      // ID (Boise)
  [838, 838, "America/Los_Angeles"], // ID (Coeur d'Alene)
  [840, 847, "America/Denver"],      // UT
  [850, 865, "America/Phoenix"],     // AZ (no daylight saving)
  [870, 885, "America/Denver"],      // NM, El Paso TX (885)
  [889, 898, "America/Los_Angeles"], // NV
  [900, 961, "America/Los_Angeles"], // CA
  [967, 968, "Pacific/Honolulu"],    // HI
  [970, 978, "America/Los_Angeles"], // OR
  [979, 979, "America/Boise"],       // OR (Malheur County)
  [980, 994, "America/Los_Angeles"], // WA
  [995, 999, "America/Anchorage"],   // AK
];

// Returns an IANA zone name, or null when the zip is not a US zip we can place
// (military addresses, Guam, an unassigned prefix, or anything malformed).
export function timezoneForZip(zip) {
  const m = /^\s*(\d{3})\d{2}(?:-\d{4})?\s*$/.exec(String(zip ?? ""));
  if (!m) return null;
  const prefix = Number(m[1]);
  for (const [lo, hi, tz] of R) if (prefix >= lo && prefix <= hi) return tz;
  return null;
}

const LABELS = {
  "America/New_York": "Eastern time",
  "America/Chicago": "Central time",
  "America/Denver": "Mountain time",
  "America/Boise": "Mountain time",
  "America/Phoenix": "Mountain time, Arizona (no daylight saving)",
  "America/Los_Angeles": "Pacific time",
  "America/Anchorage": "Alaska time",
  "Pacific/Honolulu": "Hawaii time",
  "America/Puerto_Rico": "Atlantic time",
};

// Plain wording for the visitor to read and for the Operator's alert.
export function timezoneLabel(tz) {
  return LABELS[tz] ?? tz ?? "";
}

// The visitor's local time right now, e.g. "6:01 PM". Null if the zone is unknown.
export function localTimeNow(tz, now = new Date()) {
  if (!tz) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(now);
  } catch {
    return null;
  }
}

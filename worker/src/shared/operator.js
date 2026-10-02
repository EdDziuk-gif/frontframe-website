// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: operator contact
// ════════════════════════════════════════════════════════════════════════════
//
// One source for every address that belongs to the Operator (Decision 14,
// 2026-10-01): operator alerts, handoff emails, the DocuSeal countersigner, and
// the contact line shown to visitors all follow the one active Operator row in
// `reviewers`. There is no separate public-contact setting. When the Operator
// role is transferred, everything here follows the new row with no code change.
//
// If the lookup fails (database outage, no active Operator row, more than one,
// or a row without an email), operator ALERTS go to the Worker variable
// OPERATOR_FALLBACK_EMAIL so an outage cannot silence them (Decision 23).
// Visitor-facing text names no address and no name in that case: it never shows
// a stale one. The DocuSeal countersigner never uses the fallback; a contract
// is not countersigned by an address that was not read from the Operator row.
//
// The sender identity (RESEND_FROM) is configuration tied to the verified
// sending domain and is not part of this module.

import { OPERATOR_BASELINE_ROLE } from "../middleware/panels.js";
import { sendResendEmail } from "./runtime.js";
import { supabaseFetch } from "./supabase.js";

function cleanEmail(value) {
  const s = typeof value === "string" ? value.trim() : "";
  return s.includes("@") ? s : null;
}

// Resolves the Operator. Never throws.
//   resolved:    true only when exactly one active Operator row with an email was read
//   email:       that row's email (null when not resolved) - the only address visitors may see
//   displayName: that row's display name (null when not resolved or blank)
//   notifyEmail: where operator alerts go: the row's email, else the fallback variable, else null
export async function getOperator(env) {
  const fallback = cleanEmail(env?.OPERATOR_FALLBACK_EMAIL);
  try {
    const rows = await supabaseFetch(
      env, "reviewers",
      `?select=display_name,email&baseline_role=eq.${OPERATOR_BASELINE_ROLE}&active=eq.true&limit=2`,
    );
    const email = Array.isArray(rows) && rows.length === 1 ? cleanEmail(rows[0]?.email) : null;
    if (email) {
      const name = typeof rows[0].display_name === "string" ? rows[0].display_name.trim() : "";
      return { resolved: true, email, displayName: name || null, notifyEmail: email };
    }
    console.error(`Operator lookup found ${Array.isArray(rows) ? rows.length : "no"} usable active Operator row(s); using the fallback address`);
  } catch (e) {
    console.error("Operator lookup failed; using the fallback address:", e?.message ?? e);
  }
  return { resolved: false, email: null, displayName: null, notifyEmail: fallback };
}

// ── Visitor-facing wording ────────────────────────────────────────────────
// "<Name> will follow up personally<suffix>." or, when the lookup failed,
// "We will follow up personally<suffix>."
export function operatorFollowUp(operator, suffix = "") {
  const who = operator?.resolved && operator.displayName ? operator.displayName : "We";
  return `${who} will follow up personally${suffix}.`;
}

// " You can also email <address> directly." - empty when the lookup failed.
export function operatorReachLine(operator) {
  return operator?.resolved && operator.email ? ` You can also email ${operator.email} directly.` : "";
}

// "<Name>" for use mid-sentence, or the given plain alternative when unresolved.
export function operatorNameOr(operator, alternative) {
  return operator?.resolved && operator.displayName ? operator.displayName : alternative;
}

// ── Notifications ─────────────────────────────────────────────────────────
// Sends an alert email to the Operator (row address, else fallback). When there
// is nowhere to send, logs loudly and reports it rather than throwing, so the
// calling alert path (lead_alerts row, SMS) still completes.
export async function sendOperatorEmail(env, subject, html, operator = null) {
  const op = operator ?? await getOperator(env);
  if (!op.notifyEmail) {
    console.error("Operator alert email not sent: no Operator address and no OPERATOR_FALLBACK_EMAIL");
    return { success: false, status: "no_operator_address" };
  }
  return sendResendEmail(env, op.notifyEmail, subject, html);
}

// ── DocuSeal countersigner ────────────────────────────────────────────────
// The address read from the Operator row. Throws when it could not be read, so
// the caller stops before a contract goes out with a countersigner nobody chose.
export async function getCountersignerEmail(env) {
  const op = await getOperator(env);
  if (!op.resolved) throw new Error("Operator address could not be read; contract not sent");
  return op.email;
}

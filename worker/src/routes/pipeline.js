import { jsonResponse } from "../shared/http.js";
import { supabaseDelete, supabaseFetch, supabasePatch, supabasePatchByField, supabasePost, supabaseRpc, supabaseUpsert, supabaseHeaders } from "../shared/supabase.js";
import { ADMIN_EMAIL, ADMIN_URL, DEFECT_PATTERN, ESCALATION_PATTERN, GAP_SIGNAL, RESEARCH_PATTERN, STRIPE_PRICE_IDS, TESTING_LAYER, buildSystemPrompt, callAnthropic, fetchAndStoreDocument, getPhoenixDateStr, getPhoenixDayOfWeek, hashIp, sendResendEmail, sendSms, verifyStripeSignature } from "../shared/runtime.js";

// § DOMAIN: changelog
// ════════════════════════════════════════════════════════════════════════════

async function getChangelog(env, userJwt, corsHeaders) {
  return jsonResponse(await supabaseFetch(env, "changelog", "?select=*&order=created_at.desc", userJwt), 200, corsHeaders);
}

async function createChangelog(request, env, userJwt, corsHeaders) {
  const { event_type, summary, disposition = "retain", build_version } = await request.json();
  if (!event_type || !summary) return jsonResponse({ error: "event_type and summary are required" }, 400, corsHeaders);
  const cfg = (await supabaseFetch(env, "config", "?id=eq.1&select=build_version"))?.[0] ?? {};
  return jsonResponse(await supabasePost(env, "changelog", {
    event_type, summary, disposition, build_version: build_version || cfg.build_version || "unknown",
  }, userJwt), 201, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: leads
// ════════════════════════════════════════════════════════════════════════════

async function getLeads(env, userJwt, corsHeaders) {
  return jsonResponse(await supabaseFetch(env, "leads",
    "?select=id,name,email,phone,business_name,source,status,created_at&order=created_at.desc", userJwt), 200, corsHeaders);
}

async function createLead(request, env, userJwt, corsHeaders) {
  const { name, email, phone, business_name, notes, source = "pipeline", status = "new" } = await request.json();
  if (!name || !email) return jsonResponse({ error: "name and email are required" }, 400, corsHeaders);
  return jsonResponse(await supabasePost(env, "leads", {
    name, email, phone: phone ?? null, business_name: business_name ?? null,
    notes: notes ?? null, source, status,
  }, userJwt), 201, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: lead-alerts
// ════════════════════════════════════════════════════════════════════════════

async function getLeadAlerts(env, userJwt, corsHeaders) {
  return jsonResponse(await supabaseFetch(env, "lead_alerts",
    "?select=alert_id,lead_id,prospect_name,trigger_reason,page,current_site,sms_sent,sms_status,status,session_id,triggered_at&order=triggered_at.desc",
    userJwt), 200, corsHeaders);
}

async function updateLeadAlert(request, env, id, userJwt, corsHeaders) {
  const body = await request.json();
  const updates = {};
  ["status","prospect_name","trigger_reason","current_site","lead_id"].forEach(k => { if (body[k] !== undefined) updates[k] = body[k]; });
  if (!Object.keys(updates).length) return jsonResponse({ error: "No valid fields to update" }, 400, corsHeaders);
  return jsonResponse(await supabasePatchByField(env, "lead_alerts", "alert_id", id, updates), 200, corsHeaders);
}

async function deleteLeadAlert(env, id, userJwt, corsHeaders) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/lead_alerts?alert_id=eq.${encodeURIComponent(id)}`,
    { method: "DELETE", headers: supabaseHeaders(env) });
  if (!res.ok) throw new Error(`Supabase DELETE lead_alerts failed: ${await res.text()}`);
  return jsonResponse({ deleted: id }, 200, corsHeaders);
}

async function getAlertSession(env, alertId, userJwt, corsHeaders) {
  const alertRows = await supabaseFetch(env, "lead_alerts",
    `?alert_id=eq.${encodeURIComponent(alertId)}&select=session_id,prospect_name`, userJwt);
  if (!alertRows?.length) return jsonResponse({ error: "Alert not found" }, 404, corsHeaders);
  const sessionId = alertRows[0].session_id;
  if (!sessionId) return jsonResponse({ conversation: null, reason: "no_session" }, 200, corsHeaders);
  const sessionRows = await supabaseFetch(env, "chat_sessions",
    `?session_id=eq.${encodeURIComponent(sessionId)}&select=conversation,page,started_at,last_active_at`, userJwt);
  if (!sessionRows?.length) return jsonResponse({ conversation: null, reason: "session_not_found" }, 200, corsHeaders);
  return jsonResponse(sessionRows[0], 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: agreements
// ════════════════════════════════════════════════════════════════════════════

async function getAgreements(env, userJwt, corsHeaders) {
  return jsonResponse(await supabaseFetch(env, "agreements", "?select=*&order=sent_at.desc", userJwt), 200, corsHeaders);
}

async function updateAgreement(request, env, id, userJwt, corsHeaders) {
  const body = await request.json();
  const updates = {};
  ["client_called_at","status","document_url"].forEach(k => { if (body[k] !== undefined) updates[k] = body[k]; });
  if (!Object.keys(updates).length) return jsonResponse({ error: "No valid fields to update" }, 400, corsHeaders);
  return jsonResponse(await supabasePatch(env, "agreements", id, updates, userJwt), 200, corsHeaders);
}

async function sendAgreement(request, env, userJwt, corsHeaders) {
  const { order_id } = await request.json();
  if (!order_id) return jsonResponse({ error: "order_id is required" }, 400, corsHeaders);
  const orderRows = await supabaseFetch(env, "orders", `?id=eq.${order_id}&select=id,tier,lead_id`);
  if (!orderRows?.length) return jsonResponse({ error: "Order not found" }, 404, corsHeaders);
  const order    = orderRows[0];
  const leadRows = await supabaseFetch(env, "leads", `?id=eq.${order.lead_id}&select=name,email,business_name`);
  const lead     = leadRows?.[0] ?? {};
  const today    = new Date().toISOString().split("T")[0];
  const signatureUrl = env.DOCUSEAL_SIGNATURE_URL ?? "";
  const submissionPayload = {
    template_id: 3600228, send_email: true,
    submitters: [
      { role: "First Party", email: lead.email ?? "",
        fields: [
          { name: "Client Name",          default_value: lead.name          ?? "", readonly: true },
          { name: "Business Name",        default_value: lead.business_name ?? "", readonly: true },
          { name: "Client Email Address", default_value: lead.email         ?? "", readonly: true },
          { name: "Date Field 1",         default_value: today,                   readonly: true },
        ] },
      { role: "Second Party", email: "ed@frontframe.co", completed: true,
        fields: [
          { name: "FrontFrame Date",      default_value: today,        readonly: true },
          { name: "FrontFrame Signature", default_value: signatureUrl, readonly: true },
        ] },
    ],
  };
  const dsRes = await fetch("https://api.docuseal.com/submissions", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Auth-Token": env.DOCUSEAL_API_KEY },
    body: JSON.stringify(submissionPayload),
  });
  if (!dsRes.ok) throw new Error(`DocuSeal submission failed: ${await dsRes.text()}`);
  const dsData     = await dsRes.json();
  const envelopeId = String(dsData?.[0]?.submission_id ?? dsData?.id ?? "");
  const agreement  = await supabasePost(env, "agreements", { order_id, docuseal_envelope_id: envelopeId, status: "sent", sent_at: new Date().toISOString() });
  return jsonResponse({ sent: true, envelope_id: envelopeId, agreement }, 201, corsHeaders);
}

async function sendDueDiligence(request, env, userJwt, corsHeaders) {
  const { lead_id } = await request.json();
  if (!lead_id) return jsonResponse({ error: "lead_id is required" }, 400, corsHeaders);
  const leadRows = await supabaseFetch(env, "leads", `?id=eq.${lead_id}&select=id,name,email,business_name`);
  if (!leadRows?.length) return jsonResponse({ error: "Lead not found" }, 404, corsHeaders);
  const lead         = leadRows[0];
  const today        = new Date().toISOString().split("T")[0];
  const signatureUrl = env.DOCUSEAL_SIGNATURE_URL ?? "";
  const submissionPayload = {
    template_id: 3703869, send_email: true,
    submitters: [
      { role: "Second Party", email: lead.email ?? "",
        fields: [
          { name: "Client_Name",   default_value: lead.name          ?? "", readonly: true },
          { name: "Business_Name", default_value: lead.business_name ?? "", readonly: true },
          { name: "Client_email",  default_value: lead.email         ?? "", readonly: true },
          { name: "Contract_date", default_value: today,                   readonly: true },
        ] },
      { role: "FrontFrame", email: "ed@frontframe.co", completed: true,
        fields: [{ name: "FrontFrame_Signature", default_value: signatureUrl, readonly: true }] },
    ],
  };
  const dsRes = await fetch("https://api.docuseal.com/submissions", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Auth-Token": env.DOCUSEAL_API_KEY },
    body: JSON.stringify(submissionPayload),
  });
  if (!dsRes.ok) throw new Error(`DocuSeal submission failed: ${await dsRes.text()}`);
  const dsData     = await dsRes.json();
  const envelopeId = String(dsData?.[0]?.submission_id ?? dsData?.id ?? "");
  const agreement  = await supabasePost(env, "agreements", { lead_id, docuseal_envelope_id: envelopeId, status: "sent", sent_at: new Date().toISOString() });
  return jsonResponse({ sent: true, envelope_id: envelopeId, agreement }, 201, corsHeaders);
}


async function sendInfraAgreement(request, env, userJwt, corsHeaders) {
  const { lead_id } = await request.json();
  if (!lead_id) return jsonResponse({ error: "lead_id is required" }, 400, corsHeaders);
  const leadRows = await supabaseFetch(env, "leads", `?id=eq.${lead_id}&select=id,name,email,business_name`);
  if (!leadRows?.length) return jsonResponse({ error: "Lead not found" }, 404, corsHeaders);
  const lead         = leadRows[0];
  const today        = new Date().toISOString().split("T")[0];
  const signatureUrl = env.DOCUSEAL_SIGNATURE_URL ?? "";
  const submissionPayload = {
    template_id: 5966406, send_email: true,
    submitters: [
      { role: "Second Party", email: lead.email ?? "",
        fields: [
          { name: "Client_Name",   default_value: lead.name          ?? "", readonly: true },
          { name: "Business_Name", default_value: lead.business_name ?? "", readonly: true },
          { name: "Client_email",  default_value: lead.email         ?? "", readonly: true },
          { name: "Contract_date", default_value: today,                   readonly: true },
        ] },
      { role: "FrontFrame", email: "ed@frontframe.co", completed: true,
        fields: [{ name: "FrontFrame_Signature", default_value: signatureUrl, readonly: true }] },
    ],
  };
  const dsRes = await fetch("https://api.docuseal.com/submissions", {
    method: "POST", headers: { "Content-Type": "application/json", "X-Auth-Token": env.DOCUSEAL_API_KEY },
    body: JSON.stringify(submissionPayload),
  });
  if (!dsRes.ok) throw new Error(`DocuSeal submission failed: ${await dsRes.text()}`);
  const dsData     = await dsRes.json();
  const envelopeId = String(dsData?.[0]?.submission_id ?? dsData?.id ?? "");
  const agreement  = await supabasePost(env, "agreements", {
    lead_id,
    docuseal_envelope_id: envelopeId,
    status:         "sent",
    agreement_type: "infrastructure",
    sent_at:        new Date().toISOString(),
  });
  return jsonResponse({ sent: true, envelope_id: envelopeId, agreement }, 201, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: system-prompt
// ════════════════════════════════════════════════════════════════════════════

async function getSystemPrompt(env, page, userJwt, corsHeaders) {
  const validPages = ["all","home","intake","discovery","yours","admin","proposal","resources"];
  if (!validPages.includes(page))
    return jsonResponse({ error: `Invalid page. Must be one of: ${validPages.join(", ")}` }, 400, corsHeaders);
  const rows = await supabaseFetch(env, "system_prompt", `?page=eq.${encodeURIComponent(page)}&select=page,content`, userJwt);
  if (!rows?.length) return jsonResponse({ page, content: null }, 200, corsHeaders);
  return jsonResponse(rows[0], 200, corsHeaders);
}

// updateSystemPrompt removed by migration 014 (KGR corpus-write governance):
// system_prompt is written ONLY by sign_off_kgr_resolution, as a
// resolution_target='system_prompt' outcome. getSystemPrompt stays as a
// read-only viewer for the admin panel.


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: reviewers
// ════════════════════════════════════════════════════════════════════════════
//
// Reviewer-authority buildout (2026-09-23). baseline_role is the source of
// truth for tier (frontframe_operator / delegate / staff / client_tester);
// role is the legacy column, kept in sync alongside it because is_reviewer(),
// requireReviewer() (middleware/auth.js), getReviewerAuthority()
// (routes/constitution.js), and CASE_MANAGEMENT_ONLY_ROLES (routes/kgr.js)
// all read role directly and are out of scope for this change.
//
// Authorization settled for this buildout (see project record
// "FrontFrame Reviewer Authority — Progress Report", §7-8):
//   - Only the Operator may create a new Delegate, or promote an existing
//     Staff reviewer to Delegate. No Delegate-initiated tier change exists,
//     of any kind, ever.
//   - The Operator or an active Delegate may invite a new Staff or Client
//     Tester reviewer.
//   - The Operator may deactivate/reactivate any reviewer. A Delegate may
//     deactivate/reactivate only Staff and Client Tester reviewers, never a
//     Delegate or the Operator.
//   - Reactivation clears deactivated_at/deactivated_by back to NULL - no
//     inactivity-period history is kept (decided explicitly; this does not
//     affect the separately-preserved grant/permission attribution history).
//   - can_sign_off_kgr is never set by invite or promotion; it defaults to
//     false for every new or promoted reviewer and is granted/revoked as its
//     own, independent action (not built here).

const INVITABLE_BASELINE_ROLES = ["delegate", "staff", "client_tester"];
const BASELINE_ROLE_TO_LEGACY_ROLE = {
  delegate: "frontframe_delegate",
  staff: "frontframe_staff",
  client_tester: "client_tester",
};
const DELEGATE_MANAGEABLE_TIERS = ["staff", "client_tester"];

// Resolves the acting reviewer (the one holding userJwt) to their own
// reviewer row, for the per-action authorization checks below. Mirrors
// middleware/auth.js's requireReviewer() and constitution.js's
// getReviewerAuthority(), each of which independently re-derives the same
// identity for its own domain's checks - this file follows that existing
// per-domain-helper convention rather than introducing a new shared one.
async function getActingReviewer(env, userJwt) {
  if (!userJwt) return null;
  const userRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { "apikey": env.SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${userJwt}` },
  });
  if (!userRes.ok) return null;
  const user = await userRes.json();
  const email = user?.email;
  if (!email) return null;
  const rows = await supabaseFetch(env, "reviewers",
    `?select=id,email,role,baseline_role,active&email=eq.${encodeURIComponent(email)}`);
  const reviewer = rows?.[0];
  if (!reviewer?.active) return null;
  return reviewer;
}

async function getReviewers(env, userJwt, corsHeaders) {
  return jsonResponse(await supabaseFetch(env, "reviewers",
    "?select=id,email,display_name,role,baseline_role,engagement_id,invited_at,active,dev_access,can_sign_off_kgr,deactivated_at,deactivated_by&order=invited_at.asc", userJwt), 200, corsHeaders);
}

async function inviteReviewer(request, env, userJwt, corsHeaders) {
  const acting = await getActingReviewer(env, userJwt);
  if (!acting) return jsonResponse({ error: "Not an active reviewer" }, 403, corsHeaders);

  const { email, display_name, baseline_role, engagement_id } = await request.json();
  if (!email || !display_name || !baseline_role)
    return jsonResponse({ error: "email, display_name, and baseline_role are required" }, 400, corsHeaders);
  if (!INVITABLE_BASELINE_ROLES.includes(baseline_role))
    return jsonResponse({ error: `baseline_role must be one of: ${INVITABLE_BASELINE_ROLES.join(", ")}` }, 400, corsHeaders);

  // Only the Operator may create a new Delegate.
  if (baseline_role === "delegate" && acting.baseline_role !== "frontframe_operator")
    return jsonResponse({ error: "Only the Operator may invite a Delegate" }, 403, corsHeaders);
  // Staff/Client Tester invites: Operator or an active Delegate.
  if (baseline_role !== "delegate" && !["frontframe_operator", "delegate"].includes(acting.baseline_role))
    return jsonResponse({ error: "Only the Operator or a Delegate may invite a reviewer" }, 403, corsHeaders);

  const role = BASELINE_ROLE_TO_LEGACY_ROLE[baseline_role];

  const inviteRes = await fetch(`${env.SUPABASE_URL}/auth/v1/invite`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": env.SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ email }),
  });
  if (!inviteRes.ok) throw new Error(`Supabase invite failed: ${await inviteRes.text()}`);
  const inviteData = await inviteRes.json();
  if (!inviteData.id) return jsonResponse({ error: "Invite sent but no user ID returned" }, 500, corsHeaders);
  const reviewer = await supabasePost(env, "reviewers", {
    id: inviteData.id, email, display_name, role, baseline_role, engagement_id: engagement_id ?? null,
  });
  return jsonResponse({ invited: email, reviewer }, 201, corsHeaders);
}

async function resetReviewerPassword(request, env, userJwt, corsHeaders) {
  const { email } = await request.json();
  if (!email) return jsonResponse({ error: "email is required" }, 400, corsHeaders);
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/recover`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": env.SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) throw new Error(`Password reset failed: ${await res.text()}`);
  return jsonResponse({ sent: true }, 200, corsHeaders);
}

// Extended PATCH, replacing the stood-down DELETE /admin/reviewers/:id.
// Handles ordinary field edits, deactivation/reactivation (the `active`
// flag), and the single authorized tier-change (Staff -> Delegate,
// Operator-only) - see the DOMAIN header above for the settled authorization
// rules this enforces.
async function updateReviewer(request, env, id, userJwt, corsHeaders) {
  const acting = await getActingReviewer(env, userJwt);
  if (!acting) return jsonResponse({ error: "Not an active reviewer" }, 403, corsHeaders);

  const targetRows = await supabaseFetch(env, "reviewers", `?id=eq.${encodeURIComponent(id)}&select=id,baseline_role,active`);
  const target = targetRows?.[0];
  if (!target) return jsonResponse({ error: "Reviewer not found" }, 404, corsHeaders);

  const actingIsOperator = acting.baseline_role === "frontframe_operator";
  const actingIsDelegate = acting.baseline_role === "delegate";
  const actingManagesTarget = actingIsOperator || (actingIsDelegate && DELEGATE_MANAGEABLE_TIERS.includes(target.baseline_role));
  if (!actingManagesTarget)
    return jsonResponse({ error: "Not authorized to manage this reviewer" }, 403, corsHeaders);

  const body = await request.json();
  const updates = {};
  ["display_name","email","dev_access"].forEach(k => { if (body[k] !== undefined) updates[k] = body[k]; });

  // Deactivation / reactivation - same authority as above, running in
  // reverse for reactivation. No inactivity-period history is kept.
  if (body.active !== undefined) {
    if (typeof body.active !== "boolean")
      return jsonResponse({ error: "active must be a boolean" }, 400, corsHeaders);
    updates.active = body.active;
    if (body.active === false) {
      updates.deactivated_at = new Date().toISOString();
      updates.deactivated_by = acting.id;
    } else {
      updates.deactivated_at = null;
      updates.deactivated_by = null;
    }
  }

  // Tier change - Operator-only, and only the single authorized promotion
  // path (an existing Staff reviewer becoming a Delegate). No other tier
  // change is authorized at any level.
  if (body.baseline_role !== undefined) {
    if (!actingIsOperator)
      return jsonResponse({ error: "Only the Operator may change a reviewer's tier" }, 403, corsHeaders);
    if (body.baseline_role !== "delegate" || target.baseline_role !== "staff")
      return jsonResponse({ error: "Only a Staff reviewer may be promoted, and only to Delegate" }, 400, corsHeaders);
    updates.baseline_role = "delegate";
    updates.role = "frontframe_delegate";
  }

  if (!Object.keys(updates).length) return jsonResponse({ error: "No valid fields to update" }, 400, corsHeaders);
  return jsonResponse(await supabasePatch(env, "reviewers", id, updates, userJwt), 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════

export { getChangelog, createChangelog, getLeads, createLead, getLeadAlerts, updateLeadAlert, deleteLeadAlert, getAlertSession, getAgreements, updateAgreement, sendAgreement, sendDueDiligence, sendInfraAgreement, getSystemPrompt, getReviewers, inviteReviewer, resetReviewerPassword, updateReviewer };

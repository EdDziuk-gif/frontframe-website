import { jsonResponse } from "../shared/http.js";
import { TIER_DEFAULT_PANELS, grantedPanelKeys, panelIdsForKeys } from "../middleware/panels.js";
import { supabaseDelete, supabaseFetch, supabasePatch, supabasePatchByField, supabasePost, supabaseRpc, supabaseUpsert, supabaseHeaders } from "../shared/supabase.js";
import { getCountersignerEmail } from "../shared/operator.js";
import { ADMIN_URL, DEFECT_PATTERN, ESCALATION_PATTERN, GAP_SIGNAL, RESEARCH_PATTERN, STRIPE_PRICE_IDS, TESTING_LAYER, buildSystemPrompt, callAnthropic, fetchAndStoreDocument, getPhoenixDateStr, getPhoenixDayOfWeek, hashIp, sendResendEmail, sendSms, verifyStripeSignature } from "../shared/runtime.js";

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

// The conversation behind an alert, for a reviewer who deals with handoffs
// (Pipeline panel). A handoff's conversation is stored on the alert itself
// (Decision 15) and is cleared by the database when the alert is closed
// (Decision 20). An alert with no stored transcript falls back to the chat still
// being held for its session, if any (held chats are discarded after a few hours).
async function getAlertSession(env, alertId, userJwt, corsHeaders) {
  const alertRows = await supabaseFetch(env, "lead_alerts",
    `?alert_id=eq.${encodeURIComponent(alertId)}&select=session_id,prospect_name,status,transcript`, userJwt);
  if (!alertRows?.length) return jsonResponse({ error: "Alert not found" }, 404, corsHeaders);
  const alert = alertRows[0];
  if (Array.isArray(alert.transcript) && alert.transcript.length)
    return jsonResponse({ conversation: alert.transcript, source: "handoff" }, 200, corsHeaders);
  if (alert.status === "closed")
    return jsonResponse({ conversation: null, reason: "closed" }, 200, corsHeaders);
  const sessionId = alert.session_id;
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
  // The countersigner follows the active Operator row; no fallback address.
  const countersignerEmail = await getCountersignerEmail(env);
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
      { role: "Second Party", email: countersignerEmail, completed: true,
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
  // The countersigner follows the active Operator row; no fallback address.
  const countersignerEmail = await getCountersignerEmail(env);
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
      { role: "FrontFrame", email: countersignerEmail, completed: true,
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
  // The countersigner follows the active Operator row; no fallback address.
  const countersignerEmail = await getCountersignerEmail(env);
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
      { role: "FrontFrame", email: countersignerEmail, completed: true,
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

// GET /admin/me - the caller's own reviewer row plus their granted panel
// keys. This exists because both admin panels used to boot by fetching the
// FULL reviewer list and finding themselves in it, which meant every reviewer
// needed read access to every reviewer's email and flags just to log in. With
// panel scoping that was untenable: Staff do not hold the Reviewers panel, so
// gating /admin/reviewers would have locked them out at boot. This route is
// always reachable by an active reviewer (see ALWAYS_ALLOWED_PATHS in
// middleware/panels.js) and returns only the caller's own record.
async function getMe(env, userJwt, corsHeaders) {
  const acting = await getActingReviewer(env, userJwt);
  if (!acting) return jsonResponse({ error: "Not an active reviewer" }, 403, corsHeaders);
  const rows = await supabaseFetch(env, "reviewers",
    `?id=eq.${encodeURIComponent(acting.id)}&select=id,email,display_name,role,baseline_role,active,dev_access,can_sign_off_kgr,can_amend_constitution,can_grant_constitution_amendment,engagement_id`);
  const me = rows?.[0];
  if (!me) return jsonResponse({ error: "Reviewer not found" }, 404, corsHeaders);
  const panels = me.baseline_role === "frontframe_operator"
    ? "*"                                    // Operator holds every panel implicitly
    : [...await grantedPanelKeys(env, me.id)];
  return jsonResponse({ ...me, panels }, 200, corsHeaders);
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

  // Tier defaults (middleware/panels.js). Tier acts as a template here, not as
  // a standing authority: these rows become the reviewer's access, and the
  // Operator edits them per person afterward from the Reviewers tab. A failure
  // to write them must not fail an invite that already created an Auth user -
  // the reviewer simply starts with no panels, which is the safe direction.
  let granted = 0;
  try {
    const panelIds = await panelIdsForKeys(env, TIER_DEFAULT_PANELS[baseline_role] ?? []);
    if (panelIds.length) {
      await supabasePost(env, "reviewer_permissions", panelIds.map(pid => ({
        reviewer_id: inviteData.id, admin_panel_id: pid, granted_by: acting.id,
      })));
      granted = panelIds.length;
    }
  } catch (e) {
    console.error("tier default grants failed for", email, e);
  }

  return jsonResponse({ invited: email, reviewer, panels_granted: granted }, 201, corsHeaders);
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


// § Panel-scoped reviewer permissions (2026-09-27)
// ────────────────────────────────────────────────────────────────────────────
// admin_panels holds one row per TAB per panel file - admin.html (the
// Operator/Delegate/Staff surface) and dev-admin.html ("Dev Tools", the Client
// Tester surface) - keyed by (panel_file, key) where key matches the tab's
// data-tab attribute. reviewer_permissions grants a reviewer a specific tab.
//
// These endpoints record grants and revocations only. They do NOT yet gate
// anything: tab visibility and route access still follow the tier rules in the
// DOMAIN header above. Wiring enforcement requires deciding what an ABSENCE of
// rows means for a Staff/Client Tester reviewer (deny-by-default, which locks
// out every reviewer until granted, vs. restrict-only-when-rows-exist), which
// is an open decision for the Operator and is deliberately not assumed here.
//
// reviewer_permissions is PK (reviewer_id, admin_panel_id), so one row per
// pair for all time: a revoke sets revoked_at, and a re-grant clears it and
// refreshes granted_by/granted_at. The table therefore carries current state
// plus last-grant attribution, not a full grant/revoke audit trail.

async function getAdminPanels(env, userJwt, corsHeaders) {
  return jsonResponse(await supabaseFetch(env, "admin_panels",
    "?select=id,panel_file,key,label,active&active=is.true&order=panel_file.asc,label.asc", userJwt), 200, corsHeaders);
}

async function getReviewerPermissions(env, id, userJwt, corsHeaders) {
  const acting = await getActingReviewer(env, userJwt);
  if (!acting) return jsonResponse({ error: "Not an active reviewer" }, 403, corsHeaders);
  return jsonResponse(await supabaseFetch(env, "reviewer_permissions",
    `?reviewer_id=eq.${encodeURIComponent(id)}&select=reviewer_id,admin_panel_id,granted_by,granted_at,revoked_at,admin_panels(panel_file,key,label)&order=granted_at.asc`,
    userJwt), 200, corsHeaders);
}

// PUT: reconciles the reviewer's granted tabs to exactly admin_panel_ids.
// A checkbox grid saves in one call; anything currently granted and absent
// from the list is revoked, anything present and not granted is granted.
async function setReviewerPermissions(request, env, id, userJwt, corsHeaders) {
  const acting = await getActingReviewer(env, userJwt);
  if (!acting) return jsonResponse({ error: "Not an active reviewer" }, 403, corsHeaders);

  const targetRows = await supabaseFetch(env, "reviewers", `?id=eq.${encodeURIComponent(id)}&select=id,baseline_role,active`);
  const target = targetRows?.[0];
  if (!target) return jsonResponse({ error: "Reviewer not found" }, 404, corsHeaders);

  // Same authority as updateReviewer: Operator over anyone, Delegate over
  // Staff and Client Tester only. Plus: nobody edits their own permissions,
  // so a Delegate cannot widen their own access.
  const actingIsOperator = acting.baseline_role === "frontframe_operator";
  const actingIsDelegate = acting.baseline_role === "delegate";
  if (acting.id === target.id)
    return jsonResponse({ error: "A reviewer may not change their own panel permissions" }, 403, corsHeaders);
  if (!(actingIsOperator || (actingIsDelegate && DELEGATE_MANAGEABLE_TIERS.includes(target.baseline_role))))
    return jsonResponse({ error: "Not authorized to manage this reviewer" }, 403, corsHeaders);

  const body = await request.json();
  const requested = body?.admin_panel_ids;
  if (!Array.isArray(requested) || requested.some(v => typeof v !== "string"))
    return jsonResponse({ error: "admin_panel_ids must be an array of admin_panels.id values" }, 400, corsHeaders);
  const desired = [...new Set(requested)];

  // Every requested panel must exist and be active - a stale or bogus id
  // would otherwise fail at the FK with an opaque 500.
  const panels = await supabaseFetch(env, "admin_panels", "?select=id&active=is.true");
  const validIds = new Set((panels ?? []).map(p => p.id));
  const unknown = desired.filter(pid => !validIds.has(pid));
  if (unknown.length)
    return jsonResponse({ error: `Unknown or inactive admin_panels id(s): ${unknown.join(", ")}` }, 400, corsHeaders);

  const existing = await supabaseFetch(env, "reviewer_permissions",
    `?reviewer_id=eq.${encodeURIComponent(id)}&select=admin_panel_id,revoked_at`);
  const currentlyGranted = new Set((existing ?? []).filter(r => r.revoked_at === null).map(r => r.admin_panel_id));

  const now = new Date().toISOString();
  const toGrant = desired.filter(pid => !currentlyGranted.has(pid));
  const toRevoke = [...currentlyGranted].filter(pid => !desired.includes(pid));

  if (toGrant.length) {
    await supabaseUpsert(env, "reviewer_permissions", toGrant.map(pid => ({
      reviewer_id: id, admin_panel_id: pid, granted_by: acting.id, granted_at: now, revoked_at: null,
    })), userJwt);
  }

  if (toRevoke.length) {
    // Two-field filter, which supabasePatch/supabasePatchByField do not cover.
    const filter = `?reviewer_id=eq.${encodeURIComponent(id)}` +
      `&admin_panel_id=in.(${toRevoke.map(encodeURIComponent).join(",")})`;
    const res = await fetch(`${env.SUPABASE_URL}/rest/v1/reviewer_permissions${filter}`, {
      method: "PATCH", headers: supabaseHeaders(env), body: JSON.stringify({ revoked_at: now }),
    });
    if (!res.ok) throw new Error(`Supabase PATCH reviewer_permissions failed: ${await res.text()}`);
  }

  const updated = await supabaseFetch(env, "reviewer_permissions",
    `?reviewer_id=eq.${encodeURIComponent(id)}&select=admin_panel_id,granted_by,granted_at,revoked_at`, userJwt);
  return jsonResponse({ granted: toGrant.length, revoked: toRevoke.length, permissions: updated }, 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════

export { getMe, getChangelog, createChangelog, getLeads, createLead, getLeadAlerts, updateLeadAlert, deleteLeadAlert, getAlertSession, getAgreements, updateAgreement, sendAgreement, sendDueDiligence, sendInfraAgreement, getSystemPrompt, getReviewers, inviteReviewer, resetReviewerPassword, updateReviewer, getAdminPanels, getReviewerPermissions, setReviewerPermissions };

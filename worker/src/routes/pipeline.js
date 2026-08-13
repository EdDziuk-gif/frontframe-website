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


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: system-prompt
// ════════════════════════════════════════════════════════════════════════════

async function getSystemPrompt(env, page, userJwt, corsHeaders) {
  const validPages = ["home","intake","discovery","yours","admin","proposal","resources"];
  if (!validPages.includes(page))
    return jsonResponse({ error: `Invalid page. Must be one of: ${validPages.join(", ")}` }, 400, corsHeaders);
  const rows = await supabaseFetch(env, "system_prompt", `?page=eq.${encodeURIComponent(page)}&select=page,content`, userJwt);
  if (!rows?.length) return jsonResponse({ page, content: null }, 200, corsHeaders);
  return jsonResponse(rows[0], 200, corsHeaders);
}

async function updateSystemPrompt(request, env, page, userJwt, corsHeaders) {
  const validPages = ["home","intake","discovery","yours","admin","proposal","resources"];
  if (!validPages.includes(page))
    return jsonResponse({ error: `Invalid page. Must be one of: ${validPages.join(", ")}` }, 400, corsHeaders);
  const { content } = await request.json();
  if (!content) return jsonResponse({ error: "content is required" }, 400, corsHeaders);
  return jsonResponse(await supabaseUpsert(env, "system_prompt", { page, content, updated_at: new Date().toISOString() }, userJwt), 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: reviewers
// ════════════════════════════════════════════════════════════════════════════

async function getReviewers(env, userJwt, corsHeaders) {
  return jsonResponse(await supabaseFetch(env, "reviewers",
    "?select=id,email,display_name,role,engagement_id,invited_at,active,dev_access&order=invited_at.asc", userJwt), 200, corsHeaders);
}

async function inviteReviewer(request, env, userJwt, corsHeaders) {
  const { email, display_name, role, engagement_id } = await request.json();
  if (!email || !display_name || !role)
    return jsonResponse({ error: "email, display_name, and role are required" }, 400, corsHeaders);
  const validRoles = ["frontframe_admin","frontframe_staff","contractor","client_tester","client_owner"];
  if (!validRoles.includes(role))
    return jsonResponse({ error: `role must be one of: ${validRoles.join(", ")}` }, 400, corsHeaders);
  const inviteRes = await fetch(`${env.SUPABASE_URL}/auth/v1/invite`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": env.SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ email }),
  });
  if (!inviteRes.ok) throw new Error(`Supabase invite failed: ${await inviteRes.text()}`);
  const inviteData = await inviteRes.json();
  if (!inviteData.id) return jsonResponse({ error: "Invite sent but no user ID returned" }, 500, corsHeaders);
  const reviewer = await supabasePost(env, "reviewers", { id: inviteData.id, email, display_name, role, engagement_id: engagement_id ?? null });
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

async function updateReviewer(request, env, id, userJwt, corsHeaders) {
  const body = await request.json();
  const updates = {};
  ["display_name","email","dev_access"].forEach(k => { if (body[k] !== undefined) updates[k] = body[k]; });
  if (!Object.keys(updates).length) return jsonResponse({ error: "No valid fields to update" }, 400, corsHeaders);
  return jsonResponse(await supabasePatch(env, "reviewers", id, updates, userJwt), 200, corsHeaders);
}

async function deleteReviewer(env, id, userJwt, corsHeaders) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/reviewers?id=eq.${encodeURIComponent(id)}`,
    { method: "DELETE", headers: supabaseHeaders(env) });
  if (!res.ok) throw new Error(`Supabase DELETE reviewers failed: ${await res.text()}`);
  return jsonResponse({ deleted: id }, 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════

export { getChangelog, createChangelog, getLeads, createLead, getLeadAlerts, updateLeadAlert, deleteLeadAlert, getAlertSession, getAgreements, updateAgreement, sendAgreement, sendDueDiligence, getSystemPrompt, updateSystemPrompt, getReviewers, inviteReviewer, resetReviewerPassword, updateReviewer, deleteReviewer };

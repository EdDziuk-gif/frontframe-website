import { jsonResponse } from "../shared/http.js";
import { supabaseDelete, supabaseFetch, supabasePatch, supabasePatchByField, supabasePost, supabaseRpc, supabaseUpsert, supabaseHeaders } from "../shared/supabase.js";
import { ADMIN_EMAIL } from "../shared/runtime.js";

// § DOMAIN: outreach
// ════════════════════════════════════════════════════════════════════════════

const OUTREACH_MUTABLE_FIELDS = [
  "status", "research_notes", "prototype_subdomain",
  "contract_status", "contract_sent_at", "contract_expires_at",
  "ddl_payment_sent_at", "ddl_payment_paid_at",
];

async function getOutreachProspects(env, userJwt, corsHeaders) {
  const rows = await supabaseFetch(env, "inquiries",
    "?source=eq.cold_outreach&select=id,owner_name,business_name,email,phone,status,research_notes,prototype_subdomain,contract_status,contract_sent_at,contract_expires_at,ddl_payment_sent_at,ddl_payment_paid_at,created_at&order=created_at.desc",
    userJwt);
  return jsonResponse(rows ?? [], 200, corsHeaders);
}

async function createOutreachProspect(request, env, userJwt, corsHeaders) {
  const { owner_name, business_name, email, phone, prototype_subdomain, research_notes, source_page = "outreach" } = await request.json();
  if (!owner_name || !business_name || !email)
    return jsonResponse({ error: "owner_name, business_name, and email are required" }, 400, corsHeaders);
  const row = await supabasePost(env, "inquiries", {
    owner_name, business_name, email,
    phone:               phone               ?? null,
    prototype_subdomain: prototype_subdomain ?? null,
    research_notes:      research_notes      ?? null,
    source:              "cold_outreach",
    status:              "identified",
    source_page,
    contract_status:     "not_sent",
  }, userJwt);
  return jsonResponse(row, 201, corsHeaders);
}

async function updateOutreachProspect(request, env, id, userJwt, corsHeaders) {
  const body = await request.json();
  const updates = {};
  OUTREACH_MUTABLE_FIELDS.forEach(k => { if (k in body) updates[k] = body[k]; });
  if (!Object.keys(updates).length)
    return jsonResponse({ error: "No valid fields to update" }, 400, corsHeaders);
  return jsonResponse(await supabasePatch(env, "inquiries", id, updates, userJwt), 200, corsHeaders);
}

async function sendOutreachContract(request, env, id, userJwt, corsHeaders) {
  const rows = await supabaseFetch(env, "inquiries",
    `?id=eq.${encodeURIComponent(id)}&source=eq.cold_outreach&select=id,owner_name,business_name,email,contract_status`,
    userJwt);
  if (!rows?.length) return jsonResponse({ error: "Prospect not found" }, 404, corsHeaders);
  const p = rows[0];
  if (!p.email) return jsonResponse({ error: "Prospect has no email address" }, 400, corsHeaders);

  const today        = new Date().toISOString().split("T")[0];
  const signatureUrl = env.DOCUSEAL_SIGNATURE_URL ?? "";

  const submissionPayload = {
    template_id: 3703869,
    send_email:  true,
    submitters: [
      { role: "Second Party", email: p.email,
        fields: [
          { name: "Client_Name",   default_value: p.owner_name    ?? "", readonly: true },
          { name: "Business_Name", default_value: p.business_name ?? "", readonly: true },
          { name: "Client_email",  default_value: p.email         ?? "", readonly: true },
          { name: "Contract_date", default_value: today,                 readonly: true },
        ] },
      { role: "FrontFrame", email: ADMIN_EMAIL, completed: true,
        fields: [{ name: "FrontFrame_Signature", default_value: signatureUrl, readonly: true }] },
    ],
  };

  const dsRes = await fetch("https://api.docuseal.com/submissions", {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Auth-Token": env.DOCUSEAL_API_KEY },
    body: JSON.stringify(submissionPayload),
  });
  if (!dsRes.ok) throw new Error(`DocuSeal submission failed: ${await dsRes.text()}`);

  const dsData     = await dsRes.json();
  const envelopeId = String(dsData?.[0]?.submission_id ?? dsData?.id ?? "");

  const sentAt    = new Date();
  const expiresAt = new Date(sentAt.getTime() + 14 * 24 * 60 * 60 * 1000); // 14-day hard close

  await supabasePatch(env, "inquiries", id, {
    contract_status:     "sent",
    contract_sent_at:    sentAt.toISOString(),
    contract_expires_at: expiresAt.toISOString(),
  }, userJwt);

  return jsonResponse({ sent: true, envelope_id: envelopeId, expires_at: expiresAt.toISOString() }, 200, corsHeaders);
}

async function getOutreachTouches(env, inquiryId, userJwt, corsHeaders) {
  const rows = await supabaseFetch(env, "communications",
    `?inquiry_id=eq.${encodeURIComponent(inquiryId)}&select=*&order=touch_date.desc,created_at.desc`,
    userJwt);
  return jsonResponse(rows ?? [], 200, corsHeaders);
}

async function createOutreachTouch(request, env, inquiryId, userJwt, corsHeaders) {
  const { touch_date, method, outcome, next_action } = await request.json();
  if (!touch_date || !outcome)
    return jsonResponse({ error: "touch_date and outcome are required" }, 400, corsHeaders);
  const VALID_METHODS = ["call", "email", "sms", "visit"];
  if (method && !VALID_METHODS.includes(method))
    return jsonResponse({ error: `method must be one of: ${VALID_METHODS.join(", ")}` }, 400, corsHeaders);
  const row = await supabasePost(env, "communications", {
    inquiry_id:  Number(inquiryId),
    touch_date,
    method:      method      ?? "call",
    outcome,
    next_action: next_action ?? null,
  }, userJwt);
  return jsonResponse(row, 201, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: review-queue
// ════════════════════════════════════════════════════════════════════════════

async function getReviewQueue(request, env, userJwt, corsHeaders) {
  if (!userJwt) return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
  const status = new URL(request.url).searchParams.get("status");
  let query = "?select=*&order=created_at.desc";
  if (status && status !== "all") query += `&status=eq.${encodeURIComponent(status)}`;
  return jsonResponse(await supabaseFetch(env, "review_queue", query, userJwt), 200, corsHeaders);
}

async function updateReviewQueue(request, env, id, userJwt, corsHeaders) {
  const body = await request.json();
  const updates = {};
  ["status","notes"].forEach(k => { if (body[k] !== undefined) updates[k] = body[k]; });
  if (updates.status === "reviewed" || updates.status === "dismissed")
    updates.reviewed_at = new Date().toISOString();
  if (!Object.keys(updates).length) return jsonResponse({ error: "No valid fields to update" }, 400, corsHeaders);
  return jsonResponse(await supabasePatch(env, "review_queue", id, updates, userJwt), 200, corsHeaders);
}

async function deleteReviewQueue(env, id, userJwt, corsHeaders) {
  await supabaseDelete(env, "review_queue", id, userJwt);
  return jsonResponse({ deleted: id }, 200, corsHeaders);
}

async function bulkDeleteReviewQueue(request, env, userJwt, corsHeaders) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/review_queue?status=in.(reviewed,dismissed)`,
    { method: "DELETE", headers: supabaseHeaders(env) });
  if (!res.ok) throw new Error(`Bulk delete review_queue failed: ${await res.text()}`);
  return jsonResponse({ deleted: true }, 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════

export { getOutreachProspects, createOutreachProspect, updateOutreachProspect, sendOutreachContract, getOutreachTouches, createOutreachTouch, getReviewQueue, updateReviewQueue, deleteReviewQueue, bulkDeleteReviewQueue };

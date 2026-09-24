import { jsonResponse } from "../shared/http.js";
import { supabaseDelete, supabaseFetch, supabasePatch, supabasePatchByField, supabasePost, supabaseHeaders } from "../shared/supabase.js";
import { sendResendEmail } from "../shared/runtime.js";

// § DOMAIN: proposals (client proposal authoring & delivery)
// ════════════════════════════════════════════════════════════════════════════
// Lifecycle: draft → sent → under_review → agreed → signed
// Admin routes handle authoring and delivery; public routes (content.js)
// handle client access and review submission.

const PROPOSAL_URL_BASE = "https://frontframe.co/proposal.html";
const PROPOSAL_TOKEN_TTL_DAYS = 7;

// ── helpers ──────────────────────────────────────────────────────────────────

function pickProposalUpdates(body) {
  const fields = ["prospect_name", "prospect_email", "internal_notes", "status", "version"];
  const updates = {};
  fields.forEach(k => { if (body[k] !== undefined) updates[k] = body[k]; });
  return updates;
}

function expiresAt(days) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

// ── list / get ────────────────────────────────────────────────────────────────

export async function listProposals(env, userJwt, corsHeaders) {
  const rows = await supabaseFetch(env, "proposals",
    "?select=proposal_id,lead_id,prospect_name,prospect_email,status,version,created_at,sent_at,reviewed_at&order=created_at.desc",
    userJwt);
  return jsonResponse(rows ?? [], 200, corsHeaders);
}

export async function getProposal(env, id, userJwt, corsHeaders) {
  const rows = await supabaseFetch(env, "proposals",
    `?proposal_id=eq.${id}&select=*`, userJwt);
  if (!rows?.length) return jsonResponse({ error: "Proposal not found" }, 404, corsHeaders);
  const proposal = rows[0];

  const sections = await supabaseFetch(env, "proposal_sections",
    `?proposal_id=eq.${id}&select=*&order=sort_order.asc`, userJwt) ?? [];

  const accessRows = await supabaseFetch(env, "proposal_access",
    `?proposal_id=eq.${id}&select=access_id,token,expires_at,accessed_at&order=expires_at.desc`,
    userJwt) ?? [];

  return jsonResponse({ ...proposal, sections, access: accessRows }, 200, corsHeaders);
}

// ── create ────────────────────────────────────────────────────────────────────

export async function createProposal(request, env, userJwt, corsHeaders) {
  const body = await request.json();
  const { prospect_name, prospect_email, lead_id, lead_alert_id, session_id, internal_notes } = body;
  if (!prospect_name || !prospect_email)
    return jsonResponse({ error: "prospect_name and prospect_email are required" }, 400, corsHeaders);

  const row = await supabasePost(env, "proposals", {
    prospect_name,
    prospect_email,
    lead_id:       lead_id       ?? null,
    lead_alert_id: lead_alert_id ?? null,
    session_id:    session_id    ?? null,
    internal_notes: internal_notes ?? null,
    status:  "draft",
    version: 1,
  }, userJwt);

  return jsonResponse(row, 201, corsHeaders);
}

// ── update ────────────────────────────────────────────────────────────────────

export async function updateProposal(request, env, id, userJwt, corsHeaders) {
  const body = await request.json();
  const updates = pickProposalUpdates(body);
  if (!Object.keys(updates).length)
    return jsonResponse({ error: "No valid fields to update" }, 400, corsHeaders);
  // proposals PK is proposal_id, not id — use PatchByField
  const rows = await supabasePatchByField(env, "proposals", "proposal_id", id, updates);
  return jsonResponse(rows, 200, corsHeaders);
}

// ── sections ──────────────────────────────────────────────────────────────────

export async function addProposalSection(request, env, id, userJwt, corsHeaders) {
  const body = await request.json();
  const { title, content = "", sort_order, client_visible = true } = body;
  if (!title) return jsonResponse({ error: "title is required" }, 400, corsHeaders);

  // Default sort_order to max existing + 10 if not supplied
  let order = sort_order;
  if (order === undefined) {
    const existing = await supabaseFetch(env, "proposal_sections",
      `?proposal_id=eq.${id}&select=sort_order&order=sort_order.desc&limit=1`, userJwt);
    order = existing?.length ? (existing[0].sort_order + 10) : 10;
  }

  const row = await supabasePost(env, "proposal_sections", {
    proposal_id: id, title, content, sort_order: order, client_visible,
  }, userJwt);
  return jsonResponse(row, 201, corsHeaders);
}

export async function updateProposalSection(request, env, id, sectionId, userJwt, corsHeaders) {
  const body = await request.json();
  const updates = {};
  ["title", "content", "sort_order", "client_visible"].forEach(k => {
    if (body[k] !== undefined) updates[k] = body[k];
  });
  if (!Object.keys(updates).length)
    return jsonResponse({ error: "No valid fields to update" }, 400, corsHeaders);
  const rows = await supabasePatchByField(env, "proposal_sections", "section_id", sectionId, updates);
  return jsonResponse(rows, 200, corsHeaders);
}

export async function deleteProposalSection(_request, env, id, sectionId, userJwt, corsHeaders) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/proposal_sections?section_id=eq.${encodeURIComponent(sectionId)}&proposal_id=eq.${encodeURIComponent(id)}`,
    { method: "DELETE", headers: { ...supabaseHeaders(env), "Prefer": "return=minimal" } }
  );
  if (!res.ok) throw new Error(`Supabase DELETE proposal_sections failed: ${await res.text()}`);
  return jsonResponse({ deleted: sectionId }, 200, corsHeaders);
}

// ── send ──────────────────────────────────────────────────────────────────────
// Generates a proposal_access token, sends the client a Resend email,
// and marks the proposal status = 'sent'.

export async function sendProposal(request, env, ctx, id, userJwt, corsHeaders) {
  // Verify proposal exists and is in a sendable state
  const proposalRows = await supabaseFetch(env, "proposals",
    `?proposal_id=eq.${id}&select=proposal_id,prospect_name,prospect_email,status,version`, userJwt);
  if (!proposalRows?.length) return jsonResponse({ error: "Proposal not found" }, 404, corsHeaders);
  const proposal = proposalRows[0];
  if (proposal.status === "agreed" || proposal.status === "signed")
    return jsonResponse({ error: `Cannot resend a proposal with status '${proposal.status}'` }, 409, corsHeaders);

  // Allow override email from request body (e.g. if admin wants to resend to different address)
  let body = {};
  try { body = await request.json(); } catch { /* no body is fine */ }
  const recipientEmail = body.email ?? proposal.prospect_email;

  // Create access token (7-day expiry)
  const accessRow = await supabasePost(env, "proposal_access", {
    proposal_id: id,
    expires_at:  expiresAt(PROPOSAL_TOKEN_TTL_DAYS),
  }, userJwt);
  const tokenArr = Array.isArray(accessRow) ? accessRow : [accessRow];
  const token = tokenArr[0]?.token;
  if (!token) return jsonResponse({ error: "Failed to create access token" }, 500, corsHeaders);

  const proposalUrl = `${PROPOSAL_URL_BASE}?token=${token}`;

  // Mark proposal sent
  await supabasePatchByField(env, "proposals", "proposal_id", id, {
    status:  "sent",
    sent_at: new Date().toISOString(),
  }).catch(e => console.error("proposal sent_at patch failed:", e));

  // Send email via Resend (fire-and-forget via waitUntil)
  const emailHtml = `
<!DOCTYPE html>
<html>
<body style="font-family:Inter,system-ui,sans-serif;color:#1E2D40;max-width:600px;margin:0 auto;padding:32px 24px">
  <div style="font-family:'DM Sans',system-ui,sans-serif;font-weight:700;font-size:1.3rem;margin-bottom:24px">
    Front<span style="color:#F5A623">Frame</span>
  </div>
  <h1 style="font-size:1.4rem;margin-bottom:8px">Your FrontFrame Proposal</h1>
  <p style="color:#6B7A8D;margin-bottom:24px">Hi ${proposal.prospect_name},</p>
  <p style="margin-bottom:16px">
    Your proposal is ready for review. Click the link below to read through it,
    flag any sections you'd like changed, and send Ed your overall response.
  </p>
  <p style="margin-bottom:24px">
    <a href="${proposalUrl}"
       style="display:inline-block;background:#F5A623;color:#1E2D40;font-weight:700;
              padding:12px 24px;border-radius:8px;text-decoration:none;font-size:1rem">
      Review Your Proposal →
    </a>
  </p>
  <p style="color:#6B7A8D;font-size:0.875rem">
    This link is personal to you and expires in ${PROPOSAL_TOKEN_TTL_DAYS} days.
    If you have questions before reviewing, reply to this email.
  </p>
  <hr style="border:none;border-top:1px solid #E4E8EE;margin:24px 0">
  <p style="color:#6B7A8D;font-size:0.8rem">FrontFrame · ed@frontframe.co</p>
</body>
</html>`;

  ctx.waitUntil(
    sendResendEmail(env, recipientEmail, "Your FrontFrame Proposal is Ready", emailHtml)
      .catch(e => console.error("proposal email send failed:", e))
  );

  return jsonResponse({ sent: true, token, proposal_url: proposalUrl, expires_at: tokenArr[0]?.expires_at }, 200, corsHeaders);
}

// ── mark agreed ───────────────────────────────────────────────────────────────

export async function markProposalAgreed(env, id, userJwt, corsHeaders) {
  const rows = await supabaseFetch(env, "proposals",
    `?proposal_id=eq.${id}&select=proposal_id,status`, userJwt);
  if (!rows?.length) return jsonResponse({ error: "Proposal not found" }, 404, corsHeaders);
  const current = rows[0].status;
  if (!["sent", "under_review"].includes(current))
    return jsonResponse({ error: `Cannot mark agreed: current status is '${current}'` }, 409, corsHeaders);

  const updated = await supabasePatchByField(env, "proposals", "proposal_id", id, {
    status: "agreed",
  });
  return jsonResponse(updated, 200, corsHeaders);
}

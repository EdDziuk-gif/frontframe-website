import { jsonResponse } from "../shared/http.js";
import { supabaseDelete, supabaseFetch, supabasePatch, supabasePatchByField, supabasePost, supabaseRpc, supabaseUpsert, supabaseHeaders } from "../shared/supabase.js";
import { STRIPE_PRICE_IDS, sendResendEmail, sendSms } from "../shared/runtime.js";

// § DOMAIN: subscriptions
// ════════════════════════════════════════════════════════════════════════════

async function getSubscriptions(env, userJwt, corsHeaders) {
  return jsonResponse(await supabaseFetch(env, "subscriptions", "?select=*&order=created_at.asc", userJwt), 200, corsHeaders);
}

async function createSubscription(request, env, userJwt, corsHeaders) {
  const body = await request.json();
  const { platform, provisioned_by = "frontframe", account_email, account_identifier,
    legal_business_name, ein, address, contact_name, phone, website,
    campaign_type, use_case_description, sample_message, estimated_monthly_volume,
    opt_in_method, opt_in_form_url, privacy_policy_url, approved_number,
    plan, billing_method, provisioned_at, notes } = body;
  if (!platform) return jsonResponse({ error: "platform is required" }, 400, corsHeaders);
  return jsonResponse(await supabasePost(env, "subscriptions", {
    platform, provisioned_by, account_email: account_email ?? null, account_identifier: account_identifier ?? null,
    legal_business_name: legal_business_name ?? null, ein: ein ?? null, address: address ?? null,
    contact_name: contact_name ?? null, phone: phone ?? null, website: website ?? null,
    campaign_type: campaign_type ?? null, use_case_description: use_case_description ?? null,
    sample_message: sample_message ?? null, estimated_monthly_volume: estimated_monthly_volume ?? null,
    opt_in_method: opt_in_method ?? null, opt_in_form_url: opt_in_form_url ?? null,
    privacy_policy_url: privacy_policy_url ?? null, approved_number: approved_number ?? null,
    plan: plan ?? null, billing_method: billing_method ?? null, provisioned_at: provisioned_at ?? null, notes: notes ?? null,
  }, userJwt), 201, corsHeaders);
}

async function updateSubscription(request, env, id, userJwt, corsHeaders) {
  const body = await request.json();
  const updates = {};
  ["status","provisioned_by","account_email","account_identifier","legal_business_name","ein","address","contact_name","phone","website",
   "campaign_type","use_case_description","sample_message","estimated_monthly_volume","opt_in_method","opt_in_form_url","privacy_policy_url",
   "approved_number","plan","billing_method","provisioned_at","notes"].forEach(k => { if (body[k] !== undefined) updates[k] = body[k]; });
  if (!Object.keys(updates).length) return jsonResponse({ error: "No valid fields to update" }, 400, corsHeaders);
  return jsonResponse(await supabasePatch(env, "subscriptions", id, updates, userJwt), 200, corsHeaders);
}

async function sendSubscription(env, id, userJwt, corsHeaders) {
  const rows = await supabaseFetch(env, "subscriptions", `?id=eq.${id}&select=*`, userJwt);
  if (!rows?.length) return jsonResponse({ error: "Subscription not found" }, 404, corsHeaders);
  const sub = rows[0];
  await supabasePatch(env, "subscriptions", id, { status: "submitted", submitted_at: new Date().toISOString() }, userJwt);
  await sendSms(env,
    `FrontFrame subscription setup\nPlatform: ${sub.platform}\nProvisioned by: ${sub.provisioned_by}\n` +
    (sub.approved_number ? `Number: ${sub.approved_number}\n` : "") +
    (sub.plan            ? `Plan: ${sub.plan}\n`              : "") +
    (sub.account_email   ? `Email: ${sub.account_email}\n`    : "") +
    (sub.notes           ? `Notes: ${sub.notes.slice(0, 100)}` : "")
  ).catch((e) => console.error("subscription SMS failed:", e));
  return jsonResponse({ sent: true }, 200, corsHeaders);
}

// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: payments
// ════════════════════════════════════════════════════════════════════════════

async function createCheckoutSession(request, env, userJwt, corsHeaders) {
  const { price_id, lead_id, price_label, success_url, cancel_url } = await request.json();
  if (!price_id || !success_url) return jsonResponse({ error: "price_id and success_url are required" }, 400, corsHeaders);
  const params = new URLSearchParams();
  params.append("mode", "payment");
  params.append("line_items[0][price]", price_id);
  params.append("line_items[0][quantity]", "1");
  params.append("success_url", success_url);
  params.append("cancel_url", cancel_url ?? success_url);
  if (lead_id)     params.append("metadata[lead_id]", lead_id);
  if (price_label) params.append("metadata[price_label]", price_label);
  const res = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!res.ok) throw new Error(`Stripe checkout session failed: ${await res.text()}`);
  const s = await res.json();
  return jsonResponse({ url: s.url, session_id: s.id }, 201, corsHeaders);
}

async function handleSendPaymentRequest(request, env, userJwt, corsHeaders) {
  const { lead_id, agreement_id } = await request.json();
  if (!lead_id) return jsonResponse({ error: "lead_id is required" }, 400, corsHeaders);
  const leadRows = await supabaseFetch(env, "leads", `?id=eq.${lead_id}&select=id,name,email,business_name`);
  if (!leadRows?.length) return jsonResponse({ error: "Lead not found" }, 404, corsHeaders);
  const lead = leadRows[0];
  let agrId  = agreement_id;
  if (!agrId) {
    const agrRows = await supabaseFetch(env, "agreements", `?lead_id=eq.${lead_id}&status=eq.signed&order=sent_at.desc&limit=1`);
    if (!agrRows?.length) return jsonResponse({ error: "No signed agreement found for this lead" }, 404, corsHeaders);
    agrId = agrRows[0].id;
  }
  const params = new URLSearchParams();
  params.append("mode", "payment");
  params.append("line_items[0][price]", STRIPE_PRICE_IDS.due_diligence_deposit);
  params.append("line_items[0][quantity]", "1");
  params.append("success_url", `https://frontframe.co/start?lead=${lead_id}`);
  params.append("cancel_url", "https://frontframe.co");
  params.append("customer_email", lead.email ?? "");
  params.append("metadata[lead_id]", lead_id);
  params.append("metadata[price_label]", "Due Diligence Deposit");
  const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.STRIPE_SECRET_KEY}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: params.toString(),
  });
  if (!stripeRes.ok) throw new Error(`Stripe checkout failed: ${await stripeRes.text()}`);
  const stripeSession = await stripeRes.json();
  const emailHtml = `<!DOCTYPE html><html><body style="font-family:Inter,system-ui,sans-serif;color:#1E2D40;max-width:560px;margin:0 auto;padding:40px 24px">
<div style="margin-bottom:32px"><strong style="font-size:1.1rem">FrontFrame</strong></div>
<p style="margin-bottom:16px">Hi ${lead.name},</p>
<p style="margin-bottom:16px">Thank you for signing the Due Diligence &amp; Engagement Framework.</p>
<p style="margin-bottom:16px">Your $500 Due Diligence Deposit secures your place and authorizes FrontFrame to begin research and prepare a Draft Site Recommendation. Work begins upon confirmation of cleared funds.</p>
<p style="margin:32px 0"><a href="${stripeSession.url}" style="background:#F5A623;color:#1E2D40;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">Pay $500 Deposit</a></p>
<p style="font-size:0.875rem;color:#8A9BAE">If you have questions, reply to this email and I will get back to you promptly.</p>
<hr style="border:none;border-top:1px solid #E8ECF0;margin:32px 0">
<p style="font-size:0.8rem;color:#8A9BAE">FrontFrame LLC - Phoenix, Arizona - frontframe.co</p>
</body></html>`;
  await sendResendEmail(env, lead.email, "FrontFrame Due Diligence Deposit - $500", emailHtml);
  await supabasePatch(env, "agreements", agrId, {
    payment_request_sent_at: new Date().toISOString(),
    stripe_session_id:       stripeSession.id,
  }).catch((e) => console.error("agreement payment_request update failed:", e));
  return jsonResponse({ sent: true, checkout_url: stripeSession.url }, 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: vault
// ════════════════════════════════════════════════════════════════════════════

// Encryption itself is handled entirely by Supabase's built-in Vault
// (the supabase_vault extension, vault.create_secret/vault.update_secret/
// vault.decrypted_secrets) via the vault_get_all_entries and
// vault_upsert_entry SECURITY DEFINER functions in the public schema.
// The Worker never sees or manages an encryption key — Supabase does,
// on its own infrastructure. See [[project-frontframe-vault]] memory /
// 2026-07-03 migration for why this replaced a prior hand-rolled
// AES-GCM + Cloudflare-secret scheme (that key was lost during a
// Cloudflare account migration and made every stored credential
// permanently unrecoverable).

async function handleAdminVaultGet(request, env, userJwt, corsHeaders) {
  let rows;
  try { rows = await supabaseRpc(env, "vault_get_all_entries"); }
  catch (e) { return jsonResponse({ error: e.message }, 500, corsHeaders); }
  const result = {};
  for (const row of rows) {
    let data = {};
    try { data = row.decrypted_data ? JSON.parse(row.decrypted_data) : {}; }
    catch { data = {}; }
    result[row.vendor] = {
      category:   row.category,
      data,
      updated_at: row.updated_at,
      updated_by: row.updated_by,
    };
  }
  return jsonResponse(result, 200, corsHeaders);
}

async function handleAdminVaultSet(request, env, userJwt, corsHeaders) {
  const { vendor, category, data } = await request.json().catch(() => ({}));
  if (!vendor || !data) return jsonResponse({ error: "vendor and data are required." }, 400, corsHeaders);
  try {
    await supabaseRpc(env, "vault_upsert_entry", {
      p_vendor:     vendor,
      p_category:   category ?? "platform",
      p_data:       JSON.stringify(data),
      p_updated_by: "ed@frontframe.co",
    });
  } catch (e) {
    console.error("Vault save error:", e.message);
    return jsonResponse({ error: "Failed to save vault entry.", detail: e.message }, 500, corsHeaders);
  }
  return jsonResponse({ saved: true }, 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════

export { getSubscriptions, createSubscription, updateSubscription, sendSubscription, createCheckoutSession, handleSendPaymentRequest, handleAdminVaultGet, handleAdminVaultSet };

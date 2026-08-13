import { jsonResponse } from "../shared/http.js";
import { supabaseDelete, supabaseFetch, supabasePatch, supabasePatchByField, supabasePost, supabaseRpc, supabaseUpsert, supabaseHeaders } from "../shared/supabase.js";
import { fetchAndStoreDocument, sendSms, verifyStripeSignature } from "../shared/runtime.js";

// § DOMAIN: webhooks
// ════════════════════════════════════════════════════════════════════════════

async function handleStripeWebhook(request, env, corsHeaders) {
  const rawBody = await request.text();
  const sig     = request.headers.get("stripe-signature");
  if (env.STRIPE_WEBHOOK_SECRET && sig) {
    const valid = await verifyStripeSignature(rawBody, sig, env.STRIPE_WEBHOOK_SECRET);
    if (!valid) return jsonResponse({ error: "Invalid signature" }, 400, corsHeaders);
  }
  let event;
  try { event = JSON.parse(rawBody); } catch { return jsonResponse({ ok: true }, 200, corsHeaders); }
  if (event.type === "checkout.session.completed") {
    const session    = event.data.object;
    const leadId     = session.metadata?.lead_id     ?? null;
    const priceLabel = session.metadata?.price_label ?? "payment";
    const amount     = session.amount_total          ?? 0;

    // Ledger + idempotency: record every completed session before acting on it.
    // payments.stripe_session_id is UNIQUE -- a duplicate insert means Stripe
    // already delivered this event, so skip the notification/agreement patch.
    let alreadyProcessed = false;
    try {
      await supabasePost(env, "payments", {
        client_name: session.customer_details?.name ?? null,
        client_email: session.customer_details?.email ?? null,
        amount_cents: amount,
        currency: session.currency ?? "usd",
        payment_type: priceLabel,
        stripe_session_id: session.id,
        stripe_payment_intent_id: session.payment_intent ?? null,
      });
    } catch (e) {
      if (String(e.message).includes("duplicate key")) {
        alreadyProcessed = true;
      } else {
        console.error("payments ledger insert failed:", e);
      }
    }

    if (!alreadyProcessed) {
      if (leadId) {
        const agrRows = await supabaseFetch(env, "agreements", `?lead_id=eq.${leadId}&order=sent_at.desc&limit=1`).catch(() => null);
        if (agrRows?.length) {
          await supabasePatch(env, "agreements", agrRows[0].id, {
            payment_received_at: new Date().toISOString(), stripe_session_id: session.id,
          }).catch((e) => console.error("payment_received_at update failed:", e));
        }
      }
      await sendSms(env,
        `FrontFrame payment received\nAmount: $${(amount / 100).toFixed(2)}\nItem: ${priceLabel}\n` +
        (leadId ? `Lead: ${leadId}\n` : "") + `Session: ${session.id.slice(-12)}`
      ).catch((e) => console.error("Stripe payment SMS failed:", e));
    }
  }
  return jsonResponse({ ok: true }, 200, corsHeaders);
}

async function handleDocusealWebhook(request, env, corsHeaders) {
  let payload;
  try { payload = await request.json(); } catch { return jsonResponse({ ok: true }, 200, corsHeaders); }
  const eventType    = payload?.event_type ?? payload?.event ?? "";
  const submissionId = String(payload?.data?.id ?? payload?.submission_id ?? "");
  if (!submissionId || !eventType.includes("completed")) return jsonResponse({ ok: true }, 200, corsHeaders);

  const agreementRows = await supabaseFetch(env, "agreements",
    `?docuseal_envelope_id=eq.${encodeURIComponent(submissionId)}&select=id,order_id,lead_id`).catch(() => null);
  if (agreementRows?.length) {
    const agreement = agreementRows[0];
    await supabasePatch(env, "agreements", agreement.id, { status: "signed", signed_at: new Date().toISOString() })
      .catch((e) => console.error("agreement patch failed:", e));
    const documentUrl = await fetchAndStoreDocument(env, submissionId, agreement.lead_id, agreement.id);
    if (documentUrl) {
      await supabasePatch(env, "agreements", agreement.id, { document_url: documentUrl })
        .catch((e) => console.error("document_url update failed:", e));
    }
    await sendSms(env, `FrontFrame contract signed\nLead: ${agreement.lead_id ?? "N/A"}\nDocuSeal ID: ${submissionId}`)
      .catch((e) => console.error("SMS failed:", e));
  }
  return jsonResponse({ ok: true }, 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════

export { handleStripeWebhook, handleDocusealWebhook };

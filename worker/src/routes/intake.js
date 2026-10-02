import { jsonResponse } from "../shared/http.js";
import { supabaseDelete, supabaseFetch, supabasePatch, supabasePatchByField, supabasePost, supabaseRpc, supabaseHeaders } from "../shared/supabase.js";
import { escapeHtml, sendSms } from "../shared/runtime.js";
import { getOperator, sendOperatorEmail } from "../shared/operator.js";
import { localTimeNow, timezoneLabel } from "../shared/zip-timezone.js";

// § DOMAIN: contact handoff
// ════════════════════════════════════════════════════════════════════════════

// Infer a contact method when the caller didn't state one: "@" -> email,
// otherwise assume a phone number and default to a call.
function inferContactMethod(method, contact) {
  if (method === "phone" || method === "text" || method === "email") return method;
  return String(contact ?? "").includes("@") ? "email" : "phone";
}

// The one place a contact request leaves the site: one lead row, one lead_alert
// row, one SMS, one email to the Operator.
//
// Called from the chat handoff flow (routes/handoff-flow.js), after the visitor
// has read the exact text and said yes, and from the intake form (the visitor
// submitting the form is their own affirmation).
//
// What is sent to the Operator is the contact details and the affirmed inquiry
// (`summary`) and nothing else. The conversation is never emailed or texted
// (Decision 1). `transcript`, when given, is stored on the lead_alerts row only,
// readable in the admin Pipeline panel and cleared when a reviewer closes the
// alert (Decisions 13, 15, 17, 20).
//
// The writes are awaited and the result says whether the request reached the
// Operator by at least one route, so the caller never tells a visitor "sent"
// when nothing was (`delivered`). De-dupes on session_id within a short window.
async function captureContactHandoff(env, ctx, {
  session_id = null, name, contact, method, zip = "", timezone = "",
  summary = "", source = "agent", transcript = null, consent = null,
}) {
  const resolvedMethod = inferContactMethod(method, contact);

  if (session_id) {
    try {
      const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();
      const existing = await supabaseFetch(env, "lead_alerts",
        `?session_id=eq.${encodeURIComponent(session_id)}&triggered_at=gte.${encodeURIComponent(since)}&select=alert_id&limit=1`);
      if (existing?.length) return { deduped: true, delivered: true, alertId: existing[0].alert_id, leadId: null };
    } catch (e) { console.error("handoff dedupe check failed (continuing):", e); }
  }

  const isEmail = String(contact ?? "").includes("@");
  const geo = [zip && `Zip: ${zip}`, timezone && `TZ: ${timezone}`].filter(Boolean).join("  ");
  const notes = [summary, geo].filter(Boolean).join("\n");
  // For the Operator's email and text only: what time it is for the visitor right
  // now, so a call back can be timed. The zone itself is worked out from the zip
  // the visitor gave (shared/zip-timezone.js) and was shown to them before sending.
  const localTime = localTimeNow(timezone);
  const geoAlert = [geo && (timezone ? geo.replace(`TZ: ${timezone}`, `Time zone: ${timezoneLabel(timezone)} (from zip)`) : geo),
    localTime && `Their time now: ${localTime}`].filter(Boolean).join("  ");

  let leadId = null;
  try {
    const leadRows = await supabasePost(env, "leads", {
      name, email: isEmail ? contact : null, phone: isEmail ? null : contact,
      notes, source, status: "new",
      ...(consent ? { consented_at: consent.at, consent_notice_version: consent.noticeVersion } : {}),
    });
    leadId = leadRows?.[0]?.id ?? null;
  } catch (e) { console.error("handoff lead write failed:", e); }

  const methodLabel = resolvedMethod === "phone" ? "Phone call" : resolvedMethod === "text" ? "Text" : "Email";
  const sourceLabel = source === "intake" ? "intake form" : "site assistant";
  const smsMessage =
    `FrontFrame contact request\nName: ${name}\nReach by: ${methodLabel}\nContact: ${contact}\n` +
    (geoAlert ? `${geoAlert}\n` : "") + `Source: ${sourceLabel}\n` +
    (summary ? `Request: ${summary.slice(0, 200)}` : "");

  const emailHtml = `<!DOCTYPE html><html><body style="font-family:Inter,system-ui,sans-serif;color:#1E2D40;max-width:560px;margin:0 auto;padding:40px 24px">
<div style="margin-bottom:24px"><strong style="font-size:1.1rem">FrontFrame — Contact Request</strong></div>
<p style="margin-bottom:4px"><strong>${escapeHtml(name)}</strong> submitted the ${escapeHtml(sourceLabel)}.</p>
<p style="margin:16px 0;color:#3A4A5C">
  Reach by: ${escapeHtml(methodLabel)}<br>
  Contact: ${escapeHtml(contact)}<br>
  ${geoAlert ? escapeHtml(geoAlert) + "<br>" : ""}
  Source: ${escapeHtml(source)}
</p>
${summary ? `<p style="margin:16px 0"><strong>Request:</strong> ${escapeHtml(summary)}</p>` : ""}
<hr style="border:none;border-top:1px solid #E8ECF0;margin:32px 0">
<p style="font-size:0.75rem;color:#8A9BAE">Backup notification alongside the SMS alert. The visitor chose to send this text and nothing else. Any conversation is in the admin Pipeline panel.</p>
</body></html>`;

  // Resolved once, then both routes run to completion before we report back.
  const operator = await getOperator(env);
  const emailPromise = sendOperatorEmail(env, `FrontFrame contact request — ${name}`, emailHtml, operator)
    .then((r) => r?.success !== false)
    .catch((e) => { console.error("handoff email failed:", e); return false; });

  const alertPromise = supabasePost(env, "lead_alerts", {
    session_id, page: source, prospect_name: name, trigger_reason: summary,
    current_site: null, status: "new", sms_sent: false, sms_status: null, lead_id: leadId,
    ...(Array.isArray(transcript) && transcript.length ? { transcript } : {}),
  })
    .then(async (alertRows) => {
      const alertId = alertRows?.[0]?.alert_id ?? null;
      const smsResult = await sendSms(env, smsMessage);
      if (alertId) {
        await supabasePatchByField(env, "lead_alerts", "alert_id", alertId,
          { sms_sent: smsResult.success, sms_status: smsResult.status })
          .catch((e) => console.error("handoff alert sms update failed:", e));
      }
      return alertId;
    })
    .catch((e) => { console.error("handoff lead_alert write failed:", e); return null; });

  const [emailSent, alertId] = await Promise.all([emailPromise, alertPromise]);
  const delivered = Boolean(emailSent || alertId || leadId);
  return { deduped: false, delivered, alertId, leadId };
}

// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: inquiry
// ════════════════════════════════════════════════════════════════════════════

async function verifyTurnstile(token, remoteIp, env) {
  if (!env.TURNSTILE_SECRET_KEY) return true; // not configured yet — don't hard-fail existing deploys
  if (!token) return false;
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token, ...(remoteIp ? { remoteip: remoteIp } : {}) }),
  });
  const data = await res.json().catch(() => ({ success: false }));
  return data.success === true;
}

async function handleInquiry(request, env, corsHeaders) {
  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "Invalid JSON" }, 400, corsHeaders); }

  const { owner_name, business_name, email, phone, business_type, tier_interest,
          description, services, clients, anything_else, source_page, turnstileToken } = body;

  if (!owner_name || !business_name || !email)
    return jsonResponse({ error: "owner_name, business_name, and email are required" }, 400, corsHeaders);

  const clientIp = request.headers.get("CF-Connecting-IP");
  const humanVerified = await verifyTurnstile(turnstileToken, clientIp, env).catch(() => false);
  if (!humanVerified)
    return jsonResponse({ error: "Verification failed. Please retry the checkbox above." }, 400, corsHeaders);

  // Pack all intake detail into notes so it travels with the lead record.
  // business_type and tier_interest are intake-specific fields; leads table
  // does not have columns for them so they are serialized here.
  const notes = [
    description,
    business_type  ? `Business type: ${business_type}`   : null,
    tier_interest  ? `Tier interest: ${tier_interest}`   : null,
    services       ? `Services: ${services}`             : null,
    clients        ? `Clients: ${clients}`               : null,
    anything_else  ? `Additional: ${anything_else}`      : null,
  ].filter(Boolean).join("\n\n") || null;

  const contact = phone?.trim() || email.trim().toLowerCase();
  const method  = phone?.trim() ? "phone" : "email";

  const result = await captureContactHandoff(env, null, {
    name:     owner_name.trim(),
    contact,
    method,
    summary:  notes ?? "",
    source:   "intake",
    zip:      "",
    timezone: "",
  });

  if (!result.delivered)
    return jsonResponse({ error: "We couldn't send that just now. Please try again in a few minutes." }, 502, corsHeaders);
  return jsonResponse({ ok: true }, 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: scheduling (blackout dates + consultation bookings)
// ════════════════════════════════════════════════════════════════════════════

const CONSULT_SLOTS = ["9:00 AM MST", "10:00 AM MST", "11:00 AM MST", "1:00 PM MST", "2:00 PM MST", "3:00 PM MST"];

// Public — returns active/future blackout ranges so the client can grey out
// unavailable dates. Mirrors eleanor-website's /blackout endpoint.
async function getBlackout(env, corsHeaders) {
  const today  = new Date().toISOString().slice(0, 10);
  const rows   = await supabaseFetch(env, "blackout_periods",
    "?end_date=gte." + today + "&select=start_date,end_date,reason&order=start_date.asc");
  const periods = rows.map(r => ({ startDate: r.start_date, endDate: r.end_date, reason: r.reason ?? null }));
  return jsonResponse({ periods, slots: CONSULT_SLOTS }, 200, corsHeaders);
}

function dateInBlackout(dateStr, periods) {
  const d = new Date(dateStr + "T12:00:00");
  return periods.some(p => {
    const start = new Date(p.start_date + "T12:00:00");
    const end   = new Date(p.end_date   + "T12:00:00");
    return d >= start && d <= end;
  });
}

// Public — books a consultation/kickoff call. Validates the date against
// blackout periods and the requested slot against existing bookings
// server-side (never trust the client-side picker alone).
async function handleSchedule(request, env, corsHeaders) {
  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ error: "Invalid JSON" }, 400, corsHeaders); }

  const { name, email, business_name, phone, requested_date, slot_label, notes, inquiry_id, turnstileToken } = body;

  if (!name || !email || !requested_date || !slot_label)
    return jsonResponse({ error: "name, email, requested_date, and slot_label are required" }, 400, corsHeaders);
  if (!CONSULT_SLOTS.includes(slot_label))
    return jsonResponse({ error: "Invalid time slot" }, 400, corsHeaders);

  const clientIp = request.headers.get("CF-Connecting-IP");
  const humanVerified = await verifyTurnstile(turnstileToken, clientIp, env).catch(() => false);
  if (!humanVerified)
    return jsonResponse({ error: "Verification failed. Please retry the checkbox above." }, 400, corsHeaders);

  const today = new Date().toISOString().slice(0, 10);
  if (requested_date < today)
    return jsonResponse({ error: "Please choose a date in the future." }, 400, corsHeaders);

  const blackoutRows = await supabaseFetch(env, "blackout_periods",
    "?end_date=gte." + today + "&select=start_date,end_date");
  if (dateInBlackout(requested_date, blackoutRows))
    return jsonResponse({ error: "That date isn't available. Please pick another." }, 409, corsHeaders);

  try {
    const rows = await supabasePost(env, "consultation_bookings", {
      name: name.trim(), email: email.trim().toLowerCase(),
      business_name: business_name?.trim() ?? null, phone: phone?.trim() ?? null,
      requested_date, slot_label, notes: notes?.trim() ?? null,
      inquiry_id: inquiry_id ?? null, status: "requested",
    });
    await sendSms(env, "FrontFrame call booked\n" + name.trim() + " -- " + requested_date + " @ " + slot_label)
      .catch((e) => console.error("booking SMS failed:", e));
    return jsonResponse({ ok: true, booking: rows?.[0] ?? null }, 200, corsHeaders);
  } catch (e) {
    if (String(e.message).includes("23505")) // unique violation on (requested_date, slot_label)
      return jsonResponse({ error: "That slot was just taken. Please pick another." }, 409, corsHeaders);
    throw e;
  }
}

// Admin — blackout period CRUD.
async function getBlackoutAdmin(env, corsHeaders) {
  return jsonResponse(await supabaseFetch(env, "blackout_periods",
    "?select=id,start_date,end_date,reason,created_at&order=start_date.asc"), 200, corsHeaders);
}

async function createBlackoutAdmin(request, env, corsHeaders) {
  const { start_date, end_date, reason } = await request.json();
  if (!start_date || !end_date) return jsonResponse({ error: "start_date and end_date are required" }, 400, corsHeaders);
  return jsonResponse(await supabasePost(env, "blackout_periods", { start_date, end_date, reason: reason ?? null }), 201, corsHeaders);
}

async function deleteBlackoutAdmin(env, id, corsHeaders) {
  await supabaseDelete(env, "blackout_periods", id);
  return jsonResponse({ ok: true }, 200, corsHeaders);
}

// Admin — view/manage consultation bookings.
async function getBookingsAdmin(env, corsHeaders) {
  return jsonResponse(await supabaseFetch(env, "consultation_bookings",
    "?select=id,name,email,business_name,phone,requested_date,slot_label,notes,status,inquiry_id,created_at&order=requested_date.asc"), 200, corsHeaders);
}

async function updateBookingAdmin(request, env, id, corsHeaders) {
  const body = await request.json();
  const updates = {};
  ["status", "notes"].forEach(k => { if (body[k] !== undefined) updates[k] = body[k]; });
  if (!Object.keys(updates).length) return jsonResponse({ error: "No fields to update" }, 400, corsHeaders);
  return jsonResponse(await supabasePatch(env, "consultation_bookings", id, updates), 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════

export { captureContactHandoff, inferContactMethod, verifyTurnstile, handleInquiry, getBlackout, dateInBlackout, handleSchedule, getBlackoutAdmin, createBlackoutAdmin, deleteBlackoutAdmin, getBookingsAdmin, updateBookingAdmin };

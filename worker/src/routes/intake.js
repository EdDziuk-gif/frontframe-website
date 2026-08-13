import { jsonResponse } from "../shared/http.js";
import { supabaseDelete, supabaseFetch, supabasePatch, supabasePatchByField, supabasePost, supabaseRpc, supabaseUpsert, supabaseHeaders } from "../shared/supabase.js";
import { sendSms } from "../shared/runtime.js";

// § DOMAIN: notify
// ════════════════════════════════════════════════════════════════════════════

async function handleNotify(request, env, ctx, corsHeaders) {
  const body = await request.json();
  const { session_id = null, name, contact, method, summary = "", source } = body;
  if (!name || !contact || !method || !source)
    return jsonResponse({ error: "name, contact, method, and source are required" }, 400, corsHeaders);

  const isEmail   = contact.includes("@");
  const leadPayload = {
    name, email: isEmail ? contact : null, phone: isEmail ? null : contact,
    notes: summary, source, status: "new",
  };

  let leadId = null;
  try {
    const leadRows = await supabasePost(env, "leads", leadPayload);
    leadId = leadRows?.[0]?.id ?? null;
  } catch (e) { console.error("notify lead write failed:", e); }

  const alertPayload = {
    session_id, page: source, prospect_name: name, trigger_reason: summary,
    current_site: null, status: "new", sms_sent: false, sms_status: null, lead_id: leadId,
  };

  const methodLabel = method === "phone" ? "Phone call" : method === "text" ? "Text" : "Email";
  const smsMessage  =
    `FrontFrame contact request\nName: ${name}\nReach by: ${methodLabel}\nContact: ${contact}\nSource: ${source}\n` +
    (summary ? `Summary: ${summary.slice(0, 200)}` : "");

  ctx.waitUntil(
    supabasePost(env, "lead_alerts", alertPayload)
      .then(async (alertRows) => {
        const alertId   = alertRows?.[0]?.alert_id ?? null;
        const smsResult = await sendSms(env, smsMessage);
        if (alertId) {
          await supabasePatchByField(env, "lead_alerts", "alert_id", alertId,
            { sms_sent: smsResult.success, sms_status: smsResult.status })
            .catch((e) => console.error("notify alert sms update failed:", e));
        }
      })
      .catch((e) => console.error("notify lead_alert write failed:", e))
  );

  return jsonResponse({ received: true }, 200, corsHeaders);
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

  const fullDescription = [
    description,
    services      ? `Services: ${services}`       : null,
    clients       ? `Clients: ${clients}`          : null,
    anything_else ? `Additional: ${anything_else}` : null,
  ].filter(Boolean).join("\n\n") || null;

  await supabasePost(env, "inquiries", {
    owner_name:    owner_name.trim(),
    business_name: business_name.trim(),
    email:         email.trim().toLowerCase(),
    phone:         phone?.trim() ?? null,
    business_type: business_type ?? null,
    tier_interest: tier_interest ?? "undecided",
    description:   fullDescription,
    source_page:   source_page ?? "added-intake",
    status:        "new",
  });

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

export { handleNotify, verifyTurnstile, handleInquiry, getBlackout, dateInBlackout, handleSchedule, getBlackoutAdmin, createBlackoutAdmin, deleteBlackoutAdmin, getBookingsAdmin, updateBookingAdmin };

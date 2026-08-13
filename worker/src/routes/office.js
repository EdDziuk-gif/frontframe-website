import { jsonResponse } from "../shared/http.js";
import { supabaseDelete, supabaseFetch, supabasePatch, supabasePatchByField, supabasePost, supabaseRpc, supabaseUpsert, supabaseHeaders } from "../shared/supabase.js";
import { getPhoenixDateStr, getPhoenixDayOfWeek } from "../shared/runtime.js";

// § DOMAIN: office-hours
// ════════════════════════════════════════════════════════════════════════════

async function getEffectiveHours(env, corsHeaders) {
  try {
    const today     = getPhoenixDateStr();
    const dayOfWeek = getPhoenixDayOfWeek();
    const overrides = await supabaseFetch(env, "office_hours_overrides",
      `?override_date=eq.${today}&select=open_time,close_time,is_closed,note`);
    if (overrides?.length)
      return jsonResponse({ source: "override", date: today, day_of_week: dayOfWeek, ...overrides[0] }, 200, corsHeaders);
    const schedule = await supabaseFetch(env, "office_hours_schedule",
      `?day_of_week=eq.${dayOfWeek}&select=day_of_week,open_time,close_time,is_closed`);
    return jsonResponse({ source: "schedule", date: today, day_of_week: dayOfWeek, ...(schedule?.[0] ?? { is_closed: true }) }, 200, corsHeaders);
  } catch (e) {
    console.error("getEffectiveHours error:", e);
    return jsonResponse({ source: "error", is_closed: true }, 200, corsHeaders);
  }
}

async function getSchedule(env, userJwt, corsHeaders) {
  return jsonResponse(await supabaseFetch(env, "office_hours_schedule", "?select=*&order=day_of_week.asc", userJwt), 200, corsHeaders);
}

async function updateScheduleDay(request, env, day, userJwt, corsHeaders) {
  const body = await request.json();
  const updates = {};
  ["open_time","close_time","is_closed"].forEach(k => { if (body[k] !== undefined) updates[k] = body[k]; });
  if (!Object.keys(updates).length) return jsonResponse({ error: "No valid fields to update" }, 400, corsHeaders);
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/office_hours_schedule?day_of_week=eq.${day}`,
    { method: "PATCH", headers: supabaseHeaders(env), body: JSON.stringify(updates) });
  if (!res.ok) throw new Error(`Supabase PATCH office_hours_schedule failed: ${await res.text()}`);
  return jsonResponse({ updated: true }, 200, corsHeaders);
}

async function getOverrides(env, userJwt, corsHeaders) {
  const today = getPhoenixDateStr();
  return jsonResponse(await supabaseFetch(env, "office_hours_overrides",
    `?override_date=gte.${today}&select=*&order=override_date.asc`, userJwt), 200, corsHeaders);
}

async function createOverride(request, env, userJwt, corsHeaders) {
  const { override_date, open_time, close_time, is_closed, note } = await request.json();
  if (!override_date) return jsonResponse({ error: "override_date is required" }, 400, corsHeaders);
  return jsonResponse(await supabasePost(env, "office_hours_overrides", {
    override_date,
    open_time:  is_closed ? null : (open_time  ?? null),
    close_time: is_closed ? null : (close_time ?? null),
    is_closed:  is_closed ?? false,
    note:       note ?? null,
  }, userJwt), 201, corsHeaders);
}

async function deleteOverride(env, date, userJwt, corsHeaders) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/office_hours_overrides?override_date=eq.${encodeURIComponent(date)}`,
    { method: "DELETE", headers: supabaseHeaders(env) });
  if (!res.ok) throw new Error(`Supabase DELETE office_hours_overrides failed: ${await res.text()}`);
  return jsonResponse({ deleted: date }, 200, corsHeaders);
}


export { getEffectiveHours, getSchedule, updateScheduleDay, getOverrides, createOverride, deleteOverride };

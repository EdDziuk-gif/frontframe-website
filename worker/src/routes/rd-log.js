import { jsonResponse } from "../shared/http.js";
import { supabaseDelete, supabaseFetch, supabasePatch, supabasePatchByField, supabasePost, supabaseRpc, supabaseUpsert, supabaseHeaders } from "../shared/supabase.js";

// § DOMAIN: rd-log
// ════════════════════════════════════════════════════════════════════════════

async function getRdLog(env, userJwt, corsHeaders) {
  return jsonResponse(await supabaseFetch(env, "rd_log", "?select=*&order=session_date.desc,created_at.desc", userJwt), 200, corsHeaders);
}

async function createRdEntry(request, env, userJwt, corsHeaders) {
  const { client, session_date, duration_minutes, category, description, qualifies, dedup_note, narrative } = await request.json();
  if (!client || !session_date || !duration_minutes || !category)
    return jsonResponse({ error: "client, session_date, duration_minutes, and category are required" }, 400, corsHeaders);
  return jsonResponse(await supabasePost(env, "rd_log", {
    client, session_date, duration_minutes: parseInt(duration_minutes, 10),
    category, description: description ?? null, qualifies: qualifies ?? false,
    dedup_note: dedup_note ?? null, narrative: narrative ?? null,
  }, userJwt), 201, corsHeaders);
}

async function deleteRdEntry(env, id, userJwt, corsHeaders) {
  await supabaseDelete(env, "rd_log", id);
  return jsonResponse({ deleted: id }, 200, corsHeaders);
}

async function updateRdEntry(request, env, id, userJwt, corsHeaders) {
  const body = await request.json();
  const updates = {};
  ["client","session_date","duration_minutes","category","description","qualifies","dedup_note","narrative"]
    .forEach(k => { if (body[k] !== undefined) updates[k] = body[k]; });
  if (!Object.keys(updates).length)
    return jsonResponse({ error: "No valid fields to update" }, 400, corsHeaders);
  if (updates.duration_minutes !== undefined) updates.duration_minutes = parseInt(updates.duration_minutes, 10);
  return jsonResponse(await supabasePatch(env, "rd_log", id, updates, userJwt), 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════

export { getRdLog, createRdEntry, deleteRdEntry, updateRdEntry };

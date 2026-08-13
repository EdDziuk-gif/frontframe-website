import { jsonResponse } from "../shared/http.js";
import { supabaseDelete, supabaseFetch, supabasePatch, supabasePatchByField, supabasePost, supabaseRpc, supabaseUpsert, supabaseHeaders } from "../shared/supabase.js";

// § DOMAIN: marketing-log
// ════════════════════════════════════════════════════════════════════════════

async function getMarketingLog(request, env, userJwt, corsHeaders) {
  const platform = new URL(request.url).searchParams.get("platform");
  let query = "?select=*&order=log_date.desc,created_at.desc";
  if (platform) query += `&platform=eq.${encodeURIComponent(platform)}`;
  return jsonResponse(await supabaseFetch(env, "marketing_log", query, userJwt), 200, corsHeaders);
}

async function createMarketingLog(request, env, userJwt, corsHeaders) {
  const { platform, question, answer, action_committed } = await request.json();
  if (!platform || !question) return jsonResponse({ error: "platform and question are required" }, 400, corsHeaders);
  return jsonResponse(await supabasePost(env, "marketing_log", {
    platform, question, answer: answer ?? null, action_committed: action_committed ?? null,
  }, userJwt), 201, corsHeaders);
}

async function updateMarketingLog(request, env, id, userJwt, corsHeaders) {
  const body = await request.json();
  const updates = {};
  ["notes","action_committed","answer"].forEach(k => { if (body[k] !== undefined) updates[k] = body[k]; });
  if (!Object.keys(updates).length) return jsonResponse({ error: "No valid fields to update" }, 400, corsHeaders);
  return jsonResponse(await supabasePatch(env, "marketing_log", id, updates, userJwt), 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: problem-statements
// ════════════════════════════════════════════════════════════════════════════

async function getProblemStatements(env, userJwt, corsHeaders) {
  return jsonResponse(await supabaseFetch(env, "problem_statements", "?select=*&order=created_at.asc", userJwt), 200, corsHeaders);
}

async function createProblemStatement(request, env, userJwt, corsHeaders) {
  const { title, description, ideal_outcome } = await request.json();
  if (!title || !description || !ideal_outcome)
    return jsonResponse({ error: "title, description, and ideal_outcome are required" }, 400, corsHeaders);
  return jsonResponse(await supabasePost(env, "problem_statements", { title, description, ideal_outcome }, userJwt), 201, corsHeaders);
}

async function updateProblemStatement(request, env, id, userJwt, corsHeaders) {
  const body = await request.json();
  const updates = {};
  ["title","description","ideal_outcome","status"].forEach(k => { if (body[k] !== undefined) updates[k] = body[k]; });
  if (!Object.keys(updates).length) return jsonResponse({ error: "No valid fields to update" }, 400, corsHeaders);
  updates.updated_at = new Date().toISOString();
  return jsonResponse(await supabasePatch(env, "problem_statements", id, updates, userJwt), 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: deliverables
// ════════════════════════════════════════════════════════════════════════════

async function getDeliverables(request, env, userJwt, corsHeaders) {
  const problemId = new URL(request.url).searchParams.get("problem_id");
  const query = problemId
    ? `?problem_id=eq.${encodeURIComponent(problemId)}&select=*&order=session_date.desc,created_at.desc&limit=20`
    : "?select=*&order=session_date.desc,created_at.desc&limit=20";
  return jsonResponse(await supabaseFetch(env, "deliverables", query, userJwt), 200, corsHeaders);
}

async function createDeliverable(request, env, userJwt, corsHeaders) {
  const { problem_id, challenge, response, action_committed } = await request.json();
  if (!problem_id || !challenge) return jsonResponse({ error: "problem_id and challenge are required" }, 400, corsHeaders);
  return jsonResponse(await supabasePost(env, "deliverables", {
    problem_id, challenge, response: response ?? null, action_committed: action_committed ?? null,
  }, userJwt), 201, corsHeaders);
}

async function updateDeliverable(request, env, id, userJwt, corsHeaders) {
  const body = await request.json();
  const updates = {};
  ["observation","action_committed","response"].forEach(k => { if (body[k] !== undefined) updates[k] = body[k]; });
  if (!Object.keys(updates).length) return jsonResponse({ error: "No valid fields to update" }, 400, corsHeaders);
  return jsonResponse(await supabasePatch(env, "deliverables", id, updates, userJwt), 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: subscriptions

export { getMarketingLog, createMarketingLog, updateMarketingLog, getProblemStatements, createProblemStatement, updateProblemStatement, getDeliverables, createDeliverable, updateDeliverable };

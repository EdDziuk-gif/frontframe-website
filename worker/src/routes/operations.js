import { jsonResponse } from "../shared/http.js";
import { supabaseDelete, supabaseFetch, supabasePatch, supabasePatchByField, supabasePost, supabaseRpc, supabaseUpsert, supabaseHeaders } from "../shared/supabase.js";

// § DOMAIN: config
// ════════════════════════════════════════════════════════════════════════════

async function getConfig(env, userJwt, corsHeaders) {
  return jsonResponse((await supabaseFetch(env, "config", "?id=eq.1&select=*", userJwt))?.[0] ?? {}, 200, corsHeaders);
}

async function updateConfig(request, env, userJwt, corsHeaders) {
  const body = await request.json();
  const updates = {};
  ["mode","build_version","stage_gate","capture_enabled"].forEach(k => { if (body[k] !== undefined) updates[k] = body[k]; });
  if (!Object.keys(updates).length) return jsonResponse({ error: "No valid fields to update" }, 400, corsHeaders);
  updates.updated_at = new Date().toISOString();
  return jsonResponse(await supabaseUpsert(env, "config", { id: 1, ...updates }, userJwt), 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: defects
// ════════════════════════════════════════════════════════════════════════════

// defects CHECK constraints. A value outside these makes PostgREST 500;
// validate up front and 400 with the allowed set (Defect 2f57a6b5).
const DEFECT_AREAS = new Set(["bot", "ui", "content", "form", "payment", "contract", "other"]);
const DEFECT_SEVERITIES = new Set(["blocking", "major", "minor", "cosmetic"]);
const DEFECT_DISPOSITIONS = new Set(["retain", "delete"]);
const DEFECT_STATUSES = new Set(["open", "in_review", "resolved", "deferred"]);

function badDefectField(field, value, allowed, corsHeaders) {
  return jsonResponse(
    { error: `Invalid ${field} "${value}" (allowed: ${[...allowed].join(", ")})` }, 400, corsHeaders,
  );
}

async function getDefects(env, userJwt, corsHeaders) {
  return jsonResponse(await supabaseFetch(env, "defects", "?select=*&order=created_at.desc", userJwt), 200, corsHeaders);
}

async function createDefect(request, env, userJwt, corsHeaders) {
  const { area, description, severity, disposition = "retain" } = await request.json();
  if (!area || !description || !severity)
    return jsonResponse({ error: "area, description, and severity are required" }, 400, corsHeaders);
  if (!DEFECT_AREAS.has(area)) return badDefectField("area", area, DEFECT_AREAS, corsHeaders);
  if (!DEFECT_SEVERITIES.has(severity)) return badDefectField("severity", severity, DEFECT_SEVERITIES, corsHeaders);
  if (!DEFECT_DISPOSITIONS.has(disposition)) return badDefectField("disposition", disposition, DEFECT_DISPOSITIONS, corsHeaders);
  const config = (await supabaseFetch(env, "config", "?id=eq.1&select=build_version,stage_gate"))?.[0] ?? {};
  return jsonResponse(await supabasePost(env, "defects", {
    area, description, severity, disposition,
    build_version: config.build_version ?? "unknown", stage_gate: config.stage_gate ?? "build",
  }, userJwt), 201, corsHeaders);
}

async function updateDefect(request, env, id, userJwt, corsHeaders) {
  const body = await request.json();
  const updates = {};
  ["status","resolver_id","severity","disposition","description","area"].forEach(k => { if (body[k] !== undefined) updates[k] = body[k]; });
  if (!Object.keys(updates).length) return jsonResponse({ error: "No valid fields to update" }, 400, corsHeaders);
  if (updates.area !== undefined && !DEFECT_AREAS.has(updates.area)) return badDefectField("area", updates.area, DEFECT_AREAS, corsHeaders);
  if (updates.severity !== undefined && !DEFECT_SEVERITIES.has(updates.severity)) return badDefectField("severity", updates.severity, DEFECT_SEVERITIES, corsHeaders);
  if (updates.disposition !== undefined && !DEFECT_DISPOSITIONS.has(updates.disposition)) return badDefectField("disposition", updates.disposition, DEFECT_DISPOSITIONS, corsHeaders);
  if (updates.status !== undefined && !DEFECT_STATUSES.has(updates.status)) return badDefectField("status", updates.status, DEFECT_STATUSES, corsHeaders);
  return jsonResponse(await supabasePatch(env, "defects", id, updates, userJwt), 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: feedback
// ════════════════════════════════════════════════════════════════════════════

async function getFeedback(env, userJwt, corsHeaders) {
  return jsonResponse(await supabaseFetch(env, "feedback", "?select=*&order=created_at.desc", userJwt), 200, corsHeaders);
}

async function createFeedback(request, env, userJwt, corsHeaders) {
  const { question, ed_response, suggested_answer } = await request.json();
  if (!question) return jsonResponse({ error: "question is required" }, 400, corsHeaders);
  return jsonResponse(await supabasePost(env, "feedback", { question, ed_response, suggested_answer }, userJwt), 201, corsHeaders);
}

async function updateFeedback(request, env, id, userJwt, corsHeaders) {
  const body = await request.json();
  if (body.action === "promote") {
    const entry = (await supabaseFetch(env, "feedback", `?id=eq.${id}&select=question,suggested_answer,ed_response`, userJwt))?.[0];
    if (!entry) return jsonResponse({ error: "Not found" }, 404, corsHeaders);
    const answer = entry.suggested_answer || entry.ed_response || "";
    if (!answer) return jsonResponse({ error: "No answer to promote" }, 400, corsHeaders);
    const page = body.page || "all";
    await supabasePost(env, "qa_pairs", { question: entry.question, answer, page, source: "testing" }, userJwt);
    return jsonResponse(await supabasePatch(env, "feedback", id, { promoted: true }, userJwt), 200, corsHeaders);
  }
  if (body.action === "dismiss")
    return jsonResponse(await supabasePatch(env, "feedback", id, { suggested_answer: body.note || "[dismissed]" }, userJwt), 200, corsHeaders);

  const updates = {};
  ["suggested_answer","promoted"].forEach(k => { if (body[k] !== undefined) updates[k] = body[k]; });
  if (!Object.keys(updates).length) return jsonResponse({ error: "No valid fields to update" }, 400, corsHeaders);
  return jsonResponse(await supabasePatch(env, "feedback", id, updates, userJwt), 200, corsHeaders);
}

async function checkFeedbackConflicts(request, env, userJwt, corsHeaders) {
  if (!userJwt) return jsonResponse({ error: "Unauthorized" }, 401, corsHeaders);
  const { question, answer, page = "all" } = await request.json();
  if (!question || !answer) return jsonResponse({ error: "question and answer are required" }, 400, corsHeaders);

  const pagePromptRows = await supabaseFetch(env, "system_prompt", `?page=eq.${page}&select=content`, userJwt);
  const pagePrompt     = pagePromptRows?.[0]?.content || "";

  let globalPrompt = "";
  if (page !== "all") {
    const globalRows = await supabaseFetch(env, "system_prompt", `?page=eq.all&select=content`, userJwt);
    globalPrompt = globalRows?.[0]?.content || "";
  }

  const systemPromptContent = [globalPrompt, pagePrompt].filter(Boolean).join("\n\n") || "(none)";
  // Intentionally NOT filtered to status='implemented' (unlike buildQaPairsQuery
  // for live generation): a conflict check on a proposed pair must also see
  // draft / under_review rows so it can catch a clash against pending content.
  const pairsQuery = page === "all" ? `?page=eq.all&select=question,answer` : `?or=(page.eq.all,page.eq.${page})&select=question,answer`;
  const pairs      = await supabaseFetch(env, "qa_pairs", pairsQuery, userJwt) || [];
  const pagesChecked   = page === "all" ? ["all"] : ["all", page];
  const pairsText  = pairs.length ? pairs.map(p => `Q: ${p.question}\nA: ${p.answer}`).join("\n\n") : "(none)";
  const userMessage =
    `SYSTEM PROMPT FOR PAGE "${page}":\n${systemPromptContent}\n\n` +
    `EXISTING Q&A PAIRS (${pairs.length}):\n${pairsText}\n\n` +
    `PROPOSED NEW PAIR:\nQ: ${question}\nA: ${answer}\n\nCheck for conflicts.`;

  const fallback = { conflict: false, severity: "none", summary: "Check could not be completed.", details: [] };
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001", max_tokens: 400,
        system: `You are a quality reviewer for an AI assistant knowledge base. You check whether a proposed Q&A pair conflicts with existing instructions or established Q&A pairs for the same assistant.\n\nA conflict exists if:\n- The proposed answer directly contradicts something in the system prompt\n- The proposed answer contradicts an existing Q&A pair covering the same topic\n- The proposed answer introduces a policy, price, claim, or commitment that contradicts existing content\n\nRespond with valid JSON only:\n{\n  "conflict": true | false,\n  "severity": "blocking" | "minor" | "none",\n  "summary": "one sentence",\n  "details": ["specific conflict 1", "specific conflict 2"]\n}\nNo other text.`,
        messages: [{ role: "user", content: userMessage }],
      }),
    });
    if (!res.ok) return jsonResponse({ ...fallback, pairs_checked: pairs.length, pages_checked: pagesChecked }, 200, corsHeaders);
    const text = (await res.json()).content?.[0]?.text ?? "";
    let parsed;
    try { parsed = JSON.parse(text.replace(/```json|```/g, "").trim()); } catch { parsed = fallback; }
    return jsonResponse({ ...parsed, pairs_checked: pairs.length, pages_checked: pagesChecked }, 200, corsHeaders);
  } catch {
    return jsonResponse({ ...fallback, pairs_checked: pairs.length, pages_checked: pagesChecked }, 200, corsHeaders);
  }
}


// ════════════════════════════════════════════════════════════════════════════

export { getConfig, updateConfig, getDefects, createDefect, updateDefect, getFeedback, createFeedback, updateFeedback, checkFeedbackConflicts };

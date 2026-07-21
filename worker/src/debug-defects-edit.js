/**
 * debug-defects-edit.js
 * FrontFrame Debug System — Worker Module
 *
 * Feature: Defect edit — PATCH /admin/defects/:id
 *
 * ACTIVATION (add to src/index.js):
 * ------------------------------------------------------------------
 * // TOP OF FILE — add with other imports:
 * // [DEBUG:defects-edit] — remove these 2 lines to end debug session
 * import { handleUpdateDefect } from './debug-defects-edit.js';
 *
 * // DISPATCH BLOCK — place immediately BEFORE the production line:
 * //   if (method === "PATCH" && defectMatch) return await updateDefect(...)
 * if (method === "PATCH" && defectMatch) return await handleUpdateDefect(request, env, defectMatch[1], userJwt, corsHeaders);
 * ------------------------------------------------------------------
 *
 * DEACTIVATION: delete the 2 lines above. This file stays in the repo.
 *
 * OUTPUT: Cloudflare dashboard → Workers & Pages → frontframe-worker → Logs → Begin log stream
 *
 * BUG CONTEXT:
 * The Edit button in the Defects panel renders onclick="openDefectModal(${d.id})"
 * without quoting d.id. If d.id is a UUID the onclick is invalid JS and silently
 * fails before any network request fires. This module verifies whether PATCH
 * requests are arriving at all, and logs full request/response detail once the
 * HTML-side onclick is fixed (quote d.id: openDefectModal('${d.id}')).
 */

const TAG = "[DEBUG defects-edit]";

function jsonResponse(body, status, headers) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json" }, headers || {}),
  });
}

// ---------------------------------------------------------------------------
// PATCH /admin/defects/:id — verbose debug handler
// ---------------------------------------------------------------------------

export async function handleUpdateDefect(request, env, id, userJwt, corsHeaders) {
  console.log(TAG + " ── PATCH /admin/defects/:id handler entered");
  console.log(TAG + " id received: " + id);
  console.log(TAG + " id type check — UUID format: " + /^[0-9a-f-]{36}$/i.test(id));
  console.log(TAG + " id type check — integer format: " + /^\d+$/.test(id));

  // JWT check — presence only, never log the value
  const jwtPresent = !!userJwt;
  const jwtLength  = userJwt ? userJwt.length : 0;
  console.log(TAG + " JWT present: " + jwtPresent + "  length: " + jwtLength);

  // Parse body
  let body;
  try {
    body = await request.json();
  } catch (e) {
    console.error(TAG + " Failed to parse request body: " + e.message);
    return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders);
  }

  // Log fields present — log description length, not content (may be long)
  const fields = ["status", "resolver_id", "severity", "disposition", "description", "area"];
  const received = fields.filter(k => body[k] !== undefined);
  console.log(TAG + " Fields in body: " + JSON.stringify(received));
  if (body.area        !== undefined) console.log(TAG + " area: " + body.area);
  if (body.severity    !== undefined) console.log(TAG + " severity: " + body.severity);
  if (body.status      !== undefined) console.log(TAG + " status: " + body.status);
  if (body.disposition !== undefined) console.log(TAG + " disposition: " + body.disposition);
  if (body.description !== undefined) console.log(TAG + " description length: " + body.description.length);

  // Build updates (same whitelist as production handler)
  const updates = {};
  fields.forEach(k => { if (body[k] !== undefined) updates[k] = body[k]; });

  if (!Object.keys(updates).length) {
    console.error(TAG + " No valid fields to update — returning 400");
    return jsonResponse({ error: "No valid fields to update" }, 400, corsHeaders);
  }

  console.log(TAG + " Update keys being sent to Supabase: " + JSON.stringify(Object.keys(updates)));

  // SUPABASE_URL present check
  console.log(TAG + " SUPABASE_URL present: " + !!env.SUPABASE_URL);
  console.log(TAG + " SUPABASE_SERVICE_ROLE_KEY present: " + !!env.SUPABASE_SERVICE_ROLE_KEY);

  const patchUrl = env.SUPABASE_URL + "/rest/v1/defects?id=eq." + id;
  console.log(TAG + " Supabase PATCH URL: " + patchUrl);

  let res;
  try {
    res = await fetch(patchUrl, {
      method: "PATCH",
      headers: {
        "Content-Type":  "application/json",
        "apikey":        env.SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY,
        "Prefer":        "return=representation",
      },
      body: JSON.stringify(updates),
    });
  } catch (e) {
    console.error(TAG + " Fetch to Supabase threw: " + e.message);
    return jsonResponse({ error: "Network error calling Supabase: " + e.message }, 500, corsHeaders);
  }

  console.log(TAG + " Supabase PATCH response status: " + res.status + " " + res.statusText);
  const resText = await res.text();
  console.log(TAG + " Supabase PATCH response body: " + resText);

  if (!res.ok) {
    return jsonResponse({ error: "Supabase PATCH defects failed: " + resText }, res.status, corsHeaders);
  }

  let data;
  try {
    data = JSON.parse(resText);
  } catch (e) {
    console.error(TAG + " Failed to parse Supabase response: " + e.message);
    return jsonResponse({ error: "Unexpected response from Supabase" }, 500, corsHeaders);
  }

  const rowCount = Array.isArray(data) ? data.length : "non-array";
  console.log(TAG + " Supabase returned row count: " + rowCount);

  if (rowCount === 0) {
    console.warn(TAG + " WARNING: PATCH matched 0 rows — id '" + id + "' not found in defects table");
  } else {
    console.log(TAG + " PATCH succeeded");
  }

  return jsonResponse(data, 200, corsHeaders);
}

import { jsonResponse } from "../shared/http.js";
import { supabaseDelete, supabaseFetch, supabasePatch, supabasePatchByField, supabasePost, supabaseRpc, supabaseUpsert, supabaseHeaders } from "../shared/supabase.js";
import { hashIp, sendSms } from "../shared/runtime.js";

// § DOMAIN: qa
// ════════════════════════════════════════════════════════════════════════════

// qa_pairs.status has a DB CHECK constraint; page has no constraint but a
// typo silently means the pair is never served. Validate both here so a bad
// value returns an actionable 400 instead of an opaque PostgREST 500
// (Defect 2f57a6b5 / the "Failed to fetch" on saving status=dismissed).
const QA_STATUSES = new Set(["under_review", "redundant", "implemented"]);
const QA_PAGES = new Set(["all", "home", "yours", "discovery", "intake", "resources", "admin", "ADVISOR", "proposal"]);

function badQaField(field, value, allowed, corsHeaders) {
  return jsonResponse(
    { error: `Invalid ${field} "${value}" (allowed: ${[...allowed].join(", ")})` },
    400, corsHeaders,
  );
}

async function getQaPairs(env, corsHeaders) {
  return jsonResponse(await supabaseFetch(env, "qa_pairs",
    "?select=id,question,answer,page,status,source,created_at&order=created_at.asc"), 200, corsHeaders);
}

async function createQaPair(request, env, corsHeaders) {
  const { question, answer, page = "all", status } = await request.json();
  if (!question || !answer) return jsonResponse({ error: "question and answer are required" }, 400, corsHeaders);
  if (!QA_PAGES.has(page)) return badQaField("page", page, QA_PAGES, corsHeaders);
  if (status !== undefined && !QA_STATUSES.has(status)) return badQaField("status", status, QA_STATUSES, corsHeaders);
  const row = { question, answer, page };
  if (status !== undefined) row.status = status;
  return jsonResponse(await supabasePost(env, "qa_pairs", row), 201, corsHeaders);
}

async function updateQaPair(request, env, id, corsHeaders) {
  const body = await request.json();
  const updates = {};
  ["question","answer","page","status"].forEach(k => { if (body[k] !== undefined) updates[k] = body[k]; });
  if (!Object.keys(updates).length) return jsonResponse({ error: "No fields to update" }, 400, corsHeaders);
  if (updates.page !== undefined && !QA_PAGES.has(updates.page)) return badQaField("page", updates.page, QA_PAGES, corsHeaders);
  if (updates.status !== undefined && !QA_STATUSES.has(updates.status)) return badQaField("status", updates.status, QA_STATUSES, corsHeaders);
  return jsonResponse(await supabasePatch(env, "qa_pairs", id, updates), 200, corsHeaders);
}

async function deleteQaPair(env, id, corsHeaders) {
  await supabaseDelete(env, "qa_pairs", id);
  return jsonResponse({ deleted: id }, 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: proposal
// ════════════════════════════════════════════════════════════════════════════

async function getProposal(request, env, corsHeaders) {
  const token = new URL(request.url).searchParams.get("token");
  if (!token) return jsonResponse({ error: "token is required" }, 400, corsHeaders);

  const accessRows = await supabaseFetch(env, "proposal_access",
    `?token=eq.${encodeURIComponent(token)}&select=access_id,proposal_id,expires_at,accessed_at`);
  if (!accessRows?.length) return jsonResponse({ error: "Invalid or expired link" }, 404, corsHeaders);

  const access = accessRows[0];
  if (access.expires_at && new Date(access.expires_at) < new Date())
    return jsonResponse({ error: "This link has expired" }, 410, corsHeaders);

  if (!access.accessed_at) {
    const ip = request.headers.get("CF-Connecting-IP") ?? "";
    supabasePatchByField(env, "proposal_access", "access_id", access.access_id,
      { accessed_at: new Date().toISOString(), ip_hash: ip ? await hashIp(ip) : null })
      .catch((e) => console.error("proposal_access stamp failed:", e));
  }

  const proposalRows = await supabaseFetch(env, "proposals",
    `?proposal_id=eq.${access.proposal_id}&select=proposal_id,prospect_name,status,version`);
  if (!proposalRows?.length) return jsonResponse({ error: "Proposal not found" }, 404, corsHeaders);

  const proposal = proposalRows[0];
  const sections = await supabaseFetch(env, "proposal_sections",
    `?proposal_id=eq.${access.proposal_id}&client_visible=eq.true&select=section_id,sort_order,title,content&order=sort_order.asc`);

  return jsonResponse({
    proposal_id: proposal.proposal_id, prospect_name: proposal.prospect_name,
    status: proposal.status, version: proposal.version, sections: sections ?? [],
  }, 200, corsHeaders);
}

async function submitProposalReview(request, env, ctx, corsHeaders) {
  const body = await request.json();
  const { token, proposal_id, overall_status, overall_comment = "", section_responses = [] } = body;
  if (!token || !proposal_id) return jsonResponse({ error: "token and proposal_id are required" }, 400, corsHeaders);

  const accessRows = await supabaseFetch(env, "proposal_access",
    `?token=eq.${encodeURIComponent(token)}&proposal_id=eq.${proposal_id}&select=access_id,expires_at`);
  if (!accessRows?.length) return jsonResponse({ error: "Invalid token" }, 403, corsHeaders);
  if (accessRows[0].expires_at && new Date(accessRows[0].expires_at) < new Date())
    return jsonResponse({ error: "This link has expired" }, 410, corsHeaders);

  await Promise.all(section_responses.map((s) =>
    supabasePatchByField(env, "proposal_sections", "section_id", s.section_id,
      { client_comment: s.comment ?? null, flagged: s.flagged ?? false })
      .catch((e) => console.error(`section patch failed for ${s.section_id}:`, e))
  ));
  await supabasePatchByField(env, "proposals", "proposal_id", proposal_id,
    { status: "under_review", reviewed_at: new Date().toISOString() });

  const proposalRows  = await supabaseFetch(env, "proposals", `?proposal_id=eq.${proposal_id}&select=prospect_name,version`);
  const proposal      = proposalRows?.[0] ?? { prospect_name: "Prospect", version: 1 };
  const flaggedCount  = section_responses.filter((s) => s.flagged).length;
  const statusLabels  = { ready: "Ready to move forward", questions: "Has questions", changes: "Requesting changes" };

  const smsMessage =
    `FrontFrame proposal review\nProspect: ${proposal.prospect_name}\nVersion: ${proposal.version}\n` +
    `Status: ${statusLabels[overall_status] ?? overall_status}\n` +
    (flaggedCount > 0 ? `Flagged sections: ${flaggedCount}\n` : "") +
    (overall_comment ? `Note: "${overall_comment.slice(0, 80)}${overall_comment.length > 80 ? "..." : ""}"` : "");

  ctx.waitUntil(sendSms(env, smsMessage).catch((e) => console.error("proposal review SMS failed:", e)));
  return jsonResponse({ received: true }, 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: podcast-episodes
// ════════════════════════════════════════════════════════════════════════════

async function getPodcastEpisodes(env, corsHeaders) {
  return jsonResponse(await supabaseFetch(env, "podcast_episodes",
    "?visible=eq.true&select=id,series,title,transcript,audio_path,published_at&order=published_at.desc"), 200, corsHeaders);
}

async function adminGetPodcastEpisodes(env, userJwt, corsHeaders) {
  return jsonResponse(await supabaseFetch(env, "podcast_episodes", "?select=*&order=published_at.desc", userJwt), 200, corsHeaders);
}

async function createPodcastEpisode(request, env, userJwt, corsHeaders) {
  const { series, title, transcript, audio_path, published_at, visible = true } = await request.json();
  if (!series || !title) return jsonResponse({ error: "series and title are required" }, 400, corsHeaders);
  return jsonResponse(await supabasePost(env, "podcast_episodes", {
    series, title, transcript: transcript ?? null, audio_path: audio_path ?? null,
    published_at: published_at ?? new Date().toISOString().split("T")[0], visible,
  }, userJwt), 201, corsHeaders);
}

async function updatePodcastEpisode(request, env, id, userJwt, corsHeaders) {
  const body = await request.json();
  const updates = {};
  ["series","title","transcript","audio_path","published_at","visible"].forEach(k => { if (body[k] !== undefined) updates[k] = body[k]; });
  if (!Object.keys(updates).length) return jsonResponse({ error: "No valid fields to update" }, 400, corsHeaders);
  return jsonResponse(await supabasePatch(env, "podcast_episodes", id, updates, userJwt), 200, corsHeaders);
}

async function deletePodcastEpisode(env, id, userJwt, corsHeaders) {
  await supabaseDelete(env, "podcast_episodes", id);
  return jsonResponse({ deleted: id }, 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: rss-proxy
// ════════════════════════════════════════════════════════════════════════════

async function handleRssProxy(request, corsHeaders) {
  const targetUrl = new URL(request.url).searchParams.get("url");
  if (!targetUrl) return jsonResponse({ error: "url parameter required" }, 400, corsHeaders);

  let parsed;
  try { parsed = new URL(targetUrl); }
  catch { return jsonResponse({ error: "Invalid URL" }, 400, corsHeaders); }

  if (!["http:", "https:"].includes(parsed.protocol))
    return jsonResponse({ error: "Only http/https URLs allowed" }, 400, corsHeaders);

  try {
    const res = await fetch(targetUrl, {
      headers: {
        "User-Agent": "FrontFrame Advisor Intel/1.0 (RSS reader; +https://frontframe.co)",
        "Accept":     "application/rss+xml, application/atom+xml, application/xml, text/xml, */*",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return new Response(`Upstream error: ${res.status}`, { status: res.status, headers: corsHeaders });
    return new Response(await res.text(), {
      status: 200,
      headers: { ...corsHeaders, "Content-Type": "text/xml; charset=utf-8", "Cache-Control": "public, max-age=900" },
    });
  } catch (err) {
    console.warn("rss-proxy fetch failed:", targetUrl, err.message);
    return new Response(`Fetch failed: ${err.message}`, { status: 502, headers: corsHeaders });
  }
}


// ════════════════════════════════════════════════════════════════════════════

export { getQaPairs, createQaPair, updateQaPair, deleteQaPair, getProposal, submitProposalReview, getPodcastEpisodes, adminGetPodcastEpisodes, createPodcastEpisode, updatePodcastEpisode, deletePodcastEpisode, handleRssProxy };

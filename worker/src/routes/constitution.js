import { createHash } from "node:crypto";
import { jsonResponse } from "../shared/http.js";
import {
  supabaseFetch, supabasePost, supabasePatch, supabaseRpc,
} from "../shared/supabase.js";
import { sendSms } from "../shared/runtime.js";

// § DOMAIN: constitution
// ════════════════════════════════════════════════════════════════════════════

const VALID_SOURCE_TYPES = new Set([
  "Staff", "Operator", "Delegate", "assistant", "outside_resource",
]);

const PROPOSAL_REQUIRED_FIELDS = [
  "constitutional_matter", "factual_context", "material_assumptions",
  "proposed_decision", "proposed_resulting_text",
  "interactions_with_other_provisions", "no_conflict_explanation",
];

const PROPOSAL_DRAFT_MUTABLE = [
  "constitutional_matter", "factual_context", "material_assumptions",
  "proposed_decision", "proposed_provision_title", "affected_provision_number",
  "expected_preceding_text", "proposed_resulting_text",
  "interactions_with_other_provisions", "no_conflict_explanation",
  "source_type", "submitted_by",
];

const INCIDENT_STATUS_VALUES = new Set(["open", "reviewed", "resolved"]);

// Maps attempted_action values to safe, system-controlled SMS text.
// Raw attacker-supplied strings are never interpolated into SMS messages.
const ACTION_CATEGORIES = {
  promulgate_amendment: "constitutional promulgation",
  return_proposal:      "proposal return",
  reject_proposal:      "proposal rejection",
};

// One SMS per fingerprint per hour.
const INCIDENT_SMS_TTL_S = 3600;

// ── Reviewer authority ─────────────────────────────────────────────────────

// Returns { id, email, role, canAmendConstitution } for a valid active reviewer,
// or null on any auth failure. Checks can_amend_constitution via reviewer_roles
// → roles join rather than relying on the reviewers.role string alone, since
// the roles table is the authoritative source for constitutional authority.
export async function getReviewerAuthority(env, jwt) {
  if (!jwt) return null;

  const userRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: {
      apikey: env.SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${jwt}`,
    },
  });
  if (!userRes.ok) return null;

  const user = await userRes.json();
  const email = user?.email;
  if (!email) return null;

  const reviewerRows = await supabaseFetch(
    env, "reviewers",
    `?select=id,role,active&email=eq.${encodeURIComponent(email)}`,
  );
  const reviewer = reviewerRows?.[0];
  if (!reviewer?.active) return null;

  const roleRows = await supabaseFetch(
    env, "reviewer_roles",
    `?reviewer_id=eq.${reviewer.id}&select=roles(can_amend_constitution)`,
  );
  const canAmendConstitution =
    roleRows?.some((rr) => rr.roles?.can_amend_constitution === true) ?? false;

  return { id: reviewer.id, email, role: reviewer.role, canAmendConstitution };
}

// ── Authorization incident recording ──────────────────────────────────────

export function computeFingerprint(attemptedAction, targetObject, actor) {
  return createHash("sha256")
    .update(`${attemptedAction}|${targetObject}|${actor ?? "anonymous"}`)
    .digest("hex");
}

// Records a denied privileged action: DB incident (atomic upsert via RPC)
// + rate-limited SMS to Operator. Never surfaces raw caller-supplied strings
// in the SMS body. Best-effort — never alters the 403 response path.
export async function recordDeniedAction(env, ctx, {
  actingReviewerId,
  actingIdentityText,
  attemptedAction,
  targetObject,
  denialReason,
}) {
  const actor = actingReviewerId ?? actingIdentityText ?? "anonymous";
  const fingerprint = computeFingerprint(attemptedAction, targetObject, actor);

  ctx.waitUntil((async () => {
    try {
      const result = await supabaseRpc(env, "record_authorization_incident", {
        p_acting_reviewer_id:   actingReviewerId ?? null,
        p_acting_identity_text: actingIdentityText ?? null,
        p_attempted_action:     attemptedAction,
        p_target_object:        targetObject,
        p_denial_reason:        denialReason,
        p_fingerprint:          fingerprint,
      });

      if (!env.RATE_LIMIT_KV) return;
      const smsKey = `incident_sms:${fingerprint}`;
      const alreadySent = await env.RATE_LIMIT_KV.get(smsKey);
      if (alreadySent) return;

      // SMS content: only system-controlled strings, never raw caller input.
      const category = ACTION_CATEGORIES[attemptedAction] ?? "privileged action";
      const count = result?.occurrence_count ?? 1;
      await sendSms(
        env,
        `FrontFrame authorization incident\nAction: ${category}\nRef: ${fingerprint.slice(0, 12)}\nOccurrences: ${count}`,
      );
      await env.RATE_LIMIT_KV.put(smsKey, "1", { expirationTtl: INCIDENT_SMS_TTL_S });
    } catch (e) {
      console.error("recordDeniedAction failed:", e);
    }
  })());
}

// ── Proposal handlers ──────────────────────────────────────────────────────

export async function createProposal(request, env, jwt, corsHeaders) {
  // Resolve submitter server-side; never accept submitted_by from the body.
  const authority = await getReviewerAuthority(env, jwt);

  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: "Invalid JSON" }, 400, corsHeaders);

  const {
    constitutional_matter, factual_context, material_assumptions,
    proposed_decision, proposed_provision_title, affected_provision_number,
    expected_preceding_text, proposed_resulting_text,
    interactions_with_other_provisions, no_conflict_explanation,
    source_type,
  } = body;

  const missingRequired = PROPOSAL_REQUIRED_FIELDS.filter((f) => !body[f]?.trim?.());
  if (missingRequired.length || !source_type) {
    return jsonResponse(
      { error: `Missing required fields: ${[...missingRequired, ...(!source_type ? ["source_type"] : [])].join(", ")}` },
      400, corsHeaders,
    );
  }

  if (!VALID_SOURCE_TYPES.has(source_type)) {
    return jsonResponse(
      { error: `Invalid source_type. Must be one of: ${[...VALID_SOURCE_TYPES].join(", ")}` },
      400, corsHeaders,
    );
  }

  // For a new provision (no provision number supplied), a title is required.
  const isNewProvision = !affected_provision_number;
  if (isNewProvision && !proposed_provision_title?.trim()) {
    return jsonResponse(
      { error: "proposed_provision_title is required when affected_provision_number is not supplied" },
      400, corsHeaders,
    );
  }

  const row = await supabasePost(env, "constitution_amendment_proposals", {
    constitutional_matter,
    factual_context,
    material_assumptions,
    proposed_decision,
    proposed_provision_title:           proposed_provision_title ?? null,
    affected_provision_number:          affected_provision_number ?? null,
    expected_preceding_text:            expected_preceding_text ?? null,
    proposed_resulting_text,
    interactions_with_other_provisions,
    no_conflict_explanation,
    source_type,
    submitted_by:                       authority?.id ?? null,
    status:                             "draft",
  });
  return jsonResponse(row, 201, corsHeaders);
}

export async function listProposals(env, jwt, corsHeaders) {
  const rows = await supabaseFetch(
    env, "constitution_amendment_proposals",
    "?select=*&order=created_at.desc",
  );
  return jsonResponse(rows ?? [], 200, corsHeaders);
}

export async function getProposal(env, id, jwt, corsHeaders) {
  const rows = await supabaseFetch(
    env, "constitution_amendment_proposals",
    `?id=eq.${encodeURIComponent(id)}&select=*`,
  );
  if (!rows?.length) return jsonResponse({ error: "Not found" }, 404, corsHeaders);
  return jsonResponse(rows[0], 200, corsHeaders);
}

export async function updateProposal(request, env, id, jwt, corsHeaders) {
  const existing = await supabaseFetch(
    env, "constitution_amendment_proposals",
    `?id=eq.${encodeURIComponent(id)}&select=status`,
  );
  if (!existing?.length) return jsonResponse({ error: "Not found" }, 404, corsHeaders);
  if (!["draft", "returned"].includes(existing[0].status)) {
    return jsonResponse(
      { error: `Only draft or returned proposals may be updated; current status is '${existing[0].status}'` },
      409, corsHeaders,
    );
  }

  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: "Invalid JSON" }, 400, corsHeaders);

  const updates = { updated_at: new Date().toISOString() };
  PROPOSAL_DRAFT_MUTABLE.forEach((k) => { if (k in body) updates[k] = body[k]; });
  if (Object.keys(updates).length === 1) {
    return jsonResponse({ error: "No valid fields to update" }, 400, corsHeaders);
  }
  if (updates.source_type && !VALID_SOURCE_TYPES.has(updates.source_type)) {
    return jsonResponse({ error: "Invalid source_type" }, 400, corsHeaders);
  }

  const rows = await supabasePatch(env, "constitution_amendment_proposals", id, updates);
  return jsonResponse(rows, 200, corsHeaders);
}

export async function submitProposal(request, env, id, jwt, corsHeaders) {
  const existing = await supabaseFetch(
    env, "constitution_amendment_proposals",
    `?id=eq.${encodeURIComponent(id)}&select=*`,
  );
  if (!existing?.length) return jsonResponse({ error: "Not found" }, 404, corsHeaders);

  const proposal = existing[0];
  if (proposal.status !== "draft") {
    return jsonResponse(
      { error: `Cannot submit: current status is '${proposal.status}'` },
      409, corsHeaders,
    );
  }

  const incomplete = PROPOSAL_REQUIRED_FIELDS.filter((f) => !proposal[f]?.trim?.());
  if (incomplete.length) {
    return jsonResponse(
      { error: `Proposal is missing required fields before submission: ${incomplete.join(", ")}` },
      422, corsHeaders,
    );
  }

  const rows = await supabasePatch(env, "constitution_amendment_proposals", id, {
    status:     "pending_review",
    updated_at: new Date().toISOString(),
  });
  return jsonResponse(rows, 200, corsHeaders);
}

export async function reopenProposal(request, env, id, jwt, corsHeaders) {
  const existing = await supabaseFetch(
    env, "constitution_amendment_proposals",
    `?id=eq.${encodeURIComponent(id)}&select=status`,
  );
  if (!existing?.length) return jsonResponse({ error: "Not found" }, 404, corsHeaders);
  if (existing[0].status !== "returned") {
    return jsonResponse(
      { error: `Cannot reopen: current status is '${existing[0].status}'` },
      409, corsHeaders,
    );
  }

  const rows = await supabasePatch(env, "constitution_amendment_proposals", id, {
    status:     "draft",
    updated_at: new Date().toISOString(),
  });
  return jsonResponse(rows, 200, corsHeaders);
}

export async function returnProposal(request, env, ctx, id, jwt, corsHeaders) {
  const authority = await getReviewerAuthority(env, jwt);
  if (!authority?.canAmendConstitution) {
    await recordDeniedAction(env, ctx, {
      actingReviewerId:   authority?.id ?? null,
      actingIdentityText: authority?.email ?? null,
      attemptedAction:    "return_proposal",
      targetObject:       `constitution_amendment_proposals:${id}`,
      denialReason:       "Insufficient authority: can_amend_constitution required",
    });
    return jsonResponse({ error: "Operator authority required" }, 403, corsHeaders);
  }

  const existing = await supabaseFetch(
    env, "constitution_amendment_proposals",
    `?id=eq.${encodeURIComponent(id)}&select=status`,
  );
  if (!existing?.length) return jsonResponse({ error: "Not found" }, 404, corsHeaders);
  if (existing[0].status !== "pending_review") {
    return jsonResponse(
      { error: `Cannot return: current status is '${existing[0].status}'` },
      409, corsHeaders,
    );
  }

  const body = await request.json().catch(() => ({}));
  const rows = await supabasePatch(env, "constitution_amendment_proposals", id, {
    status:       "returned",
    review_notes: body.review_notes ?? null,
    reviewed_by:  authority.id,
    returned_at:  new Date().toISOString(),
    updated_at:   new Date().toISOString(),
  });
  return jsonResponse(rows, 200, corsHeaders);
}

export async function rejectProposal(request, env, ctx, id, jwt, corsHeaders) {
  const authority = await getReviewerAuthority(env, jwt);
  if (!authority?.canAmendConstitution) {
    await recordDeniedAction(env, ctx, {
      actingReviewerId:   authority?.id ?? null,
      actingIdentityText: authority?.email ?? null,
      attemptedAction:    "reject_proposal",
      targetObject:       `constitution_amendment_proposals:${id}`,
      denialReason:       "Insufficient authority: can_amend_constitution required",
    });
    return jsonResponse({ error: "Operator authority required" }, 403, corsHeaders);
  }

  const existing = await supabaseFetch(
    env, "constitution_amendment_proposals",
    `?id=eq.${encodeURIComponent(id)}&select=status`,
  );
  if (!existing?.length) return jsonResponse({ error: "Not found" }, 404, corsHeaders);
  if (existing[0].status !== "pending_review") {
    return jsonResponse(
      { error: `Cannot reject: current status is '${existing[0].status}'` },
      409, corsHeaders,
    );
  }

  const body = await request.json().catch(() => ({}));
  const rows = await supabasePatch(env, "constitution_amendment_proposals", id, {
    status:       "rejected",
    review_notes: body.review_notes ?? null,
    reviewed_by:  authority.id,
    rejected_at:  new Date().toISOString(),
    updated_at:   new Date().toISOString(),
  });
  return jsonResponse(rows, 200, corsHeaders);
}

export async function promulgateProposal(request, env, ctx, id, jwt, corsHeaders) {
  const authority = await getReviewerAuthority(env, jwt);
  if (!authority?.canAmendConstitution) {
    await recordDeniedAction(env, ctx, {
      actingReviewerId:   authority?.id ?? null,
      actingIdentityText: authority?.email ?? null,
      attemptedAction:    "promulgate_amendment",
      targetObject:       `constitution_amendment_proposals:${id}`,
      denialReason:       "Insufficient authority: can_amend_constitution required",
    });
    return jsonResponse({ error: "Operator authority required" }, 403, corsHeaders);
  }

  let result;
  try {
    result = await supabaseRpc(env, "promulgate_constitutional_amendment", {
      p_proposal_id: Number(id),
      p_operator_id: authority.id,
    });
  } catch (e) {
    const msg = String(e.message ?? "");
    if (msg.includes("stale_text")) {
      return jsonResponse(
        { error: "Stale text: the provision was modified after this proposal was drafted. Update expected_preceding_text to the current text and resubmit." },
        409, corsHeaders,
      );
    }
    if (msg.includes("proposal_not_found")) {
      return jsonResponse({ error: "Proposal not found" }, 404, corsHeaders);
    }
    if (msg.includes("proposal_not_pending")) {
      return jsonResponse({ error: "Proposal is not in pending_review status" }, 409, corsHeaders);
    }
    if (msg.includes("provision_not_found")) {
      return jsonResponse({ error: "Referenced provision number not found" }, 404, corsHeaders);
    }
    throw e;
  }
  return jsonResponse(result, 200, corsHeaders);
}

// ── Amendment and provision read handlers ─────────────────────────────────

export async function listAmendments(env, jwt, corsHeaders) {
  const rows = await supabaseFetch(
    env, "constitution_amendments",
    "?select=*&order=promulgated_at.desc",
  );
  return jsonResponse(rows ?? [], 200, corsHeaders);
}

export async function listProvisions(env, jwt, corsHeaders) {
  const rows = await supabaseFetch(
    env, "constitution_provisions",
    "?select=*&order=provision_number.asc",
  );
  return jsonResponse(rows ?? [], 200, corsHeaders);
}

// ── Authorization incident handlers ───────────────────────────────────────

export async function listAuthorizationIncidents(env, jwt, corsHeaders) {
  const rows = await supabaseFetch(
    env, "authorization_incidents",
    "?select=*&order=last_occurred_at.desc",
  );
  return jsonResponse(rows ?? [], 200, corsHeaders);
}

export async function updateAuthorizationIncident(request, env, id, jwt, corsHeaders) {
  const body = await request.json().catch(() => null);
  if (!body) return jsonResponse({ error: "Invalid JSON" }, 400, corsHeaders);

  const updates = {};
  ["status", "resolution_notes", "resolved_by", "resolved_at"].forEach((k) => {
    if (k in body) updates[k] = body[k];
  });
  if (!Object.keys(updates).length) {
    return jsonResponse({ error: "No valid fields to update" }, 400, corsHeaders);
  }
  if (updates.status && !INCIDENT_STATUS_VALUES.has(updates.status)) {
    return jsonResponse({ error: "Invalid status value" }, 400, corsHeaders);
  }

  const rows = await supabasePatch(env, "authorization_incidents", id, updates);
  return jsonResponse(rows, 200, corsHeaders);
}

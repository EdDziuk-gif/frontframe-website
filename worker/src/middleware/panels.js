import { supabaseFetch } from "../shared/supabase.js";

// Panel-scoped route authorization.
//
// admin_panels holds one row per TAB per panel file, keyed (panel_file, key).
// reviewer_permissions grants a reviewer a specific tab. But authorization has
// to happen on ROUTES, not tabs: hiding a tab client-side is cosmetic, and the
// routes behind it still answer anyone who asks. This module is the bridge -
// it says which panel each route belongs to, so a reviewer's tab grants can be
// enforced at the request boundary.
//
// Decided 2026-09-28 (Operator): deny-by-default. A reviewer reaches only the
// routes behind panels they have been granted. An unmapped route denies rather
// than leaks - see panelForRoutePath below.

// The Operator holds every panel implicitly and is never checked against this.
export const OPERATOR_BASELINE_ROLE = "frontframe_operator";

// Route group -> panel. The group is the second path segment of an /admin/*
// route (/admin/lead-alerts/:id -> "lead-alerts"). Every group maps to exactly
// one panel; groups a panel shares are listed against that panel's key.
//
// Verified against the actual UI callers in public/admin.html rather than
// inferred from names - notably: agreements/payments/proposals are all driven
// from the Pipeline tab, review-queue from the Feedback tab's Review Queue
// card, admin-panels from the Reviewers tab's permissions modal, and vault
// from inside the Subscriptions tab (vendor credential notes and card
// entries), which is why Subscriptions is Operator-only.
const ROUTE_GROUP_TO_PANEL = {
  // Pipeline
  "leads": "admin.html:pipeline",
  "lead-alerts": "admin.html:pipeline",
  "agreements": "admin.html:pipeline",
  "payments": "admin.html:pipeline",
  "proposals": "admin.html:pipeline",
  // Outreach
  "outreach": "admin.html:outreach",
  // Feedback (includes the Review Queue card)
  "feedback": "admin.html:feedback",
  "review-queue": "admin.html:review-queue-alias",
  // Knowledge
  "kgr-cases": "admin.html:kgr-cases",
  "kgr-hypotheses": "admin.html:kgr-cases",
  "gap-resolution-requests": "admin.html:gap-queue",
  // Single-group panels
  "defects": "admin.html:defects",
  "constitution": "admin.html:constitution",
  "authorization-incidents": "admin.html:auth-incidents",
  "system-prompt": "admin.html:system-prompt",
  "config": "admin.html:config",
  // Subscriptions - also guards the credential vault
  "subscriptions": "admin.html:subscriptions",
  "vault": "admin.html:subscriptions",
  // Office Hours
  "blackout": "admin.html:office-hours",
  "bookings": "admin.html:office-hours",
  // Reviewers - admin-panels feeds the permissions editor
  "reviewers": "admin.html:reviewers",
  "admin-panels": "admin.html:reviewers",
  // Dev Tools (Operator-only in practice; listed so the mapping is complete)
  "changelog": "dev-admin.html:changelog",
  "podcast-episodes": "dev-admin.html:episodes",
};

// review-queue shares the Feedback tab but admin_panels has no row of its own
// for it, so it resolves to Feedback.
const PANEL_ALIASES = {
  "admin.html:review-queue-alias": "admin.html:feedback",
};

// Protected routes outside /admin/*, mapped explicitly (see
// ADMIN_EXTRA_PROTECTED_PATHS in auth.js).
const EXTRA_PATH_TO_PANEL = {
  "/qa": "admin.html:qa",
  "/api/office-hours/schedule": "admin.html:office-hours",
  "/api/office-hours/schedule/:day": "admin.html:office-hours",
  "/api/office-hours/overrides": "admin.html:office-hours",
  "/api/office-hours/overrides/:date": "admin.html:office-hours",
  "/api/rd-log": "dev-admin.html:rd-log",
  "/api/rd-log/:id": "dev-admin.html:rd-log",
};

// Reachable by any active reviewer regardless of grants. /admin/me is how a
// panel discovers who the caller is before it can render anything, so gating
// it would lock out every non-Operator at boot.
const ALWAYS_ALLOWED_PATHS = new Set(["/admin/me"]);

// Returns the panel a route belongs to, "ALWAYS" for the boot route, or null
// when the route is unmapped. A null result denies for non-Operators: a route
// nobody has assigned to a panel is not one to hand out by default.
export function panelForRoutePath(routePath) {
  if (ALWAYS_ALLOWED_PATHS.has(routePath)) return "ALWAYS";
  if (EXTRA_PATH_TO_PANEL[routePath]) return EXTRA_PATH_TO_PANEL[routePath];
  const segments = routePath.split("/").filter(Boolean);
  if (segments[0] !== "admin") return null;
  const group = segments[1];
  if (!group) return null;
  const panel = ROUTE_GROUP_TO_PANEL[group];
  if (!panel) return null;
  return PANEL_ALIASES[panel] ?? panel;
}

// Tier defaults, applied as grant rows when a reviewer is invited (Operator
// decision 2026-09-28: tier acts as a template, not as a live authority - a
// reviewer's access is always exactly the rows in reviewer_permissions, so
// there is one place to look when asking why someone can see something).
//
// Client Tester gets nothing: the surface for the design discussion they are
// meant to join does not exist yet, and admitting them to anything else would
// hand a prospect the operational panel.
export const TIER_DEFAULT_PANELS = {
  delegate: [
    "admin.html:pipeline", "admin.html:outreach", "admin.html:qa",
    "admin.html:defects", "admin.html:feedback", "admin.html:gap-queue",
    "admin.html:kgr-cases", "admin.html:office-hours", "admin.html:reviewers",
  ],
  staff: [
    "admin.html:pipeline", "admin.html:outreach", "admin.html:qa",
    "admin.html:defects", "admin.html:feedback", "admin.html:gap-queue",
    "admin.html:kgr-cases", "admin.html:office-hours",
  ],
  client_tester: [],
};

// ── Grant lookup ────────────────────────────────────────────────────────────

// Active (non-revoked) panel grants for a reviewer, as a Set of
// "panel_file:key". Embeds admin_panels so one request resolves ids to keys.
export async function grantedPanelKeys(env, reviewerId) {
  const rows = await supabaseFetch(env, "reviewer_permissions",
    `?reviewer_id=eq.${encodeURIComponent(reviewerId)}&revoked_at=is.null` +
    `&select=admin_panel_id,admin_panels(panel_file,key)`);
  const keys = new Set();
  for (const row of rows ?? []) {
    const panel = row.admin_panels;
    if (panel?.panel_file && panel?.key) keys.add(`${panel.panel_file}:${panel.key}`);
  }
  return keys;
}

// The authorization decision for one request. The Operator short-circuits;
// everyone else must hold the panel the route belongs to.
export async function reviewerMayUseRoute(env, reviewer, routePath) {
  if (reviewer?.baseline_role === OPERATOR_BASELINE_ROLE) return { ok: true };
  const panel = panelForRoutePath(routePath);
  if (panel === "ALWAYS") return { ok: true };
  if (!panel)
    return { ok: false, error: "This route is not assigned to a panel; Operator access only" };
  const granted = await grantedPanelKeys(env, reviewer.id);
  if (!granted.has(panel))
    return { ok: false, error: "You do not have access to this panel" };
  return { ok: true };
}

// Resolves tier default panel keys to admin_panels ids, for writing grant rows
// at invite time. Silently skips a key with no matching row rather than failing
// the invite - a retired tab leaves a stale default, and losing a grant is
// preferable to losing the invite.
export async function panelIdsForKeys(env, keys) {
  if (!keys?.length) return [];
  const rows = await supabaseFetch(env, "admin_panels", "?select=id,panel_file,key&active=is.true");
  const byKey = new Map((rows ?? []).map(r => [`${r.panel_file}:${r.key}`, r.id]));
  return keys.map(k => byKey.get(k)).filter(Boolean);
}

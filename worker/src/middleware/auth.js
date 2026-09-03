import { supabaseFetch } from "../shared/supabase.js";

// Non-/admin/* staff-only tools. /admin and /admin/* are protected by prefix.
export const ADMIN_EXTRA_PROTECTED_PATHS = new Set([
  "/api/office-hours/schedule",
  "/api/office-hours/schedule/:day",
  "/api/office-hours/overrides",
  "/api/office-hours/overrides/:date",
  "/api/rd-log",
  "/api/rd-log/:id",
  "/qa",
  "/qa/:id",
]);

export function extractJwt(request) {
  const match = (request.headers.get("Authorization") ?? "").match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : null;
}

export function isProtectedRoute(path) {
  return path.startsWith("/admin/") || path === "/admin"
    || ADMIN_EXTRA_PROTECTED_PATHS.has(path);
}

export async function requireReviewer(request, env, allowedRoles = ["frontframe_admin", "frontframe_staff"]) {
  const jwt = extractJwt(request);
  if (!jwt) return { ok: false, status: 401, error: "Missing Authorization header" };

  const userRes = await fetch(`${env.SUPABASE_URL}/auth/v1/user`, {
    headers: { "apikey": env.SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${jwt}` },
  });
  if (!userRes.ok) return { ok: false, status: 401, error: "Invalid or expired session" };

  const user = await userRes.json();
  const email = user?.email;
  if (!email) return { ok: false, status: 401, error: "Invalid session" };

  const rows = await supabaseFetch(env, "reviewers",
    `?select=role,active&email=eq.${encodeURIComponent(email)}`);
  const reviewer = rows?.[0];
  if (!reviewer || reviewer.active === false)
    return { ok: false, status: 403, error: "Not an active reviewer" };
  if (allowedRoles && !allowedRoles.includes(reviewer.role))
    return { ok: false, status: 403, error: "Insufficient role" };

  return { ok: true, email, role: reviewer.role };
}

// FrontFrame Preview — Shared session helpers
// Single source of truth for SALT/COOKIE_NAME/hashPassword, used by
// functions/api/login.js and functions/middleware.js.
//
// SALT comes from the PREVIEW_SALT environment variable (Cloudflare Pages
// dashboard → Settings → Environment variables). Falls back to the legacy
// hardcoded value only if PREVIEW_SALT hasn't been set yet, so existing
// sessions don't break mid-rollout. Set PREVIEW_SALT to a new random value
// and remove the fallback once it's confirmed live.

export const COOKIE_NAME = "ff_session";
export const COOKIE_MAX_AGE = 60 * 60 * 24 * 7; // 7 days

const LEGACY_SALT_FALLBACK = "ff_preview_2026";

export function getSalt(env) {
  return (env && env.PREVIEW_SALT) || LEGACY_SALT_FALLBACK;
}

export async function hashPassword(password, salt) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + salt);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export function getCookie(request, name) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const cookies = cookieHeader.split(";").map((c) => c.trim());
  for (const cookie of cookies) {
    const [key, ...rest] = cookie.split("=");
    if (key.trim() === name) return rest.join("=");
  }
  return null;
}

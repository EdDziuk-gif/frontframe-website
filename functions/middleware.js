// FrontFrame Preview — Password Gate Middleware
// Runs on every request via Cloudflare Pages Functions.
// Requires PREVIEW_PASSWORD environment variable set in Cloudflare Pages dashboard.

const SALT        = "ff_preview_2026";
const COOKIE_NAME = "ff_session";

// Public paths — no authentication required.
// /yours is the QR code destination on business cards (contact only, no gated content).
const PUBLIC_PATHS = ["/login", "/api/login", "/yours"];

async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data    = encoder.encode(password + SALT);
  const hash    = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function getCookie(request, name) {
  const cookieHeader = request.headers.get("Cookie") || "";
  const cookies      = cookieHeader.split(";").map((c) => c.trim());
  for (const cookie of cookies) {
    const [key, ...rest] = cookie.split("=");
    if (key.trim() === name) return rest.join("=");
  }
  return null;
}

export async function onRequest(context) {
  const { request, next, env } = context;
  const url      = new URL(request.url);
  const pathname = url.pathname;

  // Always allow public paths and static assets
  if (
    PUBLIC_PATHS.some((p) => pathname.startsWith(p)) ||
    pathname.match(/\.(png|jpg|jpeg|gif|svg|ico|css|js|woff|woff2|ttf)$/)
  ) {
    return next();
  }

  // Check session cookie
  const sessionCookie = getCookie(request, COOKIE_NAME);
  const expectedToken = await hashPassword(env.PREVIEW_PASSWORD || "");

  if (sessionCookie === expectedToken) {
    return next();
  }

  // Not authenticated — redirect to login
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", pathname);
  return Response.redirect(loginUrl.toString(), 302);
}
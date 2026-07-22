// FrontFrame Preview — Password Gate Middleware
// Runs on every request via Cloudflare Pages Functions.
// Requires PREVIEW_PASSWORD environment variable set in Cloudflare Pages dashboard.
// SALT comes from PREVIEW_SALT (see functions/_shared/session.js).

import { COOKIE_NAME, getSalt, hashPassword, getCookie } from "./_shared/session.js";

// Public paths — no authentication required.
// / and /resources are public for search indexing and general visitors.
// /yours is the QR code destination on business cards (contact only, no gated content).
// /discovery and /about are public-facing content pages.
const PUBLIC_PATHS = ["/login", "/api/login", "/yours", "/", "/resources", "/discovery", "/about"];

export async function onRequest(context) {
  const { request, next, env } = context;
  const url      = new URL(request.url);
  const pathname = url.pathname;

  // Always allow public paths and static assets
  if (
    PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/")) ||
    pathname.match(/\.(png|jpg|jpeg|gif|svg|ico|css|js|woff|woff2|ttf)$/)
  ) {
    return next();
  }

  // Check session cookie
  const sessionCookie = getCookie(request, COOKIE_NAME);
  const expectedToken = await hashPassword(env.PREVIEW_PASSWORD || "", getSalt(env));

  if (sessionCookie === expectedToken) {
    return next();
  }

  // Not authenticated — redirect to login
  const loginUrl = new URL("/login", request.url);
  loginUrl.searchParams.set("next", pathname);
  return Response.redirect(loginUrl.toString(), 302);
}

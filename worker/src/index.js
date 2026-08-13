import { requireReviewer, isProtectedRoute } from "./middleware/auth.js";
import { matchRoute } from "./router.js";
import { ADMIN_ROUTES } from "./routes/admin.js";
import { DEBUG_ROUTES } from "./routes/debug.js";
import { PUBLIC_ROUTES } from "./routes/public.js";
import { CORS_HEADERS, jsonResponse } from "./shared/http.js";

export const ROUTES = [...PUBLIC_ROUTES, ...ADMIN_ROUTES];

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS")
      return new Response(null, { status: 204, headers: CORS_HEADERS });

    try {
      const debugHit = matchRoute(DEBUG_ROUTES, request.method, url.pathname);
      if (debugHit)
        return debugHit.route.handler(request, env, ctx, CORS_HEADERS, debugHit.params);

      const hit = matchRoute(ROUTES, request.method, url.pathname);
      if (!hit) return jsonResponse({ error: "Not found" }, 404, CORS_HEADERS);

      if (isProtectedRoute(hit.route.path)) {
        const auth = await requireReviewer(request, env);
        if (!auth.ok) return jsonResponse({ error: auth.error }, auth.status, CORS_HEADERS);
      }
      return hit.route.handler(request, env, ctx, CORS_HEADERS, hit.params);
    } catch (err) {
      console.error("Worker error:", err);
      return jsonResponse({ error: "Internal server error" }, 500, CORS_HEADERS);
    }
  },
};

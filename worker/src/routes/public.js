import { handlers } from "./registry.js";
import { jsonResponse } from "../shared/http.js";

// Keep this declaration in the same first-match order as the deployed API.
export const PUBLIC_ROUTES = [
  { method: "POST", path: "/auth/otp", handler: (req, env, _ctx, ch) => handlers.handleSendOtp(req, env, ch) },
  { method: "POST", path: "/auth/otp/verify", handler: (req, env, _ctx, ch) => handlers.handleVerifyOtp(req, env, ch) },
  { method: "POST", path: "/auth/magic-link", handler: (req, env, _ctx, ch) => handlers.handleMagicLink(req, env, ch) },
  { method: "POST", path: "/chat", handler: (req, env, ctx, ch) => handlers.handleChat(req, env, ctx, ch) },
  // Retired 2026-10-01 (Decisions 1, 21). The browser can no longer send a
  // visitor's details to the Operator on its own: the chat handoff flow on the
  // server is the only way a chat contact request is made. The route stays so
  // an old cached page gets a clear answer instead of a 404.
  { method: "POST", path: "/notify", handler: (_req, _env, _ctx, ch) => jsonResponse({ error: "This endpoint has been retired." }, 410, ch) },
  { method: "POST", path: "/inquiry", handler: (req, env, _ctx, ch) => handlers.handleInquiry(req, env, ch) },
  { method: "GET", path: "/blackout", handler: (req, env, _ctx, ch) => handlers.getBlackout(env, ch) },
  { method: "POST", path: "/schedule", handler: (req, env, _ctx, ch) => handlers.handleSchedule(req, env, ch) },
  { method: "GET", path: "/qa", handler: (req, env, _ctx, ch) => handlers.getQaPairs(env, ch) },
  // POST/PUT/DELETE /qa removed by migration 014 — qa_pairs is written only by
  // KGR sign-off. GET stays as a read-only viewer for the admin panel.
  { method: "GET", path: "/proposal", handler: (req, env, _ctx, ch) => handlers.getClientProposal(req, env, ch) },
  { method: "POST", path: "/proposal/review", handler: (req, env, ctx, ch) => handlers.submitProposalReview(req, env, ctx, ch) },
  { method: "GET", path: "/podcast-episodes", handler: (req, env, _ctx, ch) => handlers.getPodcastEpisodes(env, ch) },
  { method: "GET", path: "/rss-proxy", handler: (req, env, _ctx, ch) => handlers.handleRssProxy(req, ch) },
  { method: "GET", path: "/api/office-hours", handler: (req, env, _ctx, ch) => handlers.getEffectiveHours(env, ch) },
  { method: "POST", path: "/webhooks/stripe", handler: (req, env, _ctx, ch) => handlers.handleStripeWebhook(req, env, ch) },
  { method: "POST", path: "/webhooks/docuseal", handler: (req, env, _ctx, ch) => handlers.handleDocusealWebhook(req, env, ch) },
];

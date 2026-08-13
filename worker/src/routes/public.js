import { handlers } from "./registry.js";

// Keep this declaration in the same first-match order as the deployed API.
export const PUBLIC_ROUTES = [
  { method: "POST", path: "/auth/otp", handler: (req, env, _ctx, ch) => handlers.handleSendOtp(req, env, ch) },
  { method: "POST", path: "/auth/otp/verify", handler: (req, env, _ctx, ch) => handlers.handleVerifyOtp(req, env, ch) },
  { method: "POST", path: "/auth/magic-link", handler: (req, env, _ctx, ch) => handlers.handleMagicLink(req, env, ch) },
  { method: "POST", path: "/chat", handler: (req, env, ctx, ch) => handlers.handleChat(req, env, ctx, ch) },
  { method: "POST", path: "/notify", handler: (req, env, ctx, ch) => handlers.handleNotify(req, env, ctx, ch) },
  { method: "POST", path: "/inquiry", handler: (req, env, _ctx, ch) => handlers.handleInquiry(req, env, ch) },
  { method: "GET", path: "/blackout", handler: (req, env, _ctx, ch) => handlers.getBlackout(env, ch) },
  { method: "POST", path: "/schedule", handler: (req, env, _ctx, ch) => handlers.handleSchedule(req, env, ch) },
  { method: "GET", path: "/qa", handler: (req, env, _ctx, ch) => handlers.getQaPairs(env, ch) },
  { method: "POST", path: "/qa", handler: (req, env, _ctx, ch) => handlers.createQaPair(req, env, ch) },
  { method: "PUT", path: "/qa/:id", handler: (req, env, _ctx, ch, p) => handlers.updateQaPair(req, env, p.id, ch) },
  { method: "DELETE", path: "/qa/:id", handler: (req, env, _ctx, ch, p) => handlers.deleteQaPair(env, p.id, ch) },
  { method: "GET", path: "/proposal", handler: (req, env, _ctx, ch) => handlers.getProposal(req, env, ch) },
  { method: "POST", path: "/proposal/review", handler: (req, env, ctx, ch) => handlers.submitProposalReview(req, env, ctx, ch) },
  { method: "GET", path: "/podcast-episodes", handler: (req, env, _ctx, ch) => handlers.getPodcastEpisodes(env, ch) },
  { method: "GET", path: "/rss-proxy", handler: (req, env, _ctx, ch) => handlers.handleRssProxy(req, ch) },
  { method: "GET", path: "/api/office-hours", handler: (req, env, _ctx, ch) => handlers.getEffectiveHours(env, ch) },
  { method: "POST", path: "/webhooks/stripe", handler: (req, env, _ctx, ch) => handlers.handleStripeWebhook(req, env, ch) },
  { method: "POST", path: "/webhooks/docuseal", handler: (req, env, _ctx, ch) => handlers.handleDocusealWebhook(req, env, ch) },
];

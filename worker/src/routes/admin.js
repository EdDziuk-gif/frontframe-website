import { extractJwt } from "../middleware/auth.js";
import { handlers } from "./registry.js";

const withJwt = (handler) => (req, env, ctx, corsHeaders, params) =>
  handler(req, env, ctx, corsHeaders, params, extractJwt(req));

const route = (method, path, handler) => ({ method, path, handler });
const noParams = (handler) => withJwt((req, env, _ctx, ch, _params, jwt) => handler(req, env, jwt, ch));
const param = (handler, key = "id") => withJwt((req, env, _ctx, ch, params, jwt) => handler(req, env, params[key], jwt, ch));
const envOnly = (handler) => withJwt((req, env, _ctx, ch, _params, jwt) => handler(env, jwt, ch));
const envParam = (handler, key = "id") => withJwt((req, env, _ctx, ch, params, jwt) => handler(env, params[key], jwt, ch));
// ctxParam passes ctx through for handlers that need waitUntil (e.g. Operator-only constitution actions).
const ctxParam = (handler, key = "id") => withJwt((req, env, ctx, ch, params, jwt) => handler(req, env, ctx, params[key], jwt, ch));
// twoParams: for a route with two path params (e.g. /:id/hypotheses/:hid).
// request is passed through since these handlers read a JSON body.
const twoParams = (handler, key1 = "id", key2 = "hid") =>
  withJwt((req, env, _ctx, ch, params, jwt) => handler(req, env, params[key1], params[key2], jwt, ch));

// This is appended after PUBLIC_ROUTES. Keep route order, especially literal
// sub-routes before their parameterized variants, exactly as deployed.
export const ADMIN_ROUTES = [
  route("GET", "/admin/blackout", (req, env, _ctx, ch) => handlers.getBlackoutAdmin(env, ch)),
  route("POST", "/admin/blackout", (req, env, _ctx, ch) => handlers.createBlackoutAdmin(req, env, ch)),
  route("DELETE", "/admin/blackout/:id", (req, env, _ctx, ch, p) => handlers.deleteBlackoutAdmin(env, p.id, ch)),
  route("GET", "/admin/bookings", (req, env, _ctx, ch) => handlers.getBookingsAdmin(env, ch)),
  route("PUT", "/admin/bookings/:id", (req, env, _ctx, ch, p) => handlers.updateBookingAdmin(req, env, p.id, ch)),
  route("GET", "/admin/config", envOnly(handlers.getConfig)),
  route("POST", "/admin/config", noParams(handlers.updateConfig)),
  route("POST", "/admin/phase-e/chat", (req, env, ctx, ch) => handlers.handleChat(req, env, ctx, ch, "phase_e_test")),
  route("GET", "/admin/defects", envOnly(handlers.getDefects)),
  route("POST", "/admin/defects", noParams(handlers.createDefect)),
  route("PATCH", "/admin/defects/:id", param(handlers.updateDefect)),
  route("GET", "/admin/feedback", envOnly(handlers.getFeedback)),
  route("POST", "/admin/feedback", noParams(handlers.createFeedback)),
  route("POST", "/admin/feedback/check-conflicts", noParams(handlers.checkFeedbackConflicts)),
  route("PATCH", "/admin/feedback/:id", param(handlers.updateFeedback)),
  route("GET", "/admin/changelog", envOnly(handlers.getChangelog)),
  route("POST", "/admin/changelog", noParams(handlers.createChangelog)),
  route("GET", "/admin/leads", envOnly(handlers.getLeads)),
  route("POST", "/admin/leads", noParams(handlers.createLead)),
  route("GET", "/admin/lead-alerts/:id/session", envParam(handlers.getAlertSession)),
  route("GET", "/admin/lead-alerts", envOnly(handlers.getLeadAlerts)),
  route("PATCH", "/admin/lead-alerts/:id", param(handlers.updateLeadAlert)),
  route("DELETE", "/admin/lead-alerts/:id", envParam(handlers.deleteLeadAlert)),
  route("GET", "/admin/agreements", envOnly(handlers.getAgreements)),
  route("POST", "/admin/agreements/send", noParams(handlers.sendAgreement)),
  route("POST", "/admin/agreements/send-diligence", noParams(handlers.sendDueDiligence)),
  route("PATCH", "/admin/agreements/:id", param(handlers.updateAgreement)),
  route("GET", "/admin/system-prompt/:page", envParam(handlers.getSystemPrompt, "page")),
  route("POST", "/admin/system-prompt/:page", param(handlers.updateSystemPrompt, "page")),
  route("GET", "/admin/reviewers", envOnly(handlers.getReviewers)),
  route("POST", "/admin/reviewers/invite", noParams(handlers.inviteReviewer)),
  route("POST", "/admin/reviewers/reset-password", noParams(handlers.resetReviewerPassword)),
  route("PATCH", "/admin/reviewers/:id", param(handlers.updateReviewer)),
  route("DELETE", "/admin/reviewers/:id", envParam(handlers.deleteReviewer)),
  route("GET", "/admin/podcast-episodes", envOnly(handlers.adminGetPodcastEpisodes)),
  route("POST", "/admin/podcast-episodes", noParams(handlers.createPodcastEpisode)),
  route("PATCH", "/admin/podcast-episodes/:id", param(handlers.updatePodcastEpisode)),
  route("DELETE", "/admin/podcast-episodes/:id", envParam(handlers.deletePodcastEpisode)),
  route("GET", "/admin/marketing-log", noParams(handlers.getMarketingLog)),
  route("POST", "/admin/marketing-log", noParams(handlers.createMarketingLog)),
  route("PATCH", "/admin/marketing-log/:id", param(handlers.updateMarketingLog)),
  route("GET", "/admin/problem-statements", envOnly(handlers.getProblemStatements)),
  route("POST", "/admin/problem-statements", noParams(handlers.createProblemStatement)),
  route("PATCH", "/admin/problem-statements/:id", param(handlers.updateProblemStatement)),
  route("GET", "/admin/deliverables", noParams(handlers.getDeliverables)),
  route("POST", "/admin/deliverables", noParams(handlers.createDeliverable)),
  route("PATCH", "/admin/deliverables/:id", param(handlers.updateDeliverable)),
  route("POST", "/admin/payments/create-checkout", noParams(handlers.createCheckoutSession)),
  route("POST", "/admin/payments/send-request", noParams(handlers.handleSendPaymentRequest)),
  route("GET", "/admin/subscriptions", envOnly(handlers.getSubscriptions)),
  route("POST", "/admin/subscriptions", noParams(handlers.createSubscription)),
  route("POST", "/admin/subscriptions/:id/send", envParam(handlers.sendSubscription)),
  route("PATCH", "/admin/subscriptions/:id", param(handlers.updateSubscription)),
  route("GET", "/admin/vault", noParams(handlers.handleAdminVaultGet)),
  route("POST", "/admin/vault", noParams(handlers.handleAdminVaultSet)),
  route("GET", "/api/office-hours/schedule", envOnly(handlers.getSchedule)),
  route("PATCH", "/api/office-hours/schedule/:day", param(handlers.updateScheduleDay, "day")),
  route("GET", "/api/office-hours/overrides", envOnly(handlers.getOverrides)),
  route("POST", "/api/office-hours/overrides", noParams(handlers.createOverride)),
  route("DELETE", "/api/office-hours/overrides/:date", envParam(handlers.deleteOverride, "date")),
  route("GET", "/api/rd-log", envOnly(handlers.getRdLog)),
  route("POST", "/api/rd-log", noParams(handlers.createRdEntry)),
  route("PATCH", "/api/rd-log/:id", param(handlers.updateRdEntry)),
  route("DELETE", "/api/rd-log/:id", envParam(handlers.deleteRdEntry)),
  route("GET", "/admin/outreach", envOnly(handlers.getOutreachProspects)),
  route("POST", "/admin/outreach", noParams(handlers.createOutreachProspect)),
  route("GET", "/admin/outreach/:id/touches", envParam(handlers.getOutreachTouches)),
  route("POST", "/admin/outreach/:id/touches", param(handlers.createOutreachTouch)),
  route("POST", "/admin/outreach/:id/send-contract", param(handlers.sendOutreachContract)),
  route("PATCH", "/admin/outreach/:id", param(handlers.updateOutreachProspect)),
  route("DELETE", "/admin/review-queue/bulk", noParams(handlers.bulkDeleteReviewQueue)),
  route("GET", "/admin/review-queue", noParams(handlers.getReviewQueue)),
  route("PATCH", "/admin/review-queue/:id", param(handlers.updateReviewQueue)),
  route("DELETE", "/admin/review-queue/:id", envParam(handlers.deleteReviewQueue)),
  route("GET", "/admin/gap-resolution-requests", envOnly(handlers.getGapResolutionRequests)),
  route("DELETE", "/admin/gap-resolution-requests/:id", envParam(handlers.deleteGapResolutionRequest)),
  route("PATCH", "/admin/gap-resolution-requests/:id/authorize", param(handlers.authorizeGapResolutionRequest)),

  // Phase F Candidate 2, Increment 2: KGR case development record.
  route("POST",  "/admin/kgr-cases",                            noParams(handlers.createKgrCase)),
  route("GET",   "/admin/kgr-cases",                             envOnly(handlers.listKgrCases)),
  route("GET",   "/admin/kgr-cases/:id",                        envParam(handlers.getKgrCase)),
  route("PATCH", "/admin/kgr-cases/:id",                          param(handlers.updateKgrCase)),
  route("POST",  "/admin/kgr-cases/:id/hypotheses",               param(handlers.addHypothesis)),
  route("PATCH", "/admin/kgr-cases/:id/hypotheses/:hid",     twoParams(handlers.updateHypothesis)),
  route("PATCH", "/admin/kgr-cases/:id/ready",                 envParam(handlers.readyKgrCase)),
  route("PATCH", "/admin/kgr-cases/:id/escalate",              envParam(handlers.escalateKgrCase)),
  route("POST",  "/admin/kgr-cases/:id/develop",               envParam(handlers.developKgrCase)),
  route("POST",  "/admin/kgr-cases/:id/prepare-resolution",      param(handlers.prepareResolutionStatement)),
  // Phase F candidate 1: constitutional amendment proposals
  route("GET",   "/admin/constitution/proposals",                   envOnly(handlers.listProposals)),
  route("POST",  "/admin/constitution/proposals",                   noParams(handlers.createProposal)),
  route("GET",   "/admin/constitution/proposals/:id",               envParam(handlers.getProposal)),
  route("PATCH", "/admin/constitution/proposals/:id",               param(handlers.updateProposal)),
  route("POST",  "/admin/constitution/proposals/:id/submit",        param(handlers.submitProposal)),
  route("POST",  "/admin/constitution/proposals/:id/reopen",        param(handlers.reopenProposal)),
  route("POST",  "/admin/constitution/proposals/:id/return",        ctxParam(handlers.returnProposal)),
  route("POST",  "/admin/constitution/proposals/:id/reject",        ctxParam(handlers.rejectProposal)),
  route("POST",  "/admin/constitution/proposals/:id/promulgate",    ctxParam(handlers.promulgateProposal)),
  route("GET",   "/admin/constitution/amendments",                  envOnly(handlers.listAmendments)),
  route("GET",   "/admin/constitution/provisions",                  envOnly(handlers.listProvisions)),
  route("GET",   "/admin/authorization-incidents",                  envOnly(handlers.listAuthorizationIncidents)),
  route("PATCH", "/admin/authorization-incidents/:id",              param(handlers.updateAuthorizationIncident)),
];
// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: contact handoff flow (server-driven)
// ════════════════════════════════════════════════════════════════════════════
//
// Decisions 1, 5, 8, 9, 12, 21 (repair plan, 2026-10-01).
//
// The visitor's request to be contacted is collected here, by the server, in
// fixed wording of its own. The model does not run this dialogue and cannot
// create a lead. Nothing is saved as a lead, emailed, or texted until the visitor
// has seen exactly what will be sent and said yes.
//
// Position in the flow lives in chat_sessions.flow_state (see chat-session.js):
//
//   chat -> offered      the assistant could not answer and offered to take details
//   chat -> ask_name     the visitor asked for a person (the model's one marker)
//   offered -> ask_name  the visitor said yes to the offer
//   ask_name -> ask_method -> ask_contact -> ask_zip -> confirm -> (sent)
//
// At `confirm` the visitor reads the exact text that will be sent. One "yes"
// covers "this is right" and "send it" (Decision 8). Anything that is not a plain
// yes or no is taken as the visitor's own corrected wording of the request and is
// shown again. The server sends exactly the text the visitor was shown.
//
// Everything the server says here is fixed text, so it needs no conformance
// review (Decision 12). The one model-written piece is the restatement of the
// visitor's question; it is conformance-checked before the visitor sees it
// (Decision 9). If it fails the check, or the model call fails, the visitor's own
// words are shown instead, which is the visitor's text, not the model's.

import { buildConstitutionSection, callAnthropic, ANTHROPIC_FAST_MODEL, parseJsonObject } from "../shared/runtime.js";
import { supabaseFetch } from "../shared/supabase.js";
import { checkConstitutionalConformance, createConstitutionalNonconformanceLifecycle } from "../shared/scoring.js";
import { alertGapResolutionQueue } from "../shared/gap-alert.js";
import { deleteSession, transcriptFor } from "../shared/chat-session.js";
import { operatorFollowUp, operatorNameOr, operatorReachLine } from "../shared/operator.js";
import { timezoneForZip, timezoneLabel } from "../shared/zip-timezone.js";
import { captureContactHandoff } from "./intake.js";

// The wording version shown to the visitor at the confirm step. Recorded with the
// visitor's consent. Change it whenever the confirm text below changes.
export const NOTICE_VERSION = "2026-10-01.1";

const MAX_ATTEMPTS = 3;
const MAX_EDITS = 5;

// ── Deterministic parsing (no model) ─────────────────────────────────────────

const YES_RE = /^\s*(?:y|yes|yeah|yep|yup|sure|ok|okay|please|please do|go ahead|send|send it|sounds good|that'?s right|that is right|correct|absolutely|definitely|of course)(?:\s+(?:please|thanks|thank you))?\s*[.!]*\s*$/i;
const NO_RE = /^\s*(?:n|no|nope|nah|no thanks|no thank you|cancel|never ?mind|stop|don'?t send|do not send|forget it)\s*[.!]*\s*$/i;
const CANCEL_RE = /^\s*(?:cancel|stop|never ?mind|don'?t send|do not send|forget it)\s*[.!]*\s*$/i;
const SKIP_RE = /^\s*(?:skip|skip it|no|none|n\/a|na|pass|rather not|prefer not to say)\s*[.!]*\s*$/i;

export function parseYesNo(text) {
  const t = String(text ?? "");
  if (YES_RE.test(t)) return "yes";
  if (NO_RE.test(t)) return "no";
  return null;
}

export function parseName(text) {
  const t = String(text ?? "").replace(/\s+/g, " ").trim();
  if (!t || t.length > 80) return null;
  if (parseYesNo(t) !== null) return null;
  if (!/\p{L}/u.test(t)) return null;
  if (/[?@<>]/.test(t)) return null;
  if (t.split(" ").length > 6) return null;
  return t;
}

export function parseMethod(text) {
  const t = String(text ?? "").toLowerCase();
  if (/\b(e-?mail|mail)\b/.test(t)) return "email";
  if (/\b(text|texting|sms)\b/.test(t)) return "text";
  if (/\b(phone|call|ring|voice)\b/.test(t)) return "phone";
  return null;
}

const EMAIL_RE = /[^\s@<>()[\],;:"']+@[^\s@<>()[\],;:"']+\.[^\s@<>()[\],;:"']{2,}/;

export function extractEmail(text) {
  const m = String(text ?? "").match(EMAIL_RE);
  return m ? m[0].replace(/[.]+$/, "") : null;
}

export function extractPhone(text) {
  const t = String(text ?? "");
  const m = t.match(/\+?\d[\d\s().-]{8,}\d/);
  if (!m) return null;
  const digits = m[0].replace(/\D/g, "");
  if (digits.length < 10 || digits.length > 15) return null;
  return m[0].trim();
}

export function parseZip(text) {
  const t = String(text ?? "");
  if (SKIP_RE.test(t)) return { skipped: true, zip: null };
  const m = t.match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? { skipped: false, zip: m[1] } : null;
}

// ── Fixed wording ────────────────────────────────────────────────────────────

const who = (op) => operatorNameOr(op, "our team");
const methodLabel = (m) => (m === "email" ? "Email" : m === "text" ? "Text" : "Phone call");

export const FLOW_TEXT = {
  askNameAfterMarker: (op) => `Happy to pass this to ${who(op)}. What's your name?`,
  askNameAfterYes: () => "Okay. What's your name?",
  retryName: () => "I just need a name to pass along. Or say cancel and nothing will be sent.",
  askMethod: (op, name) => `Thanks, ${name}. How would you like ${who(op)} to reach you: email, phone call, or text?`,
  retryMethod: () => "Please reply with email, phone call, or text. Or say cancel.",
  askContact: (method) =>
    method === "email" ? "What's the best email address?"
      : method === "text" ? "What's the best number to text?"
      : "What's the best phone number to call?",
  retryContact: (method) =>
    method === "email" ? "That doesn't look like an email address. What's the best email address?"
      : "That doesn't look like a phone number. Please include the area code.",
  askZip: (op) => `What's your zip code? It helps ${who(op)} choose a good time to reach you. You can say skip.`,
  retryZip: () => "Please give a 5-digit zip code, or say skip.",
  confirm: (op, d) =>
    `Here is exactly what I'll send to ${who(op)}:\n\n` +
    `Name: ${d.name}\n` +
    `Reach you by: ${methodLabel(d.method)}, ${d.contact}\n` +
    (d.zip ? `Zip: ${d.zip}${d.timezone ? ` (${timezoneLabel(d.timezone)})` : ""}\n` : "") +
    `Your request: ${d.summary}\n\n` +
    `Nothing else from this chat is sent. Reply yes to send it, or no to cancel. ` +
    `To change the request, type it the way you'd like it to read.`,
  confirmReminder: () => "Please reply yes to send it, or no to cancel.",
  sent: (op) => `Sent. ${operatorFollowUp(op)}${operatorReachLine(op)}`,
  cancelled: () => "Okay. Nothing was sent.",
  abandoned: (op) => `I couldn't read that, so nothing was sent.${operatorReachLine(op)}`,
  sendFailed: (op) => `I couldn't send that just now, and nothing was saved. Reply yes to try again.${operatorReachLine(op)}`,
};

// ── Starting the flow ────────────────────────────────────────────────────────

// The assistant withheld an answer and offered to take the visitor's details.
export function offeredState(pendingQuestion) {
  return { flow_state: "offered", flow_data: { pending_question: pendingQuestion } };
}

// The visitor asked for a person. The server takes over with its own question.
export function startedState(operator, pendingQuestion) {
  return {
    flow_state: "ask_name",
    flow_data: { pending_question: pendingQuestion, attempts: 0 },
    response: FLOW_TEXT.askNameAfterMarker(operator),
  };
}

// ── The restatement of the visitor's question ────────────────────────────────

const SUMMARY_SYSTEM_PROMPT = `You restate a website visitor's request so a person can read it quickly.

Rewrite the visitor's message as one or two plain sentences in the visitor's own voice (first person). Fix grammar and wording only. Add nothing the visitor did not say. Do not answer the request. Do not make any promise, commitment, or statement on behalf of FrontFrame.

Return exactly one JSON object and no other text, in exactly this form:
{"summary": "..."}`;

async function composeInquiry(env, ctx, { pendingQuestion, sessionId, source }) {
  const own = String(pendingQuestion ?? "").trim();
  let summary = null;
  try {
    const raw = await callAnthropic(env, SUMMARY_SYSTEM_PROMPT, [{ role: "user", content: own }], ANTHROPIC_FAST_MODEL);
    const parsed = parseJsonObject(raw);
    if (typeof parsed?.summary === "string" && parsed.summary.trim()) summary = parsed.summary.trim();
  } catch (e) {
    console.error("Inquiry restatement failed; using the visitor's own words:", e);
  }
  if (!summary) return own;

  let constitutionSection = "";
  try {
    const rows = await supabaseFetch(env, "constitution_provisions",
      "?select=provision_number,title,current_text&order=provision_number.asc");
    constitutionSection = buildConstitutionSection(rows);
  } catch (e) {
    console.error("Constitution load failed for the restatement check:", e);
  }
  const conformance = await checkConstitutionalConformance(env, constitutionSection, summary);
  if (conformance.conforms) return summary;

  // Withheld and escalated like any other non-conforming answer. The visitor is
  // shown their own words instead, so the flow can continue without looping back
  // to the same offer.
  try {
    const lifecycle = await createConstitutionalNonconformanceLifecycle(env, {
      question: own, answer: summary, issue: conformance.issue, askedBy: sessionId, source,
    });
    if (lifecycle?.gapResolutionRequestId) await alertGapResolutionQueue(env, ctx, "chat", "constitutional_nonconformance");
  } catch (e) {
    console.error("Restatement nonconformance record failed:", e);
  }
  return own;
}

// ── One turn inside the flow ─────────────────────────────────────────────────
//
// Returns:
//   { exitToChat: true }   the message is an ordinary question; process it normally
//   { response, flow_state, flow_data, handoff?, deleteSession? }
export async function runFlowTurn({ env, ctx, session, message, operator, source = "agent" }) {
  const state = session.flow_state;
  const data = { ...session.flow_data };
  const op = operator;
  const text = String(message ?? "");

  const cancel = () => ({ response: FLOW_TEXT.cancelled(), flow_state: "chat", flow_data: {} });
  const abandon = () => ({ response: FLOW_TEXT.abandoned(op), flow_state: "chat", flow_data: {} });
  const retry = (response) => {
    const attempts = (data.attempts ?? 0) + 1;
    if (attempts >= MAX_ATTEMPTS) return abandon();
    return { response, flow_state: state, flow_data: { ...data, attempts } };
  };

  if (state === "offered") {
    const answer = parseYesNo(text);
    if (answer === "yes") {
      return { response: FLOW_TEXT.askNameAfterYes(), flow_state: "ask_name", flow_data: { ...data, attempts: 0 } };
    }
    if (answer === "no") return cancel();
    return { exitToChat: true };
  }

  // A plain "no" cancels at every step except two: at the confirm step it means
  // "do not send" (handled there), and at the optional zip question it means "I'd
  // rather not say", which is a skip and must not throw the request away. An
  // explicit "cancel" still cancels at the zip step.
  if (state !== "confirm" && state !== "ask_zip" && parseYesNo(text) === "no") return cancel();
  if (state === "ask_zip" && CANCEL_RE.test(text)) return cancel();

  if (state === "ask_name") {
    const name = parseName(text);
    if (!name) return retry(FLOW_TEXT.retryName());
    return { response: FLOW_TEXT.askMethod(op, name), flow_state: "ask_method", flow_data: { ...data, name, attempts: 0 } };
  }

  if (state === "ask_method") {
    const email = extractEmail(text);
    const phone = extractPhone(text);
    const method = parseMethod(text) ?? (email ? "email" : null);
    if (!method) return retry(FLOW_TEXT.retryMethod());
    const contact = method === "email" ? email : phone;
    if (contact) {
      return { response: FLOW_TEXT.askZip(op), flow_state: "ask_zip", flow_data: { ...data, method, contact, attempts: 0 } };
    }
    return { response: FLOW_TEXT.askContact(method), flow_state: "ask_contact", flow_data: { ...data, method, attempts: 0 } };
  }

  if (state === "ask_contact") {
    const contact = data.method === "email" ? extractEmail(text) : extractPhone(text);
    if (!contact) return retry(FLOW_TEXT.retryContact(data.method));
    return { response: FLOW_TEXT.askZip(op), flow_state: "ask_zip", flow_data: { ...data, contact, attempts: 0 } };
  }

  if (state === "ask_zip") {
    const z = parseZip(text);
    const attempts = (data.attempts ?? 0) + 1;
    // A zip is optional: a second unreadable answer is treated as a skip.
    if (!z && attempts < 2) return { response: FLOW_TEXT.retryZip(), flow_state: "ask_zip", flow_data: { ...data, attempts } };
    const zip = z?.zip ?? null;
    // Looked up from the zip so the Operator knows when to return a call. Shown to
    // the visitor in the confirm text below, so what is sent is what they read.
    const timezone = zip ? timezoneForZip(zip) : null;
    const summary = await composeInquiry(env, ctx, { pendingQuestion: data.pending_question, sessionId: session.session_id, source });
    const next = { ...data, zip, timezone, summary, attempts: 0, edits: 0 };
    return { response: FLOW_TEXT.confirm(op, next), flow_state: "confirm", flow_data: next };
  }

  if (state === "confirm") {
    const answer = parseYesNo(text);
    if (answer === "no") return cancel();
    if (answer === "yes") return sendHandoff({ env, ctx, session, data, op, message: text, source });
    // Anything else is the visitor's own corrected wording of the request.
    const edits = (data.edits ?? 0) + 1;
    if (edits > MAX_EDITS) return { response: FLOW_TEXT.confirmReminder(), flow_state: "confirm", flow_data: { ...data, edits } };
    const next = { ...data, summary: text.trim(), edits };
    return { response: FLOW_TEXT.confirm(op, next), flow_state: "confirm", flow_data: next };
  }

  // An unknown state is treated as no flow at all.
  return { exitToChat: true };
}

// The visitor said yes to exactly the text in data.summary. Send that text and
// nothing else from the conversation. The held messages are copied onto the alert
// record as the transcript (stored, never sent) and the held row is deleted.
async function sendHandoff({ env, ctx, session, data, op, message, source }) {
  const response = FLOW_TEXT.sent(op);
  const transcript = transcriptFor([
    ...session.conversation,
    { role: "user", content: message },
    { role: "assistant", content: response },
  ]);

  let result;
  try {
    result = await captureContactHandoff(env, ctx, {
      session_id: session.session_id,
      name: data.name,
      contact: data.contact,
      method: data.method,
      zip: data.zip ?? "",
      timezone: data.timezone ?? "",
      summary: data.summary,
      // leads.source only allows 'agent', 'intake' or 'direct'; the chat handoff is 'agent'.
      source: "agent",
      transcript,
      consent: { at: new Date().toISOString(), noticeVersion: NOTICE_VERSION },
    });
  } catch (e) {
    console.error("handoff send failed:", e);
    result = { delivered: false };
  }

  if (!result?.delivered && !result?.deduped) {
    return { response: FLOW_TEXT.sendFailed(op), flow_state: "confirm", flow_data: data };
  }

  await deleteSession(env, session.session_id).catch((e) => console.error("session discard after handoff failed:", e));
  return { response, flow_state: "chat", flow_data: {}, handoff: true, sessionDeleted: true };
}

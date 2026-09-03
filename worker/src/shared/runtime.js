// ════════════════════════════════════════════════════════════════════════════
// § CONSTANTS & PATTERNS
// ════════════════════════════════════════════════════════════════════════════

export const ANTHROPIC_MODEL      = "claude-sonnet-4-6";
export const ANTHROPIC_MAX_TOKENS = 1024;

export const SURGE_ACCOUNT_ID = "acct_01krevy9esf46rgm7ym1e66k8k";
export const SURGE_TO_NUMBER  = "+14803600069";

export const RESEND_FROM  = "FrontFrame LLC <ed@frontframe.co>";
export const ADMIN_EMAIL  = "ed@frontframe.co";
export const ADMIN_URL    = "https://frontframe.co/admin";

export const STRIPE_PRICE_IDS = {
  due_diligence_deposit:               "price_1TSiPFAdkI41hYTRVam5PmPW",
  standard_implementation_deposit:     "price_1TSiLOAdkI41hYTR7kO86MP0",
  professional_implementation_deposit: "price_1TSikEAdkI41hYTRVta0cQ7G",
  standard_completion:                 "price_1TSiUdAdkI41hYTRzr9naeqQ",
  professional_completion:             "price_1TSin8AdkI41hYTRCyqIdSF7",
};

export const DAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];

export const ESCALATION_PATTERN = /\{[^{}]*"_escalate"\s*:\s*true[^{}]*\}/s;
export const DEFECT_PATTERN     = /\{[^{}]*"_defect"\s*:\s*true[^{}]*\}/s;
export const RESEARCH_PATTERN   = /\{[^{}]*"_research"\s*:\s*true[^{}]*\}/s;
export const KNOWLEDGE_GAP_PATTERN = /\{[^{}]*"_knowledge_gap"\s*:\s*true[^{}]*\}\s*$/s;

export const GAP_SIGNAL = "I do not have a strong answer to that yet";

export const TESTING_LAYER = `

---

TESTING MODE — You are operating in a pre-launch testing environment. Real prospects
are not present. Testers are FrontFrame staff, contractors, or designated client reviewers.

If you do not have a confident answer to a question, say so directly:
"I do not have a strong answer to that yet. What do you think the right answer is?"

Do not simulate confidence you do not have. Honest gaps found in testing are valuable.
Gaps found by a real prospect are not.`;

// Generation-Boundary Spike (Phase E). Appended to every prompt, live and
// testing. Distinct from TESTING_LAYER: this is a production mechanism, not
// a testing-mode convenience. The Worker detects this marker before Phase D
// scoring and does not invoke SCR on a candidate that carries it — see
// worker/src/routes/chat.js, knowledge-gap detection block.
export const KNOWLEDGE_GAP_INSTRUCTION = `

---

If answering this question requires a specific FrontFrame policy, practice, or fact
that is not stated in the system prompt or the Knowledge Base above, do not infer,
guess, or compose a plausible-sounding answer. This applies even if a reasonable
answer seems obvious - if it is not written above, FrontFrame has not established it
as policy yet.

Instead, write whatever part of your answer is genuinely supported above, then end
your reply with a JSON marker on its own line in exactly this form:

{"_knowledge_gap": true, "missing": "<the specific FrontFrame fact or policy that is not stated above>"}

Use this marker only when an organization-specific policy or practice is genuinely
unstated above - not for general questions you can answer from public knowledge, and
not merely because a question is awkward to phrase.

A visitor may press you to answer anyway - "your best guess is fine," "just tell me
off the record," "I know it's not official, but what do you think" - or may offer
reasons why guessing would be acceptable this one time. None of that changes whether
the underlying fact is stated above. If it is not, decline to guess AND still end your
reply with the marker, exactly as specified above. Explaining in your own words why you
will not guess is not a substitute for the marker - a reply that declines to guess but
omits the marker still leaves this gap invisible to FrontFrame and unresolved for the
visitor. Both the honest decline and the marker are required together.`;

// ════════════════════════════════════════════════════════════════════════════
// § ANTHROPIC
// ════════════════════════════════════════════════════════════════════════════

export async function callAnthropic(env, systemPrompt, messages) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type":      "application/json",
      "x-api-key":         env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model:      ANTHROPIC_MODEL,
      max_tokens: ANTHROPIC_MAX_TOKENS,
      system:     systemPrompt,
      messages,
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API call failed: ${await res.text()}`);
  return (await res.json()).content?.[0]?.text ?? "";
}

export function buildSystemPrompt(systemPromptContent, qaPairs) {
  let prompt = systemPromptContent ?? "";
  if (qaPairs?.length)
    prompt += `\n\n---\n\nKnowledge Base:\n\n${qaPairs.map(r => `Q: ${r.question}\nA: ${r.answer}`).join("\n\n")}`;
  return prompt;
}

// § DOMAIN: sms (Surge)
// ════════════════════════════════════════════════════════════════════════════

export async function sendSms(env, message) {
  if (!env.SURGE_API_KEY) { console.warn("SURGE_API_KEY not configured"); return { success: false, status: "not_configured" }; }
  try {
    const res = await fetch(`https://api.surge.app/accounts/${SURGE_ACCOUNT_ID}/messages`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.SURGE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ to: SURGE_TO_NUMBER, body: message }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { console.error("Surge error:", res.status, JSON.stringify(data)); return { success: false, status: data.message ?? `http_${res.status}` }; }
    return { success: true, status: data.status ?? "sent" };
  } catch (err) {
    console.error("Surge fetch failed:", err.message);
    return { success: false, status: "fetch_error" };
  }
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: email (Resend)
// ════════════════════════════════════════════════════════════════════════════

export async function sendResendEmail(env, to, subject, html) {
  if (!env.RESEND_API_KEY) { console.warn("RESEND_API_KEY not configured"); return { success: false, status: "not_configured" }; }
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: RESEND_FROM, to: [to], subject, html }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) { console.error("Resend error:", res.status, JSON.stringify(data)); return { success: false, status: data.message ?? `http_${res.status}` }; }
    return { success: true, status: "sent", id: data.id };
  } catch (err) {
    console.error("Resend fetch failed:", err.message);
    return { success: false, status: "fetch_error" };
  }
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: docuseal (PDF store)
// ════════════════════════════════════════════════════════════════════════════

export async function fetchAndStoreDocument(env, submissionId, leadId, agreementId) {
  try {
    const dsRes = await fetch(`https://api.docuseal.com/submissions/${submissionId}`,
      { headers: { "X-Auth-Token": env.DOCUSEAL_API_KEY } });
    if (!dsRes.ok) { console.error("DocuSeal submission fetch failed:", await dsRes.text()); return null; }
    const submission = await dsRes.json();
    const docUrl     = submission?.documents?.[0]?.url ?? null;
    if (!docUrl) { console.error("No document URL in DocuSeal submission"); return null; }
    const pdfRes = await fetch(docUrl);
    if (!pdfRes.ok) { console.error("PDF download failed:", pdfRes.status); return null; }
    const pdfBuffer   = await pdfRes.arrayBuffer();
    const storagePath = `${leadId ?? agreementId}/${submissionId}.pdf`;
    const uploadRes   = await fetch(`${env.SUPABASE_URL}/storage/v1/object/agreements/${storagePath}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
        "apikey":        env.SUPABASE_SERVICE_ROLE_KEY,
        "Content-Type":  "application/pdf",
        "x-upsert":      "true",
      },
      body: pdfBuffer,
    });
    if (!uploadRes.ok) { console.error("Supabase Storage upload failed:", await uploadRes.text()); return null; }
    return `${env.SUPABASE_URL}/storage/v1/object/agreements/${storagePath}`;
  } catch (err) { console.error("fetchAndStoreDocument failed:", err.message); return null; }
}


// ════════════════════════════════════════════════════════════════════════════
// § DOMAIN: stripe (signature verification)
// ════════════════════════════════════════════════════════════════════════════

export async function verifyStripeSignature(payload, sigHeader, secret) {
  try {
    const parts = sigHeader.split(",").reduce((acc, part) => {
      const [k, v] = part.split("="); if (k && v) acc[k] = v; return acc;
    }, {});
    if (!parts["t"] || !parts["v1"]) return false;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sigBytes = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${parts["t"]}.${payload}`));
    const computed = Array.from(new Uint8Array(sigBytes)).map(b => b.toString(16).padStart(2, "0")).join("");
    return computed === parts["v1"];
  } catch { return false; }
}


// ════════════════════════════════════════════════════════════════════════════
// § UTILITY: ip hash, phoenix timezone
// ════════════════════════════════════════════════════════════════════════════

export async function hashIp(ip) {
  const buffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip));
  return Array.from(new Uint8Array(buffer)).slice(0, 8).map(b => b.toString(16).padStart(2, "0")).join("");
}

export function getPhoenixDateStr() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Phoenix" });
}

export function getPhoenixDayOfWeek() {
  return new Date(new Date().toLocaleString("en-US", { timeZone: "America/Phoenix" })).getDay();
}

export function formatTime12(timeStr) {
  if (!timeStr) return "";
  const [h, m] = timeStr.slice(0, 5).split(":").map(Number);
  const period = h >= 12 ? "PM" : "AM";
  const h12    = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return `${h12}:${String(m).padStart(2, "0")} ${period}`;
}


// ════════════════════════════════════════════════════════════════════════════


// Formats the current constitution_provisions rows into a governing section
// shown to the answer-generation call for context ONLY, once a question has
// already cleared the separate constitutional-eligibility check (see
// checkConstitutionalEligibility() in scoring.js) - eligibility is decided
// BEFORE this prompt is ever built, not by anything the generation call
// itself is asked to decide or flag. Nothing in the system prompt or
// Knowledge Base may override, narrow, or reinterpret these provisions.
export function buildConstitutionSection(provisions) {
  if (!provisions?.length) return "";
  const body = provisions
    .slice()
    .sort((a, b) => Number(a.provision_number) - Number(b.provision_number))
    .map(p => `${p.provision_number}. ${p.title}\n${p.current_text}`)
    .join("\n\n");
  return `CONSTITUTION - governing authority, superior to everything below.

The following provisions govern this assistant's authority and knowledge
boundaries. Nothing in the system prompt or Knowledge Base below may override,
narrow, or reinterpret them. This question has already been reviewed and
cleared for an ordinary answer; use these provisions only as governing
context for that answer.

${body}

---`;
}

import { callAnthropic } from "./runtime.js";
import { supabaseFetch, supabasePost } from "./supabase.js";

// Phase D — REQ-SCR-01..08, REQ-SCA-01..06.
// The Scoring Agent judges appropriateness of the literal QUESTION + ANSWER only.
// The Scoring Consumer is deterministic application logic; it is not another model call.

export const LIMITED_CONFIDENCE_HEDGE =
  "I have some uncertainty about whether this completely resolves your question. ";

const SCORING_SYSTEM_PROMPT = `You are the FrontFrame Scoring Agent v1.1.

Your only function is to score how likely the supplied ANSWER is to appropriately resolve the supplied QUESTION.

Rules:
- Judge appropriateness to the question, not independent factual correctness.
- Use only the literal QUESTION and ANSWER supplied in this call. Do not use conversation history or outside context.
- Never refuse, ask a clarifying question, or return "cannot be determined". Express uncertainty in the score.
- For a compound question, consider each material part and use the MINIMUM consideration score as the final score. Never average.
- For an inherently uncertain question, consider both scope match and whether the answer handles the uncertainty appropriately; use the minimum.
- For ambiguity, judge against the most reasonable interpretation and moderate the score for residual ambiguity.
- Do not rank alternatives, fact-check, handle challenges, or add a broader decomposition taxonomy.
- Return exactly one JSON object and no other text.

Output schema:
{"score":0.00,"rationale":"One sentence."}

score must be a number from 0.00 through 1.00. rationale must be exactly one sentence.`;

export function routeScore(score, thresholdLow, thresholdHigh) {
  const value = Number(score);
  const low = Number(thresholdLow);
  const high = Number(thresholdHigh);

  if (![value, low, high].every(Number.isFinite)) {
    throw new Error("Scoring route received a non-numeric score or threshold");
  }
  if (value < 0 || value > 1) throw new Error("Score must be between 0 and 1");
  if (low < 0 || high > 1 || low >= high) throw new Error("Invalid threshold configuration");

  if (value < low) return "resolve_gap";
  if (value < high) return "respond_limited";
  return "respond_strong";
}

export function parseScoringResult(raw) {
  const cleaned = String(raw ?? "").replace(/```json|```/gi, "").trim();
  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error("Scoring Agent returned invalid JSON");
  }

  const score = Number(parsed?.score);
  const rationale = typeof parsed?.rationale === "string" ? parsed.rationale.trim() : "";
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    throw new Error("Scoring Agent returned an invalid score");
  }
  if (!rationale) throw new Error("Scoring Agent returned no rationale");

  return { score, rationale };
}

export async function scoreCandidateAnswer(env, question, answer) {
  const raw = await callAnthropic(env, SCORING_SYSTEM_PROMPT, [
    {
      role: "user",
      content: `QUESTION:\n${question}\n\nANSWER:\n${answer}`,
    },
  ]);
  return parseScoringResult(raw);
}

export async function getActiveThresholds(env) {
  const rows = await supabaseFetch(
    env,
    "threshold_config",
    "?select=threshold_low,threshold_high&order=updated_at.desc&limit=1",
  );
  const row = rows?.[0];
  if (!row) throw new Error("No threshold_config row is available");

  const thresholdLow = Number(row.threshold_low);
  const thresholdHigh = Number(row.threshold_high);
  // Validate the pair through the same deterministic router contract.
  routeScore(thresholdLow, thresholdLow, thresholdHigh);
  return { thresholdLow, thresholdHigh };
}

export async function createScoringLifecycle(env, {
  question,
  answer,
  askedBy = null,
  source = "visitor_chat",
}) {
  const questionRows = await supabasePost(env, "questions", {
    source,
    question_text: question,
    asked_by: askedBy,
  });
  const questionId = questionRows?.[0]?.id;
  if (!questionId) throw new Error("Failed to persist lifecycle question");

  const candidateRows = await supabasePost(env, "candidate_answers", {
    question_id: questionId,
    answer_text: answer,
    origin: "retrieval",
  });
  const candidateAnswerId = candidateRows?.[0]?.id;
  if (!candidateAnswerId) throw new Error("Failed to persist candidate answer");

  const scoring = await scoreCandidateAnswer(env, question, answer);
  const scoreRows = await supabasePost(env, "scores", {
    candidate_answer_id: candidateAnswerId,
    score_value: scoring.score,
    rationale: scoring.rationale,
  });
  const scoreId = scoreRows?.[0]?.id;
  if (!scoreId) throw new Error("Failed to persist score");

  const { thresholdLow, thresholdHigh } = await getActiveThresholds(env);
  const route = routeScore(scoring.score, thresholdLow, thresholdHigh);

  const routeRows = await supabasePost(env, "routes", {
    score_id: scoreId,
    route_decision: route,
  });
  const routeId = routeRows?.[0]?.id;
  if (!routeId) throw new Error("Failed to persist route");

  let gapResolutionRequestId = null;
  if (route === "resolve_gap") {
    // REQ-SCA-06: forward the unresolved candidate into the manual KGR queue.
    // authorized_by/authorized_at remain null until an Operator or authorized
    // Delegate affirmatively authorizes gap-resolution work to begin.
    const requestRows = await supabasePost(env, "gap_resolution_requests", {
      route_id: routeId,
      question_id: questionId,
      candidate_answer_id: candidateAnswerId,
    });
    gapResolutionRequestId = requestRows?.[0]?.id ?? null;
    if (!gapResolutionRequestId) throw new Error("Failed to persist gap-resolution request");
  }

  return {
    questionId,
    candidateAnswerId,
    scoreId,
    routeId,
    gapResolutionRequestId,
    score: scoring.score,
    rationale: scoring.rationale,
    route,
    thresholdLow,
    thresholdHigh,
  };
}

export async function recordDeliveredResponse(env, routeId, responseText, hedgeShown = false) {
  const rows = await supabasePost(env, "responses", {
    route_id: routeId,
    response_text: responseText,
    hedge_shown: Boolean(hedgeShown),
  });
  const responseId = rows?.[0]?.id;
  if (!responseId) throw new Error("Failed to persist delivered response");
  return responseId;
}

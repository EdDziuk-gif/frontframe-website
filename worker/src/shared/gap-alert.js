// Gap-resolution-queue visibility: a lightweight SMS whenever a
// gap_resolution_requests row is created, so an unresolved visitor question
// doesn't sit unseen. Best-effort - never blocks or fails the visitor reply.
//
// Decision 21 (2026-10-01): everything sent out to the Operator is covered by
// the consent rule, and the visitor has consented to nothing at this point. So
// this alert carries no visitor text, only the reason and the page. The Operator
// reads the question itself in the admin screen.

import { sendSms } from "./runtime.js";

export async function alertGapResolutionQueue(env, ctx, page, reason) {
  ctx.waitUntil(
    sendSms(env,
      `FrontFrame gap queue\nReason: ${reason}\nPage: ${page}\n` +
      `A visitor question needs a person. Open the admin queue to read it.`
    ).catch((e) => console.error("gap-resolution-queue alert failed:", e))
  );
}

-- Phase 3 — post-generation constitutional conformance check.
-- Adds one route_reason value used by createConstitutionalNonconformanceLifecycle():
--   constitutional_nonconformance - a candidate answer that already cleared the
--     pre-generation constitutional-ELIGIBILITY check (route_reason
--     'constitutional_candidate' is the question-side rejection) and, for an
--     ordinary answer, Phase D scoring — but was withheld post-generation
--     because its own content conflicts with a Constitution provision.
--     Distinct from 'constitutional_candidate' so a human reviewer can tell
--     whether the QUESTION or the ANSWER was the problem.
--
-- Companion to migration 008 (widens the same CHECK). Run this against the live
-- project before deploying the conformance-check change.

alter table public.routes drop constraint if exists routes_route_reason_check;

alter table public.routes add constraint routes_route_reason_check
  check (route_reason = any (array[
    'scr'::text,
    'knowledge_gap'::text,
    'constitutional_candidate'::text,
    'kb_grounded'::text,
    'source_conflict'::text,
    'scr_fallthrough'::text,
    'constitutional_nonconformance'::text
  ]));

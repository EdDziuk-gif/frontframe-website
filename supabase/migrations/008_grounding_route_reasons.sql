-- Defect 95ebc11f — grounding verification for _kb_grounded answers.
-- Adds three route_reason values used by createGroundingLifecycle():
--   kb_grounded      - answer verified faithful to the promulgated corpus
--   source_conflict  - the corpus contradicts itself on the answered point
--   scr_fallthrough  - _kb_grounded claim failed verification; re-scored via SCR
--
-- The Phase D routes table's original DDL is not version-controlled in this repo
-- (it was created directly in Supabase during Phase D/E). This migration only
-- widens the route_reason CHECK; run it against the live project before deploying
-- the grounding change.

alter table public.routes drop constraint if exists routes_route_reason_check;

alter table public.routes add constraint routes_route_reason_check
  check (route_reason = any (array[
    'scr'::text,
    'knowledge_gap'::text,
    'constitutional_candidate'::text,
    'kb_grounded'::text,
    'source_conflict'::text,
    'scr_fallthrough'::text
  ]));

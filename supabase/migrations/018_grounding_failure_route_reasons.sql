-- Decision 0034, item 7 (amended 2026-10-01): a _kb_grounded answer whose grounding
-- score is below the low threshold, or whose Grounding Verifier produced no usable
-- result, is withheld and escalated to a person. It no longer falls through to SCR.
-- Adds two route_reason values (route_decision stays 'resolve_gap'):
--   grounding_below_floor  - the Verifier scored the answer below the low threshold
--   grounding_unavailable  - the Verifier call failed or returned an unusable result
-- 'scr_fallthrough' stays allowed for historical rows (0 rows use it) and is no
-- longer written.
--
-- This list is the LIVE constraint as read from the database on 2026-10-01
-- (routes_route_reason_check) plus the two new values. It does not add or drop
-- any other value. Check the migration list for this name before applying.
-- Apply this BEFORE deploying the worker change: the worker writes the new values.
--
-- APPLIED to the live project (ifjsepyzdnpmwyuytppr) on 2026-10-01 as migration
-- version 20261001233516, name grounding_failure_route_reasons. The statements
-- below are exactly what ran. The migration runner supplies its own transaction,
-- so there is no begin/commit here.
--
-- Rollback (only if no routes row uses the new values; check first):
--   select count(*) from public.routes
--     where route_reason in ('grounding_below_floor','grounding_unavailable');
--   -- if 0: re-run the constraint below without those two values.

alter table public.routes drop constraint if exists routes_route_reason_check;

alter table public.routes add constraint routes_route_reason_check
  check (route_reason = any (array[
	'scr'::text,
	'knowledge_gap'::text,
	'constitutional_candidate'::text,
	'kb_grounded'::text,
	'source_conflict'::text,
	'scr_fallthrough'::text,
	'constitutional_nonconformance'::text,
	'grounding_below_floor'::text,
	'grounding_unavailable'::text
  ]));


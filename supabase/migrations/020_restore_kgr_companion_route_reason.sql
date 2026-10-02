-- Restore route_reason 'kgr_companion' (added by migration 014, lost since).
--
-- open_companion_case() (migration 014) inserts routes(route_decision='resolve_gap',
-- route_reason='kgr_companion'). A later rewrite of routes_route_reason_check
-- rebuilt the list without that value, so every "Open companion case" fails with
--   new row for relation "routes" violates check constraint "routes_route_reason_check"
-- (found 2026-10-01 when Ed opened a companion case from Case #7).
--
-- This list is the LIVE constraint as read from the database on 2026-10-01
-- (the nine values in migration 018) plus 'kgr_companion'. It adds one value and
-- drops none. No row uses 'kgr_companion' yet (no companion case has ever been
-- created), so adding it cannot fail on existing data.
--
-- The migration runner supplies its own transaction, so there is no begin/commit.
--
-- Rollback (only if no routes row uses it; check first):
--   select count(*) from public.routes where route_reason = 'kgr_companion';
--   -- if 0: re-run the constraint below without 'kgr_companion'.

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
	'grounding_unavailable'::text,
	'kgr_companion'::text
  ]));

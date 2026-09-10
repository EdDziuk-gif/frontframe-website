-- =============================================================================
-- Migration 015 — KGR corpus-write privileges (database-enforcement layer)
--
-- This is part (e) of scratchpad/kgr-corpus-write-governance-plan.md §4.1, split
-- out of migration 014 because it needs facilities PGlite does not implement:
--   * CREATE ROLE ... BYPASSRLS  (role attributes)
--   * ALTER FUNCTION ... OWNER TO / SECURITY DEFINER role-switching
--
-- What it does:
--   * creates kgr_corpus_writer — a NOLOGIN BYPASSRLS role that owns the only
--     write path into the promulgated corpus,
--   * grants that role exactly the objects + verbs sign_off_kgr_resolution
--     touches, and nothing else,
--   * revokes INSERT/UPDATE/DELETE/TRUNCATE on qa_pairs, system_prompt and
--     system_prompt_history from service_role (the Worker's role) and everyone
--     else — service_role keeps SELECT and keeps EXECUTE on the sign-off RPC,
--   * promotes sign_off_kgr_resolution to SECURITY DEFINER and reassigns it to
--     kgr_corpus_writer, so a reviewer's sign-off call still publishes while a
--     direct `INSERT INTO qa_pairs` from the Worker is refused by the database.
--
-- REQUIRES: real PostgreSQL, run by a role with CREATEROLE (verified on the
-- production project: postgres has rolcreaterole = true, rolbypassrls = true,
-- and owns qa_pairs / system_prompt). Do NOT apply on the PGlite isolated-DB
-- harness — 014 alone is the harness-applicable slice.
--
-- FALLBACK: if a staging check shows Supabase re-grants service_role corpus DML
-- after a committed migration (e.g. via a platform role-sync) and that cannot be
-- prevented, do not apply 015. 014 on its own is the application-enforced model:
-- the editor write routes are gone and the Worker is trusted not to write the
-- corpus outside sign-off. 015 is the belt-and-braces the plan asks for; it is
-- not load-bearing for correctness of the lifecycle logic.
--
-- STAGING VERIFICATION after applying (see plan §4.5):
--   \df+ public.sign_off_kgr_resolution      -- Owner = kgr_corpus_writer, Security = definer
--   SELECT grantee, privilege_type FROM information_schema.role_table_grants
--     WHERE table_name = 'qa_pairs' AND grantee = 'service_role';
--     -- expect SELECT only; no INSERT/UPDATE/DELETE
--   -- then reload the schema / reconnect and re-run the grant query: the revoke
--   -- must still hold (grant-persistence check).
-- =============================================================================

BEGIN;

-- ── the corpus-writer role ────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'kgr_corpus_writer') THEN
    CREATE ROLE kgr_corpus_writer NOLOGIN BYPASSRLS;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO kgr_corpus_writer;

-- `ALTER FUNCTION public.sign_off_kgr_resolution(...) OWNER TO kgr_corpus_writer`
-- below is refused ("permission denied for schema public", SQLSTATE 42501)
-- unless the NEW owner can itself CREATE in the function's schema — Postgres
-- enforces that reassigning ownership can't do anything the new owner could not
-- do by dropping and recreating the object. kgr_corpus_writer is NOLOGIN and
-- only the DDL role is ever a member, so this CREATE grant is not an application
-- surface. (Verified necessary on a Supabase branch 2026-09-10: without it, 015
-- fails at the OWNER TO line and the whole migration rolls back.)
GRANT CREATE ON SCHEMA public TO kgr_corpus_writer;

-- The migration role must be a member of kgr_corpus_writer to run
-- `ALTER FUNCTION ... OWNER TO kgr_corpus_writer` below. On PG 16+ the creator of
-- a role is auto-granted membership; restate it so the migration is portable if
-- the role already existed. Only the DDL role becomes a member — no application
-- role does.
GRANT kgr_corpus_writer TO CURRENT_USER;

-- ── the grant contract: exactly what sign_off_kgr_resolution touches ──────────
GRANT SELECT, INSERT, UPDATE ON public.qa_pairs                  TO kgr_corpus_writer;
GRANT SELECT, INSERT, UPDATE ON public.system_prompt             TO kgr_corpus_writer;
GRANT SELECT, INSERT         ON public.system_prompt_history     TO kgr_corpus_writer;  -- no update/delete: immutable
GRANT SELECT, UPDATE         ON public.kgr_cases                 TO kgr_corpus_writer;  -- SELECT: read the target; UPDATE: FOR UPDATE OF k
GRANT SELECT, UPDATE         ON public.kgr_resolution_statements TO kgr_corpus_writer;  -- the back-links
GRANT SELECT, DELETE         ON public.kgr_resolution_candidates TO kgr_corpus_writer;  -- 0033/0035 pruning
GRANT SELECT, DELETE         ON public.kgr_hypotheses            TO kgr_corpus_writer;
GRANT SELECT, DELETE         ON public.kgr_candidate_solutions   TO kgr_corpus_writer;
GRANT SELECT, UPDATE         ON public.gap_resolution_requests   TO kgr_corpus_writer;  -- the closure stamp

-- Sequences the INSERTs above advance (IDENTITY / serial columns).
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO kgr_corpus_writer;

-- ── the Worker's role loses direct corpus DML ────────────────────────────────
-- service_role is the only role that must be revoked (it BYPASSRLS). anon /
-- authenticated are already blocked by RLS-with-no-policy on both corpus tables;
-- revoking them as well is harmless and makes the intent explicit.
--
-- REVOKE ALL, then re-GRANT SELECT: Supabase's default privileges hand every new
-- table ALL (7 privileges) to service_role, so a verb-list REVOKE of the four
-- write verbs leaves REFERENCES + TRIGGER behind (confirmed on a Supabase branch
-- 2026-09-10). Neither writes a row, but the intent is "SELECT and nothing
-- else", so take it all back and grant exactly SELECT.
REVOKE ALL ON public.qa_pairs      FROM service_role, authenticated, anon, PUBLIC;
REVOKE ALL ON public.system_prompt FROM service_role, authenticated, anon, PUBLIC;
GRANT  SELECT ON public.qa_pairs      TO service_role;
GRANT  SELECT ON public.system_prompt TO service_role;

-- system_prompt_history: service_role reads it (BYPASSRLS + this grant) for case
-- display; it can never write it. anon / authenticated blocked by RLS-no-policy.
REVOKE ALL ON public.system_prompt_history FROM service_role, authenticated, anon, PUBLIC;
GRANT  SELECT ON public.system_prompt_history TO service_role;

-- ── promote the sign-off RPC to the corpus-writer's authority ────────────────
-- The body is defined in 014 (schema-qualified, SET search_path = ''). Here it
-- becomes SECURITY DEFINER and is reassigned to kgr_corpus_writer, so a
-- reviewer's sign-off still publishes while a direct corpus write from
-- service_role is refused.
ALTER FUNCTION public.sign_off_kgr_resolution(BIGINT, BIGINT, UUID) SECURITY DEFINER;
ALTER FUNCTION public.sign_off_kgr_resolution(BIGINT, BIGINT, UUID) OWNER TO kgr_corpus_writer;

-- EXECUTE grants (also set in 014; restated so 015 is self-contained if 014's
-- were ever altered).
REVOKE EXECUTE ON FUNCTION public.sign_off_kgr_resolution(BIGINT, BIGINT, UUID) FROM PUBLIC, anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.sign_off_kgr_resolution(BIGINT, BIGINT, UUID) TO service_role;

COMMIT;

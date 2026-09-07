-- =============================================================================
-- Migration 009 — KGR sign-off publishes an implemented Q&A row
--
-- Defect correction (not a new increment). Two problems in migration 007's
-- sign_off_kgr_resolution():
--
--   A. The qa_pairs INSERT omits status, so the adopted answer is recorded at
--      the table default (under_review) and is excluded by buildQaPairsQuery,
--      which reads only status = 'implemented'. Sign-off would complete but
--      the answer would never reach visitor generation.
--
--   B. The qa_pairs INSERT sets source = 'kgr', but qa_pairs_source_check
--      permits only 'seed' | 'testing' | 'live'. The INSERT raises 23514,
--      which rolls back the whole atomic function: no sign-off, no prune, no
--      publication. sign_off_kgr_resolution has therefore never completed in
--      production (0 signed-off statements, 0 source = 'kgr' rows). The
--      earlier Increment 4 closure evidence established case viewing and
--      controls, not a successful sign-off.
--
-- This migration widens qa_pairs_source_check to allow 'kgr' and replaces the
-- function so its qa_pairs INSERT sets status = 'implemented'. Everything else
-- from the 007 function is preserved byte-for-byte: signature, RETURNS TABLE
-- shape, candidate lookup, the WHERE signed_off_at IS NULL concurrency guard,
-- candidates-then-hypotheses prune order, the qa_pair_id back-link,
-- RETURN QUERY, LANGUAGE plpgsql (SECURITY INVOKER by default), and the
-- service-role-only EXECUTE privileges.
--
-- Constraint, function, and grants are applied together in one transaction.
-- Database-only deployment; no Worker or UI change. No existing-data repair
-- is required.
-- =============================================================================

BEGIN;

ALTER TABLE qa_pairs DROP CONSTRAINT IF EXISTS qa_pairs_source_check;
ALTER TABLE qa_pairs ADD CONSTRAINT qa_pairs_source_check
  CHECK (source = ANY (ARRAY['seed'::text, 'testing'::text, 'live'::text, 'kgr'::text]));

CREATE OR REPLACE FUNCTION sign_off_kgr_resolution(
  p_statement_id BIGINT,
  p_candidate_id BIGINT,
  p_signed_off_by UUID
) RETURNS TABLE(statement_id BIGINT, qa_pair_id UUID)
LANGUAGE plpgsql
AS $$
DECLARE
  v_claimed_id BIGINT;
  v_problem_statement TEXT;
  v_presented_content TEXT;
  v_qa_pair_id UUID;
  v_pruned_hypothesis_ids BIGINT[];
BEGIN
  SELECT c.presented_content INTO v_presented_content
  FROM kgr_resolution_candidates c
  WHERE c.id = p_candidate_id AND c.kgr_resolution_statement_id = p_statement_id;
  IF v_presented_content IS NULL THEN
    RAISE EXCEPTION 'candidate % does not belong to statement %', p_candidate_id, p_statement_id;
  END IF;

  UPDATE kgr_resolution_statements
  SET selected_candidate_id = p_candidate_id,
      signed_off_by = p_signed_off_by,
      signed_off_at = now()
  WHERE id = p_statement_id AND signed_off_at IS NULL
  RETURNING id, problem_statement INTO v_claimed_id, v_problem_statement;

  IF v_claimed_id IS NULL THEN
    RAISE EXCEPTION 'statement % is already signed off', p_statement_id;
  END IF;

  SELECT array_agg(kgr_hypothesis_id) INTO v_pruned_hypothesis_ids
  FROM kgr_resolution_candidates
  WHERE kgr_resolution_statement_id = p_statement_id AND id != p_candidate_id;

  DELETE FROM kgr_resolution_candidates
  WHERE kgr_resolution_statement_id = p_statement_id AND id != p_candidate_id;

  DELETE FROM kgr_hypotheses
  WHERE id = ANY(v_pruned_hypothesis_ids);

  INSERT INTO qa_pairs (question, answer, page, source, status)
  VALUES (v_problem_statement, v_presented_content, 'all', 'kgr', 'implemented')
  RETURNING id INTO v_qa_pair_id;

  UPDATE kgr_resolution_statements SET qa_pair_id = v_qa_pair_id WHERE id = p_statement_id;

  RETURN QUERY SELECT v_claimed_id, v_qa_pair_id;
END;
$$;

-- CREATE OR REPLACE FUNCTION preserves the existing ACL; these are restated
-- for parity with migration 007 and to stay correct if the function is ever
-- dropped and recreated from this file.
REVOKE EXECUTE ON FUNCTION sign_off_kgr_resolution(BIGINT, BIGINT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION sign_off_kgr_resolution(BIGINT, BIGINT, UUID) TO service_role;

COMMIT;

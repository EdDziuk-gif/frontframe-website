-- =============================================================================
-- Migration 012 — KGR Increment 5, sign-off replacement
--
-- Replaces sign_off_kgr_resolution so selection ranges over the many-per-
-- hypothesis snapshot and pruning is N:1-safe. Decision 0035 (proposed): a
-- losing solution does not justify deleting a hypothesis that also supports the
-- selected solution.
--
-- Every migration-009 invariant is carried forward UNCHANGED:
--   * signature (BIGINT, BIGINT, UUID); RETURNS TABLE(statement_id, qa_pair_id)
--   * candidate-ownership check
--   * WHERE signed_off_at IS NULL guard -> 'statement % is already signed off'
--   * publication row: page='all', source='kgr', status='implemented'
--   * qa_pair_id back-link on the statement
--   * LANGUAGE plpgsql (SECURITY INVOKER); EXECUTE to service_role only,
--     revoked from PUBLIC, anon, authenticated
--
-- What changes:
--   * a FOR UPDATE lock on the case row, so sign-off serializes against any
--     late submit/withdraw/prepare (amendment 5)
--   * pruned-hypothesis set = (hypotheses of losing snapshot candidates)
--       EXCEPT (the selected candidate's hypothesis)
--       EXCEPT (any hypothesis not still 'accepted' - falsified hypotheses and
--               research notes are preserved under Decision 0033)
--   * every kgr_candidate_solutions row for the case is deleted (losing,
--     withdrawn, and the winner's source row) after its provenance is already
--     on the surviving snapshot row; origin_solution_id nulls via ON DELETE
--     SET NULL. No hidden archive of unselected alternatives (amendment 4).
--   * only the winning kgr_resolution_candidates row survives (unchanged from
--     009 - losing snapshot rows are still deleted).
-- =============================================================================

BEGIN;

CREATE OR REPLACE FUNCTION sign_off_kgr_resolution(
  p_statement_id  BIGINT,
  p_candidate_id  BIGINT,
  p_signed_off_by UUID
) RETURNS TABLE(statement_id BIGINT, qa_pair_id UUID)
LANGUAGE plpgsql
AS $$
DECLARE
  v_claimed_id            BIGINT;
  v_case_id               BIGINT;
  v_problem_statement     TEXT;
  v_presented_content     TEXT;
  v_winner_hypothesis_id  BIGINT;
  v_qa_pair_id            UUID;
  v_pruned_hypothesis_ids BIGINT[];
BEGIN
  -- Selected candidate must belong to this statement.
  SELECT c.presented_content, c.kgr_hypothesis_id
    INTO v_presented_content, v_winner_hypothesis_id
  FROM kgr_resolution_candidates c
  WHERE c.id = p_candidate_id AND c.kgr_resolution_statement_id = p_statement_id;
  IF v_presented_content IS NULL THEN
    RAISE EXCEPTION 'candidate % does not belong to statement %', p_candidate_id, p_statement_id;
  END IF;

  -- Serialize against any late submit/withdraw/prepare on the same case.
  SELECT s.kgr_case_id INTO v_case_id
  FROM kgr_resolution_statements s
  JOIN kgr_cases k ON k.id = s.kgr_case_id
  WHERE s.id = p_statement_id
  FOR UPDATE OF k;

  UPDATE kgr_resolution_statements
  SET selected_candidate_id = p_candidate_id,
      signed_off_by = p_signed_off_by,
      signed_off_at = now()
  WHERE id = p_statement_id AND signed_off_at IS NULL
  RETURNING id, problem_statement INTO v_claimed_id, v_problem_statement;

  IF v_claimed_id IS NULL THEN
    RAISE EXCEPTION 'statement % is already signed off', p_statement_id;
  END IF;

  -- Hypotheses of the losing snapshot candidates, minus the winner's own
  -- hypothesis (it may be shared), minus anything no longer 'accepted'.
  SELECT array_agg(DISTINCT c.kgr_hypothesis_id) INTO v_pruned_hypothesis_ids
  FROM kgr_resolution_candidates c
  JOIN kgr_hypotheses h ON h.id = c.kgr_hypothesis_id
  WHERE c.kgr_resolution_statement_id = p_statement_id
    AND c.id <> p_candidate_id
    AND c.kgr_hypothesis_id <> v_winner_hypothesis_id
    AND h.status = 'accepted';

  -- Losing snapshot candidates (only the winner survives).
  DELETE FROM kgr_resolution_candidates
  WHERE kgr_resolution_statement_id = p_statement_id AND id <> p_candidate_id;

  -- Every contributed solution row for the case: losing, withdrawn, and the
  -- winner's source row. Provenance is already denormalized onto the surviving
  -- snapshot candidate; origin_solution_id nulls via ON DELETE SET NULL.
  DELETE FROM kgr_candidate_solutions WHERE kgr_case_id = v_case_id;

  -- The now-unused accepted hypotheses.
  IF v_pruned_hypothesis_ids IS NOT NULL THEN
    DELETE FROM kgr_hypotheses WHERE id = ANY(v_pruned_hypothesis_ids);
  END IF;

  INSERT INTO qa_pairs (question, answer, page, source, status)
  VALUES (v_problem_statement, v_presented_content, 'all', 'kgr', 'implemented')
  RETURNING id INTO v_qa_pair_id;

  UPDATE kgr_resolution_statements SET qa_pair_id = v_qa_pair_id WHERE id = p_statement_id;

  RETURN QUERY SELECT v_claimed_id, v_qa_pair_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION sign_off_kgr_resolution(BIGINT, BIGINT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION sign_off_kgr_resolution(BIGINT, BIGINT, UUID) TO service_role;

COMMIT;

-- =============================================================================
-- Migration 007 — KGR resolution sign-off (Phase F Candidate 2, Increment 4)
--
-- Turns a prepared kgr_resolution_statement into a decision: Management
-- selects one candidate, that selection is recorded, the unselected
-- candidates (and their now-unused hypotheses) are pruned, and the selected
-- candidate's content is published as a new qa_pairs row - all as one
-- atomic transaction (sign_off_kgr_resolution), so a mid-write failure
-- leaves no partial sign-off, no partial prune, and no orphaned qa_pairs row.
--
-- Deletion order is candidates-then-hypotheses because
-- kgr_resolution_candidates.kgr_hypothesis_id references kgr_hypotheses(id)
-- with no ON DELETE cascade: deleting a pruned hypothesis before its
-- candidate row would violate that foreign key, so the candidate rows for
-- every unselected hypothesis are deleted first, and only then are the
-- unselected hypotheses themselves deleted.
--
-- The WHERE signed_off_at IS NULL guard on the statement UPDATE is what
-- actually prevents two concurrent sign-off attempts on the same statement
-- from both succeeding - the losing call's UPDATE affects zero rows, which
-- the function turns into an explicit "already signed off" exception rather
-- than silently doing nothing.
-- =============================================================================

ALTER TABLE kgr_resolution_statements
  ADD COLUMN selected_candidate_id BIGINT REFERENCES kgr_resolution_candidates(id),
  ADD COLUMN signed_off_by         UUID REFERENCES reviewers(id),
  ADD COLUMN signed_off_at         TIMESTAMPTZ,
  ADD COLUMN qa_pair_id            UUID REFERENCES qa_pairs(id);

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

  INSERT INTO qa_pairs (question, answer, page, source)
  VALUES (v_problem_statement, v_presented_content, 'all', 'kgr')
  RETURNING id INTO v_qa_pair_id;

  UPDATE kgr_resolution_statements SET qa_pair_id = v_qa_pair_id WHERE id = p_statement_id;

  RETURN QUERY SELECT v_claimed_id, v_qa_pair_id;
END;
$$;

-- NOTE: this project's migrations do not reference `service_role`/`anon`/
-- `authenticated` role names anywhere prior to this file (checked via grep
-- across supabase/migrations/*.sql), so these names could not be confirmed
-- against this project's actual Supabase role configuration. They match
-- Supabase's own standard role names and are left as-is; if this project
-- uses different role names, update this GRANT/REVOKE before applying.
REVOKE EXECUTE ON FUNCTION sign_off_kgr_resolution(BIGINT, BIGINT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION sign_off_kgr_resolution(BIGINT, BIGINT, UUID) TO service_role;

-- =============================================================================
-- Migration 011 — KGR Increment 5, functions
--
--   * submit_kgr_solution              — atomic checked-solution insert
--   * withdraw_kgr_solution            — atomic in_development withdrawal
--   * ready_kgr_case                   — guarded readiness (coverage rule)
--   * prepare_kgr_resolution_statement — server-derived freeze-and-snapshot
--   * DROP save_kgr_resolution_statement (migration 006) — obsolete
--
-- Every function opens with SELECT ... FROM kgr_cases WHERE id = ... FOR UPDATE
-- so the status recheck, the freeze, and the snapshot copy all serialize on the
-- one case row (amendment 5). The model calls (constitutional screen, SCR
-- score) happen in the Worker BEFORE these functions; their results are passed
-- in and the transaction rechecks eligibility before persisting (design §2).
--
-- Privileges are set explicitly on the 007/009 pattern - REVOKE FROM PUBLIC,
-- anon, authenticated then GRANT TO service_role - never relying on the default
-- (migration 006 shows the default is PUBLIC) (amendment 6).
-- =============================================================================

BEGIN;

-- ── submit_kgr_solution ─────────────────────────────────────────────────────
-- p_problem_snapshot is the problem text the Worker screened and scored
-- against. On the first contribution for a case it becomes
-- kgr_cases.contribution_problem_snapshot; on every later contribution it MUST
-- equal the stored value, otherwise the Worker scored against stale text and
-- the caller must re-read and re-score (raises 'problem snapshot mismatch').
CREATE OR REPLACE FUNCTION submit_kgr_solution(
  p_case_id             BIGINT,
  p_hypothesis_id       BIGINT,
  p_proposed_content    TEXT,
  p_origin              TEXT,
  p_submitted_by        UUID,
  p_score               NUMERIC,
  p_rationale           TEXT,
  p_provisions_hash     TEXT,
  p_problem_snapshot    TEXT,
  p_submission_key      TEXT
) RETURNS SETOF kgr_candidate_solutions
LANGUAGE plpgsql
AS $$
DECLARE
  v_case_status   TEXT;
  v_stored_problem TEXT;
  v_hyp_status    TEXT;
  v_existing      kgr_candidate_solutions%ROWTYPE;
  v_new_id        BIGINT;
BEGIN
  IF p_origin NOT IN ('human', 'assistant_assisted') THEN
    RAISE EXCEPTION 'origin must be human or assistant_assisted';
  END IF;
  IF p_proposed_content IS NULL OR btrim(p_proposed_content) = '' THEN
    RAISE EXCEPTION 'proposed_content is required';
  END IF;
  IF p_submission_key IS NULL OR btrim(p_submission_key) = '' THEN
    RAISE EXCEPTION 'submission_key is required';
  END IF;
  IF p_score IS NULL OR p_score < 0 OR p_score > 1 THEN
    RAISE EXCEPTION 'score must be between 0 and 1';
  END IF;
  IF p_rationale IS NULL OR btrim(p_rationale) = '' THEN
    RAISE EXCEPTION 'rationale is required';
  END IF;
  IF p_provisions_hash IS NULL OR btrim(p_provisions_hash) = '' THEN
    RAISE EXCEPTION 'constitutional_provisions_hash is required';
  END IF;
  IF p_problem_snapshot IS NULL OR btrim(p_problem_snapshot) = '' THEN
    RAISE EXCEPTION 'problem_snapshot is required';
  END IF;

  -- Serialize every contribution/withdraw/ready/prepare for this case.
  SELECT status, contribution_problem_snapshot
    INTO v_case_status, v_stored_problem
  FROM kgr_cases WHERE id = p_case_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % not found', p_case_id;
  END IF;
  IF v_case_status <> 'in_development' THEN
    RAISE EXCEPTION 'case % is % - contributions are closed', p_case_id, v_case_status;
  END IF;

  -- Retry identity: same key + same content -> return the saved row;
  -- same key + different content -> conflict.
  SELECT * INTO v_existing
  FROM kgr_candidate_solutions
  WHERE kgr_case_id = p_case_id
    AND submitted_by = p_submitted_by
    AND submission_key = p_submission_key;
  IF FOUND THEN
    IF v_existing.proposed_content = p_proposed_content THEN
      RETURN NEXT v_existing;
      RETURN;
    END IF;
    RAISE EXCEPTION 'submission_key % already used for different content', p_submission_key;
  END IF;

  -- The hypothesis must be accepted and on this case.
  SELECT status INTO v_hyp_status
  FROM kgr_hypotheses WHERE id = p_hypothesis_id AND kgr_case_id = p_case_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'hypothesis % is not on case %', p_hypothesis_id, p_case_id;
  END IF;
  IF v_hyp_status <> 'accepted' THEN
    RAISE EXCEPTION 'hypothesis % is % - a solution may only be contributed against an accepted hypothesis', p_hypothesis_id, v_hyp_status;
  END IF;

  -- Establish or verify the case-level contribution problem snapshot.
  IF v_stored_problem IS NULL THEN
    UPDATE kgr_cases
      SET contribution_problem_snapshot = p_problem_snapshot, updated_at = now()
      WHERE id = p_case_id;
  ELSIF v_stored_problem <> p_problem_snapshot THEN
    RAISE EXCEPTION 'problem snapshot mismatch - re-read the case and re-score against contribution_problem_snapshot';
  END IF;

  INSERT INTO kgr_candidate_solutions (
    kgr_case_id, kgr_hypothesis_id, proposed_content, submitted_by, origin,
    score, rationale, constitutional_provisions_hash, problem_snapshot, submission_key
  ) VALUES (
    p_case_id, p_hypothesis_id, p_proposed_content, p_submitted_by, p_origin,
    p_score, p_rationale, p_provisions_hash, p_problem_snapshot, p_submission_key
  )
  RETURNING id INTO v_new_id;

  RETURN QUERY SELECT * FROM kgr_candidate_solutions WHERE id = v_new_id;
END;
$$;

-- ── withdraw_kgr_solution ───────────────────────────────────────────────────
-- Only the submitter or Management (p_actor_role = 'frontframe_admin') may
-- withdraw, and only while the case is in_development. A repeat withdrawal of
-- an already-withdrawn row is idempotent.
CREATE OR REPLACE FUNCTION withdraw_kgr_solution(
  p_case_id     BIGINT,
  p_solution_id BIGINT,
  p_actor_id    UUID,
  p_actor_role  TEXT,
  p_reason      TEXT
) RETURNS SETOF kgr_candidate_solutions
LANGUAGE plpgsql
AS $$
DECLARE
  v_case_status TEXT;
  v_sol         kgr_candidate_solutions%ROWTYPE;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'a withdrawal reason is required';
  END IF;

  SELECT status INTO v_case_status FROM kgr_cases WHERE id = p_case_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % not found', p_case_id;
  END IF;

  SELECT * INTO v_sol
  FROM kgr_candidate_solutions
  WHERE id = p_solution_id AND kgr_case_id = p_case_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'solution % is not on case %', p_solution_id, p_case_id;
  END IF;

  IF v_sol.status = 'withdrawn' THEN
    RETURN NEXT v_sol;   -- idempotent
    RETURN;
  END IF;

  IF v_case_status <> 'in_development' THEN
    RAISE EXCEPTION 'case % is % - solutions can no longer be withdrawn', p_case_id, v_case_status;
  END IF;

  IF NOT (p_actor_id = v_sol.submitted_by OR p_actor_role = 'frontframe_admin') THEN
    RAISE EXCEPTION 'only the contributor or Management may withdraw this solution';
  END IF;

  UPDATE kgr_candidate_solutions
    SET status = 'withdrawn',
        withdrawn_by = p_actor_id,
        withdrawn_reason = p_reason,
        withdrawn_at = now()
    WHERE id = p_solution_id;

  RETURN QUERY SELECT * FROM kgr_candidate_solutions WHERE id = p_solution_id;
END;
$$;

-- ── ready_kgr_case ──────────────────────────────────────────────────────────
-- Guarded readiness. Serializes on the case row, then requires: zero untested
-- hypotheses, at least one accepted hypothesis, and at least one ACTIVE
-- contributed solution for EVERY accepted hypothesis (design §4 coverage rule;
-- several active solutions per hypothesis are fine). Moving to
-- ready_for_decision closes contributions - submit/withdraw then reject.
CREATE OR REPLACE FUNCTION ready_kgr_case(p_case_id BIGINT)
RETURNS SETOF kgr_cases
LANGUAGE plpgsql
AS $$
DECLARE
  v_status         TEXT;
  v_untested       INT;
  v_accepted       INT;
  v_uncovered      INT;
BEGIN
  SELECT status INTO v_status FROM kgr_cases WHERE id = p_case_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % not found', p_case_id;
  END IF;
  IF v_status <> 'in_development' THEN
    RAISE EXCEPTION 'case % is already %', p_case_id, v_status;
  END IF;

  SELECT count(*) INTO v_untested
  FROM kgr_hypotheses WHERE kgr_case_id = p_case_id AND status = 'untested';
  IF v_untested > 0 THEN
    RAISE EXCEPTION 'case % has % untested hypothesis(es)', p_case_id, v_untested;
  END IF;

  SELECT count(*) INTO v_accepted
  FROM kgr_hypotheses WHERE kgr_case_id = p_case_id AND status = 'accepted';
  IF v_accepted = 0 THEN
    RAISE EXCEPTION 'case % has no accepted hypothesis', p_case_id;
  END IF;

  -- Every accepted hypothesis must have at least one active solution.
  SELECT count(*) INTO v_uncovered
  FROM kgr_hypotheses h
  WHERE h.kgr_case_id = p_case_id
    AND h.status = 'accepted'
    AND NOT EXISTS (
      SELECT 1 FROM kgr_candidate_solutions s
      WHERE s.kgr_hypothesis_id = h.id AND s.status = 'active'
    );
  IF v_uncovered > 0 THEN
    RAISE EXCEPTION 'case % has % accepted hypothesis(es) with no active contributed solution', p_case_id, v_uncovered;
  END IF;

  RETURN QUERY
  UPDATE kgr_cases
    SET status = 'ready_for_decision', updated_at = now()
    WHERE id = p_case_id
    RETURNING *;
END;
$$;

-- ── prepare_kgr_resolution_statement ────────────────────────────────────────
-- Server-derived freeze-and-snapshot. Replaces save_kgr_resolution_statement
-- (migration 006): no client-supplied candidate array, no rescoring, no model
-- call. Copies EVERY active solution for the case into kgr_resolution_candidates
-- with its exact content, score, rationale, and provenance. Idempotent: a
-- repeat returns the existing statement (the UNIQUE on kgr_case_id and the
-- FOR UPDATE lock both guard concurrent prepares).
CREATE OR REPLACE FUNCTION prepare_kgr_resolution_statement(
  p_case_id     BIGINT,
  p_prepared_by UUID
) RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  v_status       TEXT;
  v_problem      TEXT;
  v_existing_id  BIGINT;
  v_statement_id BIGINT;
  v_active_count INT;
BEGIN
  SELECT status, contribution_problem_snapshot
    INTO v_status, v_problem
  FROM kgr_cases WHERE id = p_case_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % not found', p_case_id;
  END IF;
  IF v_status <> 'ready_for_decision' THEN
    RAISE EXCEPTION 'case % must be ready_for_decision to prepare (is %)', p_case_id, v_status;
  END IF;

  SELECT id INTO v_existing_id
  FROM kgr_resolution_statements WHERE kgr_case_id = p_case_id;
  IF FOUND THEN
    RETURN v_existing_id;   -- idempotent
  END IF;

  IF v_problem IS NULL OR btrim(v_problem) = '' THEN
    RAISE EXCEPTION 'case % has no contribution problem snapshot', p_case_id;
  END IF;

  SELECT count(*) INTO v_active_count
  FROM kgr_candidate_solutions WHERE kgr_case_id = p_case_id AND status = 'active';
  IF v_active_count = 0 THEN
    RAISE EXCEPTION 'case % has no active solutions to snapshot', p_case_id;
  END IF;

  INSERT INTO kgr_resolution_statements (kgr_case_id, problem_statement, prepared_by)
  VALUES (p_case_id, v_problem, p_prepared_by)
  RETURNING id INTO v_statement_id;

  INSERT INTO kgr_resolution_candidates (
    kgr_resolution_statement_id, kgr_hypothesis_id, presented_content, score, rationale,
    origin_solution_id, submitted_by, origin, constitutional_provisions_hash, problem_snapshot
  )
  SELECT
    v_statement_id, s.kgr_hypothesis_id, s.proposed_content, s.score, s.rationale,
    s.id, s.submitted_by, s.origin, s.constitutional_provisions_hash, s.problem_snapshot
  FROM kgr_candidate_solutions s
  WHERE s.kgr_case_id = p_case_id AND s.status = 'active'
  ORDER BY s.id;

  RETURN v_statement_id;
END;
$$;

-- ── retire the obsolete client-supplied-candidate prepare path ──────────────
-- Replaced by prepare_kgr_resolution_statement above. It currently sits at the
-- PostgreSQL default PUBLIC EXECUTE (migration 006 issued no grant); dropping
-- it removes the client-supplied candidate/score array path entirely.
DROP FUNCTION IF EXISTS save_kgr_resolution_statement(BIGINT, TEXT, UUID, JSONB);

-- ── privileges (amendment 6) ───────────────────────────────────────────────
REVOKE EXECUTE ON FUNCTION submit_kgr_solution(BIGINT, BIGINT, TEXT, TEXT, UUID, NUMERIC, TEXT, TEXT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION withdraw_kgr_solution(BIGINT, BIGINT, UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION ready_kgr_case(BIGINT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION prepare_kgr_resolution_statement(BIGINT, UUID) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION submit_kgr_solution(BIGINT, BIGINT, TEXT, TEXT, UUID, NUMERIC, TEXT, TEXT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION withdraw_kgr_solution(BIGINT, BIGINT, UUID, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION ready_kgr_case(BIGINT) TO service_role;
GRANT EXECUTE ON FUNCTION prepare_kgr_resolution_statement(BIGINT, UUID) TO service_role;

COMMIT;

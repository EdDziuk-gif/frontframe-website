-- =============================================================================
-- Migration 013 — KGR Increment 5, shared atomic freeze guard for the
-- pre-existing development-write paths
--
-- Increments 2-3 wrote research notes, hypotheses and hypothesis dispositions
-- with a PostgREST read-then-write (fetch status -> check in_development ->
-- patch/insert). That is a TOCTOU: ready_kgr_case (migration 011) takes
-- SELECT ... FROM kgr_cases FOR UPDATE and freezes the case, but these paths
-- take no lock, so a write can still land on a case another session has just
-- frozen.
--
-- This migration moves each of those writes into a guarded function that opens
-- with the same SELECT ... FROM kgr_cases WHERE id = p_case_id FOR UPDATE, so
-- every development write, readiness, contribution, withdrawal, preparation and
-- sign-off now serialize on the one case row. Validation semantics are
-- unchanged from the Increment 2-3 handlers: disposition only from 'untested'
-- to 'accepted'/'falsified', mandatory non-blank test_notes on a disposition,
-- no re-disposition, escalation only from in_development.
--
-- Privileges are set explicitly (REVOKE FROM PUBLIC, anon, authenticated then
-- GRANT TO service_role). Forward-only; migrations 005-012 are not altered.
-- =============================================================================

BEGIN;

-- ── update_kgr_research_notes ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_kgr_research_notes(
  p_case_id BIGINT,
  p_notes   TEXT
) RETURNS SETOF kgr_cases
LANGUAGE plpgsql
AS $$
DECLARE
  v_status TEXT;
BEGIN
  SELECT status INTO v_status FROM kgr_cases WHERE id = p_case_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % not found', p_case_id;
  END IF;
  IF v_status <> 'in_development' THEN
    RAISE EXCEPTION 'case % is % and is frozen', p_case_id, v_status;
  END IF;

  RETURN QUERY
  UPDATE kgr_cases SET research_notes = p_notes, updated_at = now()
    WHERE id = p_case_id
    RETURNING *;
END;
$$;

-- ── add_kgr_hypothesis ─────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION add_kgr_hypothesis(
  p_case_id     BIGINT,
  p_description TEXT,
  p_created_by  UUID
) RETURNS SETOF kgr_hypotheses
LANGUAGE plpgsql
AS $$
DECLARE
  v_status TEXT;
  v_new_id BIGINT;
BEGIN
  IF p_description IS NULL OR btrim(p_description) = '' THEN
    RAISE EXCEPTION 'description is required';
  END IF;

  SELECT status INTO v_status FROM kgr_cases WHERE id = p_case_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % not found', p_case_id;
  END IF;
  IF v_status <> 'in_development' THEN
    RAISE EXCEPTION 'case % is % and cannot take new hypotheses', p_case_id, v_status;
  END IF;

  INSERT INTO kgr_hypotheses (kgr_case_id, description, status, created_by)
  VALUES (p_case_id, btrim(p_description), 'untested', p_created_by)
  RETURNING id INTO v_new_id;

  RETURN QUERY SELECT * FROM kgr_hypotheses WHERE id = v_new_id;
END;
$$;

-- ── dispose_kgr_hypothesis ─────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION dispose_kgr_hypothesis(
  p_case_id       BIGINT,
  p_hypothesis_id BIGINT,
  p_status        TEXT,
  p_test_notes    TEXT
) RETURNS SETOF kgr_hypotheses
LANGUAGE plpgsql
AS $$
DECLARE
  v_case_status TEXT;
  v_hyp_status  TEXT;
BEGIN
  IF p_status NOT IN ('accepted', 'falsified') THEN
    RAISE EXCEPTION 'status must be accepted or falsified';
  END IF;
  IF p_test_notes IS NULL OR btrim(p_test_notes) = '' THEN
    RAISE EXCEPTION 'test_notes is required when disposing a hypothesis';
  END IF;

  SELECT status INTO v_case_status FROM kgr_cases WHERE id = p_case_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % not found', p_case_id;
  END IF;
  IF v_case_status <> 'in_development' THEN
    RAISE EXCEPTION 'case % is % and its hypotheses cannot be disposed', p_case_id, v_case_status;
  END IF;

  SELECT status INTO v_hyp_status
  FROM kgr_hypotheses WHERE id = p_hypothesis_id AND kgr_case_id = p_case_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'hypothesis % is not on case %', p_hypothesis_id, p_case_id;
  END IF;
  IF v_hyp_status <> 'untested' THEN
    RAISE EXCEPTION 'hypothesis % is already % and cannot be changed again', p_hypothesis_id, v_hyp_status;
  END IF;

  RETURN QUERY
  UPDATE kgr_hypotheses
    SET status = p_status, test_notes = btrim(p_test_notes), updated_at = now()
    WHERE id = p_hypothesis_id
    RETURNING *;
END;
$$;

-- ── escalate_kgr_case ──────────────────────────────────────────────────────
-- The constitutional-eligibility model call happens in the Worker BEFORE this;
-- only the confirmed-candidate path calls this function, with the issue text.
CREATE OR REPLACE FUNCTION escalate_kgr_case(
  p_case_id BIGINT,
  p_reason  TEXT
) RETURNS SETOF kgr_cases
LANGUAGE plpgsql
AS $$
DECLARE
  v_status TEXT;
BEGIN
  IF p_reason IS NULL OR btrim(p_reason) = '' THEN
    RAISE EXCEPTION 'an escalation reason is required';
  END IF;

  SELECT status INTO v_status FROM kgr_cases WHERE id = p_case_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'case % not found', p_case_id;
  END IF;
  IF v_status <> 'in_development' THEN
    RAISE EXCEPTION 'case % is already %', p_case_id, v_status;
  END IF;

  RETURN QUERY
  UPDATE kgr_cases
    SET status = 'escalated', escalation_reason = p_reason, updated_at = now()
    WHERE id = p_case_id
    RETURNING *;
END;
$$;

REVOKE EXECUTE ON FUNCTION update_kgr_research_notes(BIGINT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION add_kgr_hypothesis(BIGINT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION dispose_kgr_hypothesis(BIGINT, BIGINT, TEXT, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION escalate_kgr_case(BIGINT, TEXT) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION update_kgr_research_notes(BIGINT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION add_kgr_hypothesis(BIGINT, TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION dispose_kgr_hypothesis(BIGINT, BIGINT, TEXT, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION escalate_kgr_case(BIGINT, TEXT) TO service_role;

COMMIT;

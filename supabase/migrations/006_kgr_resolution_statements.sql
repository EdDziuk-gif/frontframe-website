-- =============================================================================
-- Migration 006 — KGR resolution statement preparation (Phase F Candidate 2, Increment 3)
--
-- Turns a kgr_cases row marked ready_for_decision into a durable resolution
-- statement: the original question, each accepted hypothesis's presented
-- content, its appropriateness score + rationale, and who prepared it. This
-- increment does not select among candidates, sign off, promulgate, or
-- notify anyone - it prepares the record a later, separately-approved
-- increment will act on.
--
-- Deliberately NOT reused: the legacy resolution_statements/
-- resolution_statement_candidates tables from the original Phase B DDL
-- (see claude/phase_b_lifecycle_ddl.sql). Their candidate row hard-requires
-- FKs into candidate_answers/scores - the visitor-chat scoring pipeline's
-- own tables, unrelated to kgr_hypotheses - and their status enum already
-- includes 'signed_off', which is out of this increment's scope. Two new,
-- small, KGR-specific tables avoid both problems, the same reasoning
-- Increment 2 already applied by not reusing gap_resolution_work.
-- =============================================================================

CREATE TABLE IF NOT EXISTS kgr_resolution_statements (
  id                BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kgr_case_id       BIGINT      NOT NULL UNIQUE REFERENCES kgr_cases(id),
  problem_statement TEXT        NOT NULL,
  prepared_by       UUID        NOT NULL REFERENCES reviewers(id),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE kgr_resolution_statements IS
  'One durable resolution statement per kgr_case (1:1, enforced by the UNIQUE constraint on kgr_case_id - the same idempotency pattern as kgr_cases.gap_resolution_request_id). Prepared by Management or Staff from a ready_for_decision case. problem_statement is copied verbatim from the case''s originating question at preparation time so the statement stays durable and self-contained even if upstream text changes later. No status/selection/sign-off column exists here on purpose: existence of this row IS the "prepared" state. A later, separately-approved increment adds whatever decision-recording columns it needs via its own migration.';

CREATE TABLE IF NOT EXISTS kgr_resolution_candidates (
  id                          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kgr_resolution_statement_id BIGINT      NOT NULL REFERENCES kgr_resolution_statements(id),
  kgr_hypothesis_id           BIGINT      NOT NULL UNIQUE REFERENCES kgr_hypotheses(id),
  presented_content           TEXT        NOT NULL,
  score                       NUMERIC     NOT NULL CHECK (score >= 0 AND score <= 1),
  rationale                   TEXT        NOT NULL,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE kgr_resolution_candidates IS
  'One row per accepted hypothesis presented in a kgr_resolution_statement. UNIQUE on kgr_hypothesis_id prevents the same accepted hypothesis appearing twice, across this or any other statement. presented_content is the reviewer-submitted text scored and stored exactly as given - the server never substitutes or rewrites it, even though the admin UI prefills it from the hypothesis''s own description as a convenience. score/rationale are stored directly (not via a foreign key into the unrelated visitor-chat scores table) via scoreCandidateAnswer(), called once per candidate. A low score does not exclude a candidate from this table - no threshold/routing logic reads or writes here.';

CREATE INDEX IF NOT EXISTS idx_kgr_resolution_candidates_statement_id
  ON kgr_resolution_candidates(kgr_resolution_statement_id);

-- Atomic save: the statement row and every candidate row are written in one
-- transaction (a PL/pgSQL function body is one transaction) so a mid-write
-- failure leaves neither an orphaned statement nor a partial candidate set.
-- The UNIQUE constraint on kgr_case_id is what actually prevents two
-- simultaneous prepare requests from both succeeding - one insert wins,
-- the other raises unique_violation and the caller (kgr.js) treats that as
-- "someone else just prepared this," re-fetching and returning the winner's
-- statement rather than erroring opaquely.
CREATE OR REPLACE FUNCTION save_kgr_resolution_statement(
  p_case_id BIGINT,
  p_problem_statement TEXT,
  p_prepared_by UUID,
  p_candidates JSONB
) RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  v_statement_id BIGINT;
BEGIN
  INSERT INTO kgr_resolution_statements (kgr_case_id, problem_statement, prepared_by)
  VALUES (p_case_id, p_problem_statement, p_prepared_by)
  RETURNING id INTO v_statement_id;

  INSERT INTO kgr_resolution_candidates
    (kgr_resolution_statement_id, kgr_hypothesis_id, presented_content, score, rationale)
  SELECT
    v_statement_id,
    (c->>'hypothesis_id')::BIGINT,
    c->>'presented_content',
    (c->>'score')::NUMERIC,
    c->>'rationale'
  FROM jsonb_array_elements(p_candidates) AS c;

  RETURN v_statement_id;
END;
$$;

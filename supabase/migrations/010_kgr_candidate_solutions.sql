-- =============================================================================
-- Migration 010 — KGR Increment 5, schema
--
-- Human-contributed candidate solutions under equal rigor. Schema only:
--   * kgr_candidate_solutions          — one row per contributed solution
--   * kgr_cases.contribution_problem_snapshot — frozen problem text, set on the
--     first contribution and reused for every later one and for preparation
--   * kgr_resolution_candidates        — drop the one-per-hypothesis UNIQUE;
--     add nullable provenance columns
--
-- Functions are migration 011; the sign-off replacement is migration 012.
-- Migrations 005-009 are not altered retroactively. Case #1 is not touched.
--
-- The deploy-window KGR mutation pause (amendment 7) is a runtime KV toggle
-- read by the Worker, not a schema object - nothing to add here.
--
-- Agreed design + seven amendments, 2026-09-07.
-- =============================================================================

BEGIN;

-- ── kgr_cases: case-level contribution problem snapshot ──────────────────────
-- Set once, on the first successful solution contribution (migration 011
-- submit_kgr_solution), and reused verbatim for every later contribution and
-- for preparation, so all solutions on a case are scored against one identical
-- problem text even if the upstream question text changes afterward. NULL until
-- the first contribution; existing cases (Case #1) keep NULL and are
-- unaffected. This column is written during in_development and is not a
-- research_notes/hypothesis edit, so it does not conflict with the
-- "frozen once status leaves in_development" rule.
ALTER TABLE kgr_cases
  ADD COLUMN IF NOT EXISTS contribution_problem_snapshot TEXT;

-- ── kgr_candidate_solutions ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kgr_candidate_solutions (
  id                             BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kgr_case_id                    BIGINT      NOT NULL REFERENCES kgr_cases(id),
  kgr_hypothesis_id              BIGINT      NOT NULL REFERENCES kgr_hypotheses(id),
  proposed_content               TEXT        NOT NULL,
  submitted_by                   UUID        NOT NULL REFERENCES reviewers(id),
  origin                         TEXT        NOT NULL
                                              CHECK (origin IN ('human', 'assistant_assisted')),
  score                          NUMERIC     NOT NULL CHECK (score >= 0 AND score <= 1),
  rationale                      TEXT        NOT NULL,
  constitutional_provisions_hash TEXT        NOT NULL,
  problem_snapshot               TEXT        NOT NULL,
  submission_key                 TEXT        NOT NULL,
  status                         TEXT        NOT NULL DEFAULT 'active'
                                              CHECK (status IN ('active', 'withdrawn')),
  withdrawn_by                   UUID        REFERENCES reviewers(id),
  withdrawn_reason               TEXT,
  withdrawn_at                   TIMESTAMPTZ,
  created_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Retry identity: a repeated submit with the same key from the same
  -- contributor on the same case resolves to the existing row; the same key
  -- with different content is a conflict (enforced in submit_kgr_solution,
  -- migration 011). Not exactly-once against the model call - only against
  -- persistence.
  CONSTRAINT kgr_candidate_solutions_retry_key
    UNIQUE (kgr_case_id, submitted_by, submission_key),

  -- Withdrawn rows carry all three withdrawal columns; active rows carry none.
  CONSTRAINT kgr_candidate_solutions_withdrawal_consistent CHECK (
    (status = 'active'
      AND withdrawn_by IS NULL AND withdrawn_reason IS NULL AND withdrawn_at IS NULL)
    OR
    (status = 'withdrawn'
      AND withdrawn_by IS NOT NULL AND withdrawn_reason IS NOT NULL AND withdrawn_at IS NOT NULL)
  )
);

COMMENT ON TABLE kgr_candidate_solutions IS
  'KGR Increment 5. One row per contributed proposed operational answer, each against an accepted hypothesis on the same in_development case; several contributors may offer different solutions for one hypothesis (N:1). proposed_content is immutable - editing means withdraw + submit anew, which re-runs the checks. score / rationale / constitutional_provisions_hash / problem_snapshot are the equal-rigor checks captured at contribution time (migration 011 submit_kgr_solution); a low or zero score never removes a row. origin is reviewer-declared provenance (human | assistant_assisted), never an authority credential. status active|withdrawn; only the submitter or Management may withdraw, in_development only (migration 011 withdraw_kgr_solution). On sign-off (migration 012) every row for the case is deleted - losing, withdrawn, and the winner''s source row - after the winner''s provenance is copied onto its kgr_resolution_candidates snapshot row; no hidden archive. Worker-only access: RLS enabled with no policy (service_role has BYPASSRLS); the sibling KGR tables from migrations 005-007 rely on the absence of anon/authenticated grants instead and are not retrofitted here.';

CREATE INDEX IF NOT EXISTS idx_kgr_candidate_solutions_case_id
  ON kgr_candidate_solutions (kgr_case_id);
CREATE INDEX IF NOT EXISTS idx_kgr_candidate_solutions_hypothesis_id
  ON kgr_candidate_solutions (kgr_hypothesis_id);

ALTER TABLE kgr_candidate_solutions ENABLE ROW LEVEL SECURITY;

-- ── kgr_resolution_candidates: many per hypothesis + carry provenance ────────
-- Drop the one-candidate-per-hypothesis restriction (migration 006 inline
-- UNIQUE, auto-named kgr_resolution_candidates_kgr_hypothesis_id_key). The
-- Increment 5 snapshot may hold several candidates that share a
-- kgr_hypothesis_id.
ALTER TABLE kgr_resolution_candidates
  DROP CONSTRAINT IF EXISTS kgr_resolution_candidates_kgr_hypothesis_id_key;

-- Provenance carried onto each frozen snapshot candidate. NULLable so the one
-- pre-Increment-5 row (statement #1 / Case #1) stays valid and readable with no
-- fabricated provenance. Migration 011 populates every column for Increment 5
-- snapshots. origin_solution_id is convenience only and is nulled when its
-- source row is pruned at sign-off.
ALTER TABLE kgr_resolution_candidates
  ADD COLUMN IF NOT EXISTS origin_solution_id BIGINT
    REFERENCES kgr_candidate_solutions(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS submitted_by UUID REFERENCES reviewers(id),
  ADD COLUMN IF NOT EXISTS origin TEXT
    CHECK (origin IS NULL OR origin IN ('human', 'assistant_assisted')),
  ADD COLUMN IF NOT EXISTS constitutional_provisions_hash TEXT,
  ADD COLUMN IF NOT EXISTS problem_snapshot TEXT;

COMMENT ON COLUMN kgr_resolution_candidates.origin_solution_id IS
  'The kgr_candidate_solutions row this snapshot candidate was frozen from. ON DELETE SET NULL: sign-off (migration 012) deletes every source row for the case after copying provenance into the sibling columns on this table - those columns, not this link, are the durable record.';

COMMIT;

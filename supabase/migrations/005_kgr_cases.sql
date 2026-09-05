-- =============================================================================
-- Migration 005 — KGR case development record (Phase F Candidate 2, Increment 2)
--
-- Adds the durable case-development record Increment 1 deliberately left
-- out: gap_resolution_requests.authorized_by/authorized_at record that an
-- Operator or Delegate permitted work to begin, but nothing recorded the
-- work itself. This migration adds exactly that - research notes,
-- hypotheses, their tests/dispositions - and nothing past it. No
-- resolution-statement, scoring, sign-off, or promulgation object is
-- created here; those remain later, separately-approved increments.
-- =============================================================================

CREATE TABLE IF NOT EXISTS kgr_cases (
  id                         BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  gap_resolution_request_id  BIGINT      NOT NULL UNIQUE
                                          REFERENCES gap_resolution_requests(id),
  status                     TEXT        NOT NULL DEFAULT 'in_development'
                                          CHECK (status IN ('in_development', 'ready_for_decision', 'escalated')),
  research_notes             TEXT,
  escalation_reason          TEXT,
  created_by                 UUID        NOT NULL REFERENCES reviewers(id),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE kgr_cases IS
  'One durable working case per authorized gap_resolution_requests row (1:1, enforced by the UNIQUE constraint). Created only by Management (frontframe_admin); developed (research_notes, hypotheses) by Management or Staff. Frozen (no further research_notes/hypothesis edits) once status leaves in_development. escalation_reason is set only when status = escalated, via checkConstitutionalEligibility(). No resolution-statement, scoring, sign-off, or promulgation path reads or writes this table as of Increment 2.';

CREATE TABLE IF NOT EXISTS kgr_hypotheses (
  id            BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kgr_case_id   BIGINT      NOT NULL REFERENCES kgr_cases(id),
  description   TEXT        NOT NULL,
  status        TEXT        NOT NULL DEFAULT 'untested'
                             CHECK (status IN ('untested', 'falsified', 'accepted')),
  test_notes    TEXT,
  created_by    UUID        NOT NULL REFERENCES reviewers(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE kgr_hypotheses IS
  'Hypotheses developed against a kgr_case (multiple per case; unresolved multiplicity is normal). Always reviewer-authored (created_by NOT NULL) - assistant-suggested text from /develop is never inserted directly, only returned for a reviewer to record themselves. No "replaced" status: replacing a hypothesis means marking the old one falsified (with test_notes explaining why) and adding a new row, preserving full history without an extra status value. A case may reach ready_for_decision only when zero hypotheses are untested and at least one is accepted.';

CREATE INDEX IF NOT EXISTS idx_kgr_hypotheses_case_id ON kgr_hypotheses(kgr_case_id);

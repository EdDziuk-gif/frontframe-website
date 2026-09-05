-- =============================================================================
-- Migration 004 — KGR intake authorization gate (Phase F Candidate 2, Increment 1)
--
-- gap_resolution_requests already exists live (created outside this repo's
-- migration history — a known reproducibility gap, see
-- "FrontFrame Agentic System — Current State.md"). This migration does not
-- recreate that table. It adds the one column needed to close a confirmed
-- infrastructure defect: authorized_by/authorized_at exist and are already
-- read by public/admin.html's Open/Authorized badge, but nothing records
-- what an Operator or Delegate is actually authorizing work on. Decision
-- 0023 (KGR is manual-bootstrap only) is unaffected — this migration adds
-- no resolution automation, only the authorization record itself.
-- =============================================================================

ALTER TABLE gap_resolution_requests
  ADD COLUMN IF NOT EXISTS permitted_scope TEXT;

COMMENT ON COLUMN gap_resolution_requests.permitted_scope IS
  'Set only by the /admin/gap-resolution-requests/:id/authorize action, together with authorized_by/authorized_at. Describes the scope of work an Operator or Delegate (frontframe_admin) has affirmatively authorized. Null until authorized. Not written by any other path.';

-- ============================================================
-- RECONSTRUCTED MIGRATION — NOT THE ORIGINAL FILE
--
-- This migration's version (20260904010250) is recorded in the live
-- project's remote migration history as
-- "harden_phase_f_candidate_1_rpc_execution", 55 seconds after
-- 20260904010155_restrict_phase_f_candidate_1_rpc_execution. The SQL
-- actually executed against production was never committed to this
-- repository.
--
-- Per the split note in 20260904010155, this file is inferred to be
-- the immediate follow-up that added search_path hardening to both
-- RPCs created in that migration. This inference is drawn from the
-- migration name ("harden") and the sub-minute gap between the two
-- versions; it is not a recovered historical fact. What is confirmed
-- is the combined end state: both functions currently have
-- `search_path = ''` set live, verified via a privileged catalog
-- query (config_settings) run 2026-09-14/15.
-- ============================================================

ALTER FUNCTION public.promulgate_constitutional_amendment(BIGINT, UUID)
  SET search_path = '';

ALTER FUNCTION public.record_authorization_incident(UUID, TEXT, TEXT, TEXT, TEXT, TEXT)
  SET search_path = '';

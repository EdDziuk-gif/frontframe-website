-- ============================================================
-- Organizational authority directly on reviewers; remove the
-- unauthorized roles/reviewer_roles/delegation apparatus.
--
-- Per the Operator's determination, the roles/reviewer_roles/
-- constitution_amendment_delegations apparatus (created outside any
-- tracked migration, first surfaced during the Constitutional Change
-- bootstrap inspection) was extraneous, unauthorized work from a
-- prior project. It is not reconstructed and is removed here.
--
-- The organizational chart is `reviewers` itself: one record per
-- person/seat, carrying that person's own authority directly. No
-- separate role catalog, no join table. can_amend_constitution and
-- can_grant_constitution_amendment are fields on the reviewer's own
-- record, matching Decision 0030's rule (the Operator holds both by
-- default and may grant can_amend_constitution to a Delegate; a
-- Delegate cannot grant it to anyone, including themself).
--
-- This migration does not grant these capabilities to any specific
-- person — assigning them to a named individual is a one-time,
-- separately audited data operation, not schema.
-- ============================================================

ALTER TABLE public.reviewers
  ADD COLUMN IF NOT EXISTS can_amend_constitution boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS can_grant_constitution_amendment boolean NOT NULL DEFAULT false;

DROP TABLE IF EXISTS public.constitution_amendment_delegations CASCADE;
DROP FUNCTION IF EXISTS public.enforce_constitution_delegation_authority();
DROP TABLE IF EXISTS public.reviewer_roles CASCADE;
DROP TABLE IF EXISTS public.roles CASCADE;

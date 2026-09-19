-- Migration: agreement_type column on agreements + proposals workflow tables
-- Date: 2026-09-19

-- ── 1. agreements: add agreement_type ────────────────────────────────────────
ALTER TABLE public.agreements
  ADD COLUMN IF NOT EXISTS agreement_type text
    NOT NULL
    DEFAULT 'due_diligence'
    CONSTRAINT agreements_type_check
      CHECK (agreement_type IN ('due_diligence', 'infrastructure'));

-- Backfill existing rows (all pre-existing agreements are due diligence letters)
UPDATE public.agreements
  SET agreement_type = 'due_diligence'
  WHERE agreement_type IS NULL;

-- ── 2. proposals ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.proposals (
  proposal_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id         uuid REFERENCES public.leads(id) ON DELETE SET NULL,
  lead_alert_id   uuid,
  session_id      uuid,
  prospect_name   text NOT NULL,
  prospect_email  text NOT NULL,
  status          text NOT NULL DEFAULT 'draft'
    CONSTRAINT proposals_status_check
      CHECK (status IN ('draft', 'sent', 'under_review', 'agreed', 'signed')),
  version         integer NOT NULL DEFAULT 1,
  internal_notes  text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  reviewed_at     timestamptz,
  signed_at       timestamptz
);

-- ── 3. proposal_sections ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.proposal_sections (
  section_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id     uuid NOT NULL REFERENCES public.proposals(proposal_id) ON DELETE CASCADE,
  sort_order      integer NOT NULL DEFAULT 0,
  title           text NOT NULL,
  content         text NOT NULL DEFAULT '',
  client_visible  boolean NOT NULL DEFAULT true,
  client_comment  text,
  flagged         boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS proposal_sections_proposal_id_idx
  ON public.proposal_sections(proposal_id);

-- ── 4. proposal_access ───────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.proposal_access (
  access_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  proposal_id uuid NOT NULL REFERENCES public.proposals(proposal_id) ON DELETE CASCADE,
  token       uuid NOT NULL DEFAULT gen_random_uuid() UNIQUE,
  expires_at  timestamptz,
  accessed_at timestamptz,
  ip_hash     text
);

CREATE INDEX IF NOT EXISTS proposal_access_token_idx
  ON public.proposal_access(token);

CREATE INDEX IF NOT EXISTS proposal_access_proposal_id_idx
  ON public.proposal_access(proposal_id);

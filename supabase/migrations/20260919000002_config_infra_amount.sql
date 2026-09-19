-- Migration: add infra_agreement_amount_cents to config
-- Stores the infrastructure agreement monthly amount in cents so it can be
-- edited from the Pipeline tab without a code deploy.

ALTER TABLE public.config
  ADD COLUMN IF NOT EXISTS infra_agreement_amount_cents integer NOT NULL DEFAULT 7500
    CONSTRAINT config_infra_amount_positive CHECK (infra_agreement_amount_cents > 0);

-- Seed the value on the single config row if it exists
UPDATE public.config SET infra_agreement_amount_cents = 7500 WHERE id = 1;

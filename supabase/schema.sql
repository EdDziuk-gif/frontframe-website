-- =============================================================================
-- FrontFrame — Supabase Schema
-- Full business lifecycle: prospect → onboarding → engagement → retention
-- =============================================================================


-- -----------------------------------------------------------------------------
-- NOTES ON PRODUCTION STATE
-- The inquiries table in production is a flat denormalized structure (see below).
-- The normalized contacts/clients/engagements/communications tables described
-- in the original design have not been built yet and are aspirational.
-- pipeline_stages and verticals exist as lookup tables but are not yet
-- foreign-keyed to inquiries — inquiries uses a status TEXT field instead.
-- Update this file as the schema evolves toward the normalized design.
--
-- 2026-07-21: Verified via live pg_dump that migration 001 (cold_outreach
-- columns below) had been committed to git since 2026-06-18 but was never
-- actually run against production — the columns did not exist live even
-- though worker/src/index.js already reads/writes them for the cold-outreach
-- admin feature. Apply 001 and 002 together to bring prod in line with this
-- file and the code.
-- -----------------------------------------------------------------------------


-- -----------------------------------------------------------------------------
-- LOOKUP TABLES
-- Created 2026-06-18. Not yet referenced by FK from inquiries.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS pipeline_stages (
  id         UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT    NOT NULL,
  sort_order INTEGER NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT true
);

CREATE TABLE IF NOT EXISTS verticals (
  id         UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT    NOT NULL,
  sort_order INTEGER NOT NULL
);


-- -----------------------------------------------------------------------------
-- INQUIRIES (production table — flat/denormalized)
-- One row per prospect regardless of origin.
-- source = 'inbound'       → prospect submitted a form via the site chat widget
-- source = 'cold_outreach' → Ed created the record before first contact
--
-- Cold outreach automation chain:
--   DocuSeal signed webhook  → sets contract_status='signed', fires Stripe payment link
--   Stripe paid webhook      → sets ddl_payment_paid_at, promotes record to client
--   DocuSeal expired webhook → sets contract_status='expired', notifies Ed
--   Expired without excuse   → hard close; record retained permanently in Closed Lost
-- -----------------------------------------------------------------------------

CREATE TABLE inquiries (
  id                  BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  owner_name          TEXT        NOT NULL,
  business_name       TEXT        NOT NULL,
  email               TEXT        NOT NULL,
  phone               TEXT,
  business_type       TEXT,
  tier_interest       TEXT,
  description         TEXT,
  source_page         TEXT        NOT NULL,
  status              TEXT        NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Cold outreach fields (added migration 001, 2026-06-18)
  source              TEXT        NOT NULL DEFAULT 'inbound'
                      CHECK (source IN ('inbound', 'cold_outreach')),
  research_notes      TEXT,
  prototype_subdomain TEXT,
  contract_status     TEXT        NOT NULL DEFAULT 'not_sent'
                      CHECK (contract_status IN ('not_sent', 'sent', 'signed', 'expired')),
  contract_sent_at    TIMESTAMPTZ,
  contract_expires_at TIMESTAMPTZ,
  ddl_payment_sent_at TIMESTAMPTZ,
  ddl_payment_paid_at TIMESTAMPTZ
);


-- -----------------------------------------------------------------------------
-- ROW-LEVEL SECURITY
-- Service role key (Worker) has full access (bypasses RLS by design).
-- Public/anon role has insert-only on inquiries, restricted to source='inbound'
-- (see migration 002 — cold_outreach rows may only be created by staff).
-- Staff (frontframe_admin/frontframe_staff, via is_reviewer()) get
-- select/insert/update on inquiries. Policies added in migration 002 —
-- RLS had been enabled here since day one with zero policies (deny-by-default
-- for anything not using service_role) until that migration.
-- -----------------------------------------------------------------------------

ALTER TABLE pipeline_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE verticals       ENABLE ROW LEVEL SECURITY;
ALTER TABLE inquiries       ENABLE ROW LEVEL SECURITY;

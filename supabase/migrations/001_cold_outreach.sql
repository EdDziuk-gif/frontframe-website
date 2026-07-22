-- =============================================================================
-- Migration 001 — Cold Outreach
-- Extends inquiries to support Ed-initiated cold prospect records alongside
-- existing inbound form submissions.
-- All changes are backwards-compatible. Existing rows default safely.
--
-- 2026-07-21 CORRECTION: this migration was committed 2026-06-18 but never
-- actually run against production. Two problems found when finally running it:
--   1. It assumed `pipeline_stages` already existed in production — it doesn't
--      (schema.sql documents it as "created 2026-06-18" but that create
--      statement was never run either). Added CREATE TABLE IF NOT EXISTS here.
--   2. It assumed inquiries had a `message` column to relax to nullable —
--      production's inquiries table has never had a `message` column (it uses
--      `description`, already nullable). That line is removed.
-- Every statement below is now idempotent (IF NOT EXISTS / WHERE NOT EXISTS),
-- so it's safe to run even if a previous partial attempt landed some of it.
-- =============================================================================


-- Ensure lookup tables exist (from schema.sql — committed but never created)
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

ALTER TABLE pipeline_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE verticals       ENABLE ROW LEVEL SECURITY;


-- Add Identified stage before all existing stages (idempotent)
-- Cold outreach records enter here before any contact is made
INSERT INTO pipeline_stages (name, sort_order, is_active)
SELECT 'Identified', 0, true
WHERE NOT EXISTS (SELECT 1 FROM pipeline_stages WHERE name = 'Identified');


-- Source: distinguishes Ed-initiated cold records from inbound form submissions
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'inbound'
  CHECK (source IN ('inbound', 'cold_outreach'));


-- Research notes: Ed's pre-approach findings, populated before first contact
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS research_notes TEXT;


-- Prototype subdomain: demo site URL assigned to this prospect
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS prototype_subdomain TEXT;


-- Contract lifecycle
-- contract_status is the only post-send state tracked.
-- DocuSeal webhook sets 'signed' (triggers Stripe payment link).
-- DocuSeal expiry webhook sets 'expired' (triggers Ed notification).
-- 'signed' and 'expired' are terminal states unless Ed manually reopens.
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS contract_status TEXT NOT NULL DEFAULT 'not_sent'
  CHECK (contract_status IN ('not_sent', 'sent', 'signed', 'expired'));

ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS contract_sent_at    TIMESTAMPTZ;
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS contract_expires_at TIMESTAMPTZ;


-- DDL payment
-- ddl_payment_sent_at: set automatically when DocuSeal signed webhook fires
-- ddl_payment_paid_at: set automatically when Stripe paid webhook fires
--   → payment cleared is the conversion event that promotes the record to client
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS ddl_payment_sent_at TIMESTAMPTZ;
ALTER TABLE inquiries ADD COLUMN IF NOT EXISTS ddl_payment_paid_at TIMESTAMPTZ;

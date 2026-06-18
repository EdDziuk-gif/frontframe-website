-- =============================================================================
-- Migration 001 — Cold Outreach
-- Extends inquiries to support Ed-initiated cold prospect records alongside
-- existing inbound form submissions.
-- All changes are backwards-compatible. Existing rows default safely.
-- =============================================================================


-- Add Identified stage before all existing stages
-- Cold outreach records enter here before any contact is made
INSERT INTO pipeline_stages (name, sort_order, is_active) VALUES
  ('Identified', 0, true);


-- Allow message to be null
-- Inbound records carry the prospect's form message.
-- Cold outreach records carry research_notes instead.
ALTER TABLE inquiries ALTER COLUMN message DROP NOT NULL;


-- Source: distinguishes Ed-initiated cold records from inbound form submissions
ALTER TABLE inquiries ADD COLUMN source TEXT NOT NULL DEFAULT 'inbound'
  CHECK (source IN ('inbound', 'cold_outreach'));


-- Research notes: Ed's pre-approach findings, populated before first contact
ALTER TABLE inquiries ADD COLUMN research_notes TEXT;


-- Prototype subdomain: demo site URL assigned to this prospect
ALTER TABLE inquiries ADD COLUMN prototype_subdomain TEXT;


-- Contract lifecycle
-- contract_status is the only post-send state tracked.
-- DocuSeal webhook sets 'signed' (triggers Stripe payment link).
-- DocuSeal expiry webhook sets 'expired' (triggers Ed notification).
-- 'signed' and 'expired' are terminal states unless Ed manually reopens.
ALTER TABLE inquiries ADD COLUMN contract_status TEXT NOT NULL DEFAULT 'not_sent'
  CHECK (contract_status IN ('not_sent', 'sent', 'signed', 'expired'));

ALTER TABLE inquiries ADD COLUMN contract_sent_at    TIMESTAMPTZ;
ALTER TABLE inquiries ADD COLUMN contract_expires_at TIMESTAMPTZ;


-- DDL payment
-- ddl_payment_sent_at: set automatically when DocuSeal signed webhook fires
-- ddl_payment_paid_at: set automatically when Stripe paid webhook fires
--   → payment cleared is the conversion event that promotes the record to client
ALTER TABLE inquiries ADD COLUMN ddl_payment_sent_at TIMESTAMPTZ;
ALTER TABLE inquiries ADD COLUMN ddl_payment_paid_at TIMESTAMPTZ;

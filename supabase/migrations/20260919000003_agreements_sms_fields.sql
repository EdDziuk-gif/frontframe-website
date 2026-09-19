-- Migration: add SMS opt-in fields to agreements table
-- Date: 2026-09-19
-- Reason: DocuSeal forms capture sms_opted_in checkbox and mobile number,
--         but the webhook handler was only storing status/document_url.
--         These columns allow the signed consent to be queried and used
--         for Surge provisioning without parsing the PDF.

ALTER TABLE public.agreements
  ADD COLUMN IF NOT EXISTS sms_opted_in  boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS sms_mobile    text;

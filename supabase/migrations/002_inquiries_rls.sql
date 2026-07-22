-- =============================================================================
-- Migration 002 — Inquiries RLS Policies
-- RLS has been enabled on public.inquiries since the original schema.sql,
-- but zero policies were ever written — meaning it's deny-by-default for
-- any connection that isn't the service_role key (the Worker's key bypasses
-- RLS entirely, so this has not caused a live outage, but it's a latent gap).
--
-- This mirrors the is_reviewer() pattern already enforced in production on
-- config / defects / feedback / reviewers.
-- =============================================================================

-- Public/anon: insert-only, and only for inbound form submissions.
-- Cold-outreach records may only be created by staff (see below) —
-- an anon visitor should never be able to insert a 'cold_outreach' row.
CREATE POLICY inquiries_insert_anon ON public.inquiries
  FOR INSERT TO anon
  WITH CHECK (source = 'inbound');

-- Staff (frontframe_admin, frontframe_staff): full read access to the pipeline.
CREATE POLICY inquiries_select_staff ON public.inquiries
  FOR SELECT TO authenticated
  USING (public.is_reviewer(ARRAY['frontframe_admin'::text, 'frontframe_staff'::text]));

-- Staff: create cold-outreach records from the admin.
CREATE POLICY inquiries_insert_staff ON public.inquiries
  FOR INSERT TO authenticated
  WITH CHECK (public.is_reviewer(ARRAY['frontframe_admin'::text, 'frontframe_staff'::text]));

-- Staff: update status / contract lifecycle / payment fields.
CREATE POLICY inquiries_update_staff ON public.inquiries
  FOR UPDATE TO authenticated
  USING (public.is_reviewer(ARRAY['frontframe_admin'::text, 'frontframe_staff'::text]));

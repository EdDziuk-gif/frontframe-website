-- =============================================================================
-- Migration 003 — Scheduling (blackout dates + consultation bookings)
-- Adds a real "schedule a call" feature to FrontFrame, ported from the
-- blackout-date-aware pattern proven in eleanor-website/intake.html.
--
-- Note: FrontFrame's existing DocuSeal integration (agreements table +
-- handleDocusealWebhook) already correctly marks agreements "signed" only on
-- the DocuSeal `submission.completed` webhook, not on send — so unlike
-- Eleanor's site, there is no confirm-on-send bug to port/fix here. This
-- migration only adds the scheduling piece; once a call is booked, Ed sends
-- the engagement agreement through the existing /admin/agreements/send flow.
-- =============================================================================

CREATE TABLE IF NOT EXISTS blackout_periods (
  id          BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  start_date  DATE        NOT NULL,
  end_date    DATE        NOT NULL,
  reason      TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date)
);

CREATE TABLE IF NOT EXISTS consultation_bookings (
  id             BIGINT      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name           TEXT        NOT NULL,
  email          TEXT        NOT NULL,
  business_name  TEXT,
  phone          TEXT,
  requested_date DATE        NOT NULL,
  slot_label     TEXT        NOT NULL,       -- e.g. "10:00 AM MST"
  notes          TEXT,
  inquiry_id     BIGINT      REFERENCES inquiries(id),
  status         TEXT        NOT NULL DEFAULT 'requested'
                 CHECK (status IN ('requested', 'confirmed', 'completed', 'cancelled')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (requested_date, slot_label)          -- one booking per slot
);

ALTER TABLE blackout_periods       ENABLE ROW LEVEL SECURITY;
ALTER TABLE consultation_bookings  ENABLE ROW LEVEL SECURITY;

-- blackout_periods: readable by anyone (needed for the public /blackout
-- lookup that drives the client-side date picker); only staff can write.
-- The Worker's /blackout GET is public and uses the service_role key anyway,
-- so this SELECT policy mainly protects any future direct/anon read path.
CREATE POLICY blackout_select_anon ON public.blackout_periods
  FOR SELECT TO anon, authenticated
  USING (true);

CREATE POLICY blackout_write_staff ON public.blackout_periods
  FOR ALL TO authenticated
  USING (public.is_reviewer(ARRAY['frontframe_admin'::text, 'frontframe_staff'::text]))
  WITH CHECK (public.is_reviewer(ARRAY['frontframe_admin'::text, 'frontframe_staff'::text]));

-- consultation_bookings: public/anon may only insert their own booking
-- request (via the Worker's /schedule endpoint); staff read/update/cancel.
CREATE POLICY bookings_insert_anon ON public.consultation_bookings
  FOR INSERT TO anon
  WITH CHECK (status = 'requested');

CREATE POLICY bookings_select_staff ON public.consultation_bookings
  FOR SELECT TO authenticated
  USING (public.is_reviewer(ARRAY['frontframe_admin'::text, 'frontframe_staff'::text]));

CREATE POLICY bookings_update_staff ON public.consultation_bookings
  FOR UPDATE TO authenticated
  USING (public.is_reviewer(ARRAY['frontframe_admin'::text, 'frontframe_staff'::text]));

CREATE POLICY bookings_delete_staff ON public.consultation_bookings
  FOR DELETE TO authenticated
  USING (public.is_reviewer(ARRAY['frontframe_admin'::text, 'frontframe_staff'::text]));

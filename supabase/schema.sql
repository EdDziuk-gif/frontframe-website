-- =============================================================================
-- FrontFrame — Supabase Schema
-- Full business lifecycle: prospect → onboarding → engagement → retention
-- =============================================================================


-- -----------------------------------------------------------------------------
-- LOOKUP TABLES
-- -----------------------------------------------------------------------------

-- pipeline_stages: ordered stages in the FrontFrame sales motion
-- Sort order is explicit so stages can be resequenced without a schema change
CREATE TABLE pipeline_stages (
  id         UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT    NOT NULL,
  sort_order INTEGER NOT NULL,
  is_active  BOOLEAN NOT NULL DEFAULT true
);

-- verticals: service business categories FrontFrame serves
CREATE TABLE verticals (
  id         UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  name       TEXT    NOT NULL,
  sort_order INTEGER NOT NULL
);


-- -----------------------------------------------------------------------------
-- CONTACTS
-- The person — one record regardless of lifecycle stage.
-- A prospect, a client, a lapsed client, and a returning client are all the
-- same contact. History links through here.
-- -----------------------------------------------------------------------------

CREATE TABLE contacts (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT        NOT NULL,
  email             TEXT        NOT NULL,
  phone             TEXT,
  preferred_contact TEXT        CHECK (preferred_contact IN ('email', 'phone', 'sms')),
  sms_opt_in        BOOLEAN     NOT NULL DEFAULT false,
  phone_verified    BOOLEAN     NOT NULL DEFAULT false,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- -----------------------------------------------------------------------------
-- PROSPECT PHASE
-- -----------------------------------------------------------------------------

-- inquiries: one row per form submission
-- Pipeline stage tracks where this prospect stands in the sales motion.
-- Proposal stubs (sent/responded timestamps) are lightweight now; promote to
-- their own table when proposal complexity warrants it.
-- Archiving captures why an inquiry went cold without deleting the record.
CREATE TABLE inquiries (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id            UUID        NOT NULL REFERENCES contacts(id),
  vertical_id           UUID        REFERENCES verticals(id),
  pipeline_stage_id     UUID        NOT NULL REFERENCES pipeline_stages(id),
  message               TEXT        NOT NULL,
  source_page           TEXT,
  submitted_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  proposal_sent_at      TIMESTAMPTZ,
  proposal_responded_at TIMESTAMPTZ,
  archived              BOOLEAN     NOT NULL DEFAULT false,
  archive_reason        TEXT,
  archived_at           TIMESTAMPTZ
);


-- -----------------------------------------------------------------------------
-- CLIENT PHASE
-- -----------------------------------------------------------------------------

-- clients: created when an inquiry converts to a paying engagement.
-- Links back to the originating inquiry. Nullable to allow clients created
-- outside the inquiry flow (referrals, direct outreach, etc.)
CREATE TABLE clients (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id   UUID        NOT NULL REFERENCES contacts(id),
  inquiry_id   UUID        REFERENCES inquiries(id),
  vertical_id  UUID        NOT NULL REFERENCES verticals(id),
  onboarded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  status       TEXT        NOT NULL DEFAULT 'active'
               CHECK (status IN ('active', 'inactive', 'churned'))
);

-- engagements: projects and platform builds delivered to a client.
-- A client may have more than one engagement over time (initial build,
-- add-ons, second vertical, etc.).
-- The details JSONB column holds vertical-specific data without requiring
-- a separate table per business type. Structure is formalized per vertical
-- as the platform matures.
CREATE TABLE engagements (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id      UUID        NOT NULL REFERENCES clients(id),
  title          TEXT        NOT NULL,
  description    TEXT,
  status         TEXT        NOT NULL DEFAULT 'scoping'
                 CHECK (status IN ('scoping', 'active', 'completed', 'cancelled')),
  contract_value NUMERIC(10,2),
  started_at     TIMESTAMPTZ,
  completed_at   TIMESTAMPTZ,
  details        JSONB,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- -----------------------------------------------------------------------------
-- COMMUNICATIONS
-- Unified log across the full lifecycle — prospect and client alike.
-- contact_id is always set. inquiry_id is set during prospect phase.
-- client_id is set once the contact converts.
-- Both FKs can coexist on the same row if a communication bridges phases.
-- -----------------------------------------------------------------------------

CREATE TABLE communications (
  id         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  contact_id UUID        NOT NULL REFERENCES contacts(id),
  inquiry_id UUID        REFERENCES inquiries(id),
  client_id  UUID        REFERENCES clients(id),
  direction  TEXT        NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  method     TEXT        NOT NULL CHECK (method IN ('email', 'phone', 'sms', 'note')),
  summary    TEXT        NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- -----------------------------------------------------------------------------
-- RETENTION
-- Periodic owner-initiated health review per client.
-- next_review_due drives the review queue — owner always knows who is due.
-- Health scale: good / watch / disengage (three-point, owner-defined).
-- -----------------------------------------------------------------------------

CREATE TABLE retention_reviews (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id       UUID        NOT NULL REFERENCES clients(id),
  reviewed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  health          TEXT        NOT NULL CHECK (health IN ('good', 'watch', 'disengage')),
  notes           TEXT,
  next_review_due DATE
);


-- -----------------------------------------------------------------------------
-- ROW-LEVEL SECURITY
-- Single-owner operation. RLS to be configured in Supabase dashboard.
-- Policy pattern: service role key (Worker) has full access.
-- Public/anon role has insert-only on inquiries (form submissions).
-- No direct public read access to any table.
-- -----------------------------------------------------------------------------

ALTER TABLE pipeline_stages   ENABLE ROW LEVEL SECURITY;
ALTER TABLE verticals         ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts          ENABLE ROW LEVEL SECURITY;
ALTER TABLE inquiries         ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients           ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagements       ENABLE ROW LEVEL SECURITY;
ALTER TABLE communications    ENABLE ROW LEVEL SECURITY;
ALTER TABLE retention_reviews ENABLE ROW LEVEL SECURITY;

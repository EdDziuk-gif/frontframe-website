-- =============================================================================
-- FrontFrame — Seed Data
-- Reference tables: pipeline_stages and verticals
-- =============================================================================


-- pipeline_stages: ordered sales motion
-- Identified (cold only) → New/Contacted → Qualified → Proposal → Closed Won/Lost
-- Identified: Ed found the prospect, no contact made yet (cold outreach only)
-- New:        Inbound form submission received
-- Contacted:  First outreach or response made
-- Qualified:  Interest confirmed (post-demo for cold; post-call for inbound)
-- Proposal:   Contract sent (cold) or proposal delivered (inbound)
-- Closed Won: DDL payment cleared — record promoted to client
-- Closed Lost: Hard close — retained permanently, no follow-up
INSERT INTO pipeline_stages (name, sort_order, is_active) VALUES
  ('Identified',  0, true),
  ('New',         1, true),
  ('Contacted',   2, true),
  ('Qualified',   3, true),
  ('Proposal',    4, true),
  ('Closed Won',  5, true),
  ('Closed Lost', 6, true);


-- verticals: FrontFrame target service business categories
INSERT INTO verticals (name, sort_order) VALUES
  ('Pet sitting and home services',        1),
  ('Bookkeeping and tax-adjacent services',2),
  ('Solo professional practices',          3),
  ('Wellness and coaching',                4),
  ('Other service businesses',             5);

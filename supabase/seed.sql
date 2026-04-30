-- =============================================================================
-- FrontFrame — Seed Data
-- Reference tables: pipeline_stages and verticals
-- =============================================================================


-- pipeline_stages: ordered sales motion
-- New → Contacted → Qualified → Proposal → Closed Won → Closed Lost
INSERT INTO pipeline_stages (name, sort_order, is_active) VALUES
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

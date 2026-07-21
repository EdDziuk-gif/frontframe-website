-- ============================================================
-- config
-- Single-row operational config (id = 1, always upserted)
-- ============================================================
create table if not exists config (
  id               integer      primary key default 1,
  mode             text         not null default 'live' check (mode in ('live', 'testing')),
  build_version    text         not null default 'unknown',
  stage_gate       text         not null default 'build',
  capture_enabled  boolean      not null default false,
  updated_at       timestamptz  not null default now(),
  constraint config_single_row check (id = 1)
);

-- Seed the one row so upserts always find it
insert into config (id) values (1) on conflict (id) do nothing;


-- ============================================================
-- defects
-- ============================================================
create table if not exists defects (
  id             bigint       generated always as identity primary key,
  area           text         not null check (area in ('bot','ui','content','form','payment','contract','other')),
  description    text         not null,
  severity       text         not null check (severity in ('blocking','major','minor','cosmetic')),
  disposition    text         not null default 'retain' check (disposition in ('retain','delete')),
  status         text         not null default 'open' check (status in ('open','in_review','resolved','deferred')),
  resolver_id    uuid         references auth.users (id) on delete set null,
  build_version  text         not null default 'unknown',
  stage_gate     text         not null default 'build',
  created_at     timestamptz  not null default now()
);


-- ============================================================
-- feedback
-- Auto-logged gap entries (testing mode) and manual entries
-- ============================================================
create table if not exists feedback (
  id                bigint       generated always as identity primary key,
  question          text         not null,
  ed_response       text,
  suggested_answer  text,
  promoted          boolean      not null default false,
  created_at        timestamptz  not null default now()
);


-- ============================================================
-- changelog
-- Read-only from the worker; populated manually or via trigger
-- ============================================================
create table if not exists changelog (
  id             bigint       generated always as identity primary key,
  build_version  text         not null,
  stage_gate     text,
  summary        text         not null,
  author         text,
  created_at     timestamptz  not null default now()
);


-- ============================================================
-- reviewers
-- id is the Supabase Auth user UUID from the invite response
-- ============================================================
create table if not exists reviewers (
  id             uuid         primary key references auth.users (id) on delete cascade,
  display_name   text         not null,
  role           text         not null check (role in ('frontframe_admin', 'frontframe_staff', 'contractor', 'client_tester')),
  engagement_id  uuid,
  active         boolean      not null default true,
  invited_at     timestamptz  not null default now()
);

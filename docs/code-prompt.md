# FrontFrame — Claude Code Session Prompt

_Use this as the opening prompt for every new Claude Code session on this project. It is self-contained. No prior context is needed._

---

## Project

You are building the FrontFrame website and business platform. FrontFrame builds and sells turnkey business platforms for small service businesses and solo professionals — website, intake, payments, contracts, and client portal, delivered ready to run from day one.

All strategic and architectural decisions are finalized. Your role is execution. Do not reopen decided items.

**Working directory:** `/Users/edwarddziuk/Development_Assets/FrontFrame_Website_CoWork/frontframe-site`

Read the following reference documents before writing any code:

- `/docs/brand.md` — brand language, tone, visual identity, copy
- `/docs/stack.md` — full technical stack, file structure, Worker architecture, and finalized database schema
- `/docs/status.md` — what is complete, in progress, and not yet started
- `/docs/team.md` — operator and engagement contacts

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | Static HTML / CSS / JS — no framework |
| Hosting | Cloudflare Pages |
| Backend | Cloudflare Workers, no-bundle deployment |
| Database | Supabase (PostgreSQL) — direct REST API fetch only, no supabase-js |
| Email | Resend |
| Bot protection | Cloudflare Turnstile on all public forms |
| DNS / Domain | Cloudflare — frontframe.com |

**Deployment:** `npx wrangler deploy --config /path/to/wrangler.toml --no-bundle`

The Worker is the only component that holds API keys. The frontend holds no secrets. All form submissions must pass Turnstile validation before any database write occurs.

---

## Visual Identity — Confirmed and Ready

**Colors:**

| Role | Hex |
|---|---|
| Blueprint blue (primary accent) | #183A63 |
| Structural gray (secondary) | #6F7680 |
| Pale background | #F3F6F8 |
| Warm accent (use sparingly) | #C88A52 |
| Near-black (body text) | #1C2128 |

**Typography — Option A (confirmed):**
- Headings: IBM Plex Sans Condensed — Google Fonts
- Body: Inter — Google Fonts

Load both from Google Fonts CDN. No local font files.

**Placeholder images** are in `/public/assets/img/`:
- `hero-placeholder.png` — blueprint elevation hero illustration
- `component-website.png`
- `component-intake.png`
- `component-esignature.png`
- `component-payments.png`
- `component-portal.png`

These are production-quality PNGs. Build around them. They will be replaced by SVGs from the designer without requiring HTML changes — use `<img>` tags with consistent class names and descriptive alt text.

---

## Brand Voice

Grounded, direct, practical, commercially credible. Not startup-like. Not agency-warm. Not technical for its own sake. Write copy as a trusted operator who has built things.

**Homepage hero headline:** Your business, built to open.
**Homepage hero subhead:** FrontFrame delivers complete, operational business platforms for service professionals — website, intake, payments, contracts, and client portal, ready to run from day one.

Full copy and taglines in `/docs/brand.md`.

---

## Pages to Build

| File | Page | Priority |
|---|---|---|
| index.html | Home | 1 — primary conversion surface |
| contact.html | Contact / Inquiry form | 1 — primary conversion point |
| how-it-works.html | How It Works | 2 |
| who-its-for.html | Who It's For | 2 |
| our-work.html | Our Work (case studies) | 2 |
| pricing.html | Pricing (placeholder) | 3 |
| about.html | About | 3 |

HTML stubs exist for all pages. CSS and JS files are stubbed at `/public/css/main.css` and `/public/js/main.js`.

**No login, no dashboard, no client portal at launch.**

---

## Database

The full schema is in `/supabase/schema.sql`. Seed data is in `/supabase/seed.sql`. Do not alter the schema without operator review.

Eight tables covering the full business lifecycle:

- `pipeline_stages` — lookup: New → Contacted → Qualified → Proposal → Closed Won → Closed Lost
- `verticals` — lookup: service business categories
- `contacts` — one record per person, persists across all lifecycle stages
- `inquiries` — one per form submission, FK to contacts + verticals + pipeline_stages
- `clients` — created on conversion, FK to contacts + original inquiry
- `engagements` — projects delivered per client, JSONB details column for vertical-specific data
- `communications` — unified log (prospect and client), tracks method: email / phone / sms / note
- `retention_reviews` — periodic client health checks, three-point scale: good / watch / disengage

---

## Worker — Inquiry Flow

On a valid inquiry form submission:
1. Validate Cloudflare Turnstile token — reject immediately if invalid, no DB write
2. Look up or create a `contacts` record for the submitting email
3. Write a row to `inquiries` linked to that contact, with pipeline_stage set to "New"
4. Send notification email to owner via Resend with prospect name, message, and a pre-populated `mailto:` reply link pointing to the prospect's email

All Supabase calls use direct REST API fetch with the service role key from Worker environment. Never use the supabase-js package.

---

## What to Build This Session

_Update this section at the start of each session based on `/docs/status.md`._

**Recommended starting sequence for first development session:**

1. Deploy schema and seed data to Supabase (run `schema.sql` then `seed.sql`)
2. Scaffold `wrangler.toml` with correct Worker name and compatibility date
3. Build `handleInquiry.js` — Turnstile validation, contact upsert, inquiry insert, Resend notification
4. Wire Worker routing in `index.js`
5. Build `main.css` — full design system: colors, typography, layout grid, component styles
6. Build `index.html` — Home page, fully styled
7. Build `contact.html` — inquiry form with Turnstile, wired to Worker endpoint

---

## Constraints and Decisions — Do Not Reopen

- Static HTML/CSS/JS only — no React, no Vue, no build step on the frontend
- No supabase-js — direct REST API fetch only
- No third-party chat widgets
- No WhatsApp integration
- Cloudflare Turnstile on every public form — no exceptions
- Worker is the sole secret holder
- Deployment via wrangler with --no-bundle flag

---

_Last updated: 2026-04-04_

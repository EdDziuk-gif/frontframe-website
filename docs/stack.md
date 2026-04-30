# FrontFrame — Technical Stack Reference

_This document is the canonical source for all technical decisions made to date. Do not revise without operator sign-off._

---

## Environment

**Machine:** MacBook, username `edwarddziuk`
**Production file path:** `/Users/edwarddziuk/Development_Assets/FrontFrame_Website_CoWork`
**Code editor:** Nova (Mac)

---

## Stack

| Layer | Technology | Notes |
|---|---|---|
| Frontend | Static HTML / CSS / JS | No framework |
| Hosting | Cloudflare Pages | Serves /public |
| Backend | Cloudflare Workers | No-bundle deployment |
| Database | Supabase (PostgreSQL) | Direct REST API fetch only — no supabase-js package |
| Email | Resend | Owner notification on inquiry submission |
| Payments | Stripe | Future phase — not at launch |
| Bot protection | Cloudflare Turnstile | All public forms |
| DNS / Domain | Cloudflare | frontframe.com (pending registration) |

---

## Deployment

```
npx wrangler deploy --config /path/to/wrangler.toml --no-bundle
```

The `--no-bundle` flag is required. Update the config path to the actual wrangler.toml location before use.

---

## Security Architecture

- The Worker is the only component that holds API keys
- The frontend holds no secrets
- All form submissions must be Turnstile-validated before any database write occurs

---

## File Structure

```
/frontframe-site
  /public
    index.html
    how-it-works.html
    who-its-for.html
    our-work.html
    pricing.html
    contact.html
    about.html
    /css
    /js
    /assets
      /svg
      /img
  /worker
    index.js
    /handlers
      handleInquiry.js
      handleContact.js
    wrangler.toml
  /supabase
    schema.sql
    seed.sql
  /docs
    brand.md
    stack.md
    status.md
    team.md
```

---

## Pages

| File | Page | Notes |
|---|---|---|
| index.html | Home | Hero, concept, how it works (3 steps), vertical examples, trust signals, CTA |
| how-it-works.html | How It Works | Detailed walkthrough of all platform components |
| who-its-for.html | Who It's For | Vertical-specific sections with anxiety/outcome framing |
| our-work.html | Our Work | Case study format. First: Elie's Bird Sitting / Eleanor's Avian Care, Phoenix AZ |
| pricing.html | Pricing | Placeholder — structure for future tiered pricing. Current CTA: contact to discuss |
| contact.html | Contact | Full inquiry form — primary conversion point |
| about.html | About | One paragraph on what FrontFrame is and who builds it |

No login, no dashboard, no client portal at launch.

---

## Worker Architecture

The Cloudflare Worker handles all backend logic. Entry point is `/worker/index.js`. Handlers are organized in `/worker/handlers/`.

### handleInquiry.js

Handles the main inquiry form submission from the Contact page. On valid submission:
1. Validates Turnstile token (reject if invalid — no DB write)
2. Writes record to `inquiries` table in Supabase via REST API
3. Sends notification email to owner via Resend, including a pre-populated `mailto:` reply link

### handleContact.js

Handles any secondary contact form flows (to be defined during development).

---

## Database Schema

Full lifecycle schema covering prospect → onboarding → engagement → retention. See `/supabase/schema.sql` for complete DDL and `/supabase/seed.sql` for reference data.

**General rules:** UUIDs as primary keys throughout. All timestamps include timezone (timestamptz). Row-level security enabled on all tables — service role key (Worker) has full access; public/anon role has insert-only on inquiries.

### pipeline_stages _(lookup)_

| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| name | text | New / Contacted / Qualified / Proposal / Closed Won / Closed Lost |
| sort_order | integer | Explicit ordering — resequence without migration |
| is_active | boolean | Default true |

### verticals _(lookup)_

| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| name | text | Service business category |
| sort_order | integer | |

### contacts

One record per person, regardless of lifecycle stage. Prospect, client, lapsed, and returning are all the same contact.

| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| name | text | |
| email | text | |
| phone | text | Optional |
| preferred_contact | text | email / phone / sms |
| sms_opt_in | boolean | Default false — Twilio future hook |
| phone_verified | boolean | Default false |
| created_at | timestamptz | |

### inquiries

One row per form submission. Pipeline stage tracks sales motion progress. Archiving captures why an inquiry went cold without deleting the record.

| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| contact_id | UUID | FK → contacts.id |
| vertical_id | UUID | FK → verticals.id |
| pipeline_stage_id | UUID | FK → pipeline_stages.id |
| message | text | |
| source_page | text | |
| submitted_at | timestamptz | |
| proposal_sent_at | timestamptz | Nullable stub — promote to own table when complexity warrants |
| proposal_responded_at | timestamptz | Nullable stub |
| archived | boolean | Default false |
| archive_reason | text | Why no engagement |
| archived_at | timestamptz | |

### clients

Created when an inquiry converts. inquiry_id nullable to allow clients from referrals or direct outreach.

| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| contact_id | UUID | FK → contacts.id |
| inquiry_id | UUID | FK → inquiries.id (nullable) |
| vertical_id | UUID | FK → verticals.id |
| onboarded_at | timestamptz | |
| status | text | active / inactive / churned |

### engagements

Projects and platform builds per client. One client may have multiple over time.

| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| client_id | UUID | FK → clients.id |
| title | text | |
| description | text | |
| status | text | scoping / active / completed / cancelled |
| contract_value | numeric(10,2) | |
| started_at | timestamptz | |
| completed_at | timestamptz | |
| details | JSONB | Vertical-specific data — structure varies by business type |
| created_at | timestamptz | |

### communications

Unified log for full lifecycle. contact_id always set. inquiry_id set during prospect phase. client_id set post-conversion.

| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| contact_id | UUID | FK → contacts.id |
| inquiry_id | UUID | FK → inquiries.id (nullable) |
| client_id | UUID | FK → clients.id (nullable) |
| direction | text | inbound / outbound |
| method | text | email / phone / sms / note |
| summary | text | |
| created_at | timestamptz | |

### retention_reviews

Periodic owner-initiated health check per client. next_review_due drives the queue.

| Column | Type | Notes |
|---|---|---|
| id | UUID | PK |
| client_id | UUID | FK → clients.id |
| reviewed_at | timestamptz | |
| health | text | good / watch / disengage |
| notes | text | |
| next_review_due | date | |

---

## Communication System

**Inquiry flow:**
1. Prospect submits inquiry form on /contact
2. Turnstile token validated by Worker
3. Record written to `inquiries` table in Supabase
4. Resend sends notification email to owner with pre-populated `mailto:` reply link
5. Owner replies directly from their email client

**No third-party chat widgets. No WhatsApp integration. No pre-established communication platforms.**

**Future:** SMS via Twilio. Hook columns (`sms_opt_in`, `phone_verified`) are already in the `contacts` table. SMS as a channel is already a valid value in `communications.method`. The Twilio send logic in the Worker is not implemented at launch.

---

## Supabase Access Pattern

All Supabase access is via direct REST API fetch calls from the Worker. The `supabase-js` package is not used. API keys are stored only in the Worker environment (via Wrangler secrets), never in frontend code.

---

_Last updated: 2026-04-04_

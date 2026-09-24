# FrontFrame Site — Backlog

## Cold Outreach — migrate off `inquiries` table

**Logged:** 2026-09-19

The `inquiries` table currently serves cold outreach prospect tracking
(`outreach.js`, `source=cold_outreach`). It carries fields that are outreach-
specific and have no equivalent in `leads`: `prototype_subdomain`,
`contract_status`, `contract_sent_at`, `contract_expires_at`,
`ddl_payment_sent_at`, `ddl_payment_paid_at`, `research_notes`.

Cold outreach contacts have shown no inbound interest at the time the record is
created, so they are not yet leads. The right long-term model is a dedicated
`outreach_prospects` table (or equivalent) that can graduate to a `leads` record
when the prospect responds positively.

**Work required:**
- Design `outreach_prospects` schema (or extend `leads` with an outreach
  sub-status and the outreach-specific columns).
- Migrate existing `inquiries` rows where `source = 'cold_outreach'` to the new
  table.
- Update `outreach.js` to read/write the new table.
- Drop or archive the `inquiries` table once the migration is clean.

**Inbound intake path is already fixed:** as of 2026-09-19 the intake form
(`handleInquiry`) writes directly to `leads` (source = 'intake'). The
`inquiries` table is no longer used for inbound submissions.

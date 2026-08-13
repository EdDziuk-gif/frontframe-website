# 2026-08-13 — Repo Rationalization and Charter Decisions

This file is a pointer, not the canonical record. The full decision
document lives in the `frontframe-engine` repo:
[frontframe-engine/docs/CHARTERS.md](https://github.com/EdDziuk-gif/frontframe-engine/blob/main/docs/CHARTERS.md).
Read it there — this stub exists only so someone browsing this repo's
`docs/` folder (alongside `brand.md`, `stack.md`, `status.md`, `team.md`)
finds out that decision exists and where to find it, without duplicating
or risking drift from the source of truth.

## What changes for this repo

Two decisions from that document affect `frontframe-website` directly:

1. **`frontframe-blueprint-template` is being folded into this repo.** The
   Blueprint capability (quick, config-driven prospect-facing concept
   delivery) is part of FrontFrame's own sales cycle and belongs alongside
   the rest of the sales/delivery CRM already here, not in a separate repo.
   **Not yet done** — this is a decision record, not a completed migration.
2. **This repo's existing operational tables (`leads`, `discovery_submissions`,
   `proposals`, `orders`, `deliverables`, `defects`, `qa_pairs`,
   `review_queue`, etc.) are not migrated and not replaced.** They become
   the operational substrate that FrontFrame's own onboarding-as-client-zero
   process (in `frontframe-engine`) observes and interviews about. No
   parallel gap-tracking schema should be added here to duplicate what
   `frontframe-engine`'s `gaps` table already exists to do.

## Status

Blocked on a separate, unresolved FrontFrame Worker issue (raised
2026-08-13, in a different conversation). No implementation work on either
item above should begin until that is resolved. See `frontframe-engine`'s
`docs/CHARTERS.md` for the authoritative status.

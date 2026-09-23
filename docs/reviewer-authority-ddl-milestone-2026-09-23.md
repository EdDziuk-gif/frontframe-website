# FrontFrame Reviewer Authority — DDL Milestone

**Status:** DDL steps 1–10 applied and verified live on 2026-09-23. Worker, UI, route, and RLS work remain unstarted and require separate authorization.

## Applied and verified

Against Supabase project `ifjsepyzdnpmwyuytppr`:

- Added `reviewers.baseline_role` with the four values `frontframe_operator`, `delegate`, `staff`, and `client_tester`.
- Backfilled the existing Operator as `baseline_role = 'frontframe_operator'`.
- Widened the legacy reviewer role constraint to include `frontframe_delegate`; all original role values remain intact.
- Added and live-tested the `reviewers_one_active_operator` partial unique index.
- Added `reviewers.can_sign_off_kgr`; it is `true` only for the existing Operator and defaults to `false` for new reviewers.
- Added `deactivated_at` and `deactivated_by` metadata.
- Created empty `admin_panels`, `reviewer_permissions`, and `reviewer_engagements` tables. `reviewer_engagements` references `orders`; orders itself was not altered.

The following remain unchanged: existing constitutional booleans, `reviewers.active`, `reviewers.engagement_id`, reviewer-to-Auth foreign key, orders, agreements, RLS, functions, routes, and UI.

## Explicit non-work

- No Worker route, UI, RLS policy, or Constitutional/KGR workflow changed.
- No Solutions Panel permission was created.
- No reviewer ownership, `managed_by`, reporting chain, or organizational hierarchy was created.
- No panel catalog was seeded.
- No Delegate, Staff, Client Tester, or engagement test data exists yet.

## Resolved reviewer-invite rules

| Inviter | May invite |
| --- | --- |
| FrontFrame Operator | FrontFrame Operator, Delegate, Staff, Client Tester |
| Delegate | Staff, Client Tester |
| Staff / Client Tester | Nobody |

New reviewer records use these paired values:

| Reviewer type | Legacy `role` | `baseline_role` |
| --- | --- | --- |
| FrontFrame Operator | `frontframe_admin` | `frontframe_operator` |
| Delegate | `frontframe_delegate` | `delegate` |
| Staff | `frontframe_staff` | `staff` |
| Client Tester | `client_tester` | `client_tester` |

All new reviewers begin active and with `can_sign_off_kgr`, `can_amend_constitution`, and `can_grant_constitution_amendment` set to `false`.

Only the FrontFrame Operator may later grant or revoke KGR/Knowledge_Base sign-off authority. Deactivation/reactivation remains Operator-only. Delegates may manage Staff and Client Tester records regardless of who originally created them.

## Provisioning and testing decision

The three additional reviewer accounts will be created through the later reviewer-management UI/invite flow, not manually in the Supabase dashboard. This ensures that the actual UI path is tested when it provisions the Delegate, Staff, and Client Tester accounts.

The four-account acceptance test and temporary theoretical engagement remain deferred until the Worker/UI phase is authorized and implemented.

## Next gate

The Operator will determine whether the implementation model is ready to continue or has unresolved questions blocking Worker and UI work. Do not begin that phase without explicit authorization.

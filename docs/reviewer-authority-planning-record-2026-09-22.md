# FrontFrame Reviewer Authority — Planning Record

**Status:** Approved planning basis; no migration, code, data, or deployment work authorized by this record.

## Purpose

Preserve the agreed reviewer-authority model and the control sequence for the reviewer-administration correction. This record is intentionally separate from the later implementation plan.

## Terms

- **Reviewer:** any authenticated, active individual authorized to use some part of `/admin`.
- **Reviewer of record:** the specific reviewer whose ID is attributed to an action.
- **FrontFrame Operator:** the single unrestricted human operator; Owner and Operator mean the same individual.

To date, the FrontFrame Operator is the reviewer of record for every Constitutional Amendment and KGR/Knowledge_Base sign-off. No Delegate has exercised either authority.

## Agreed operating model

- There is one active `frontframe_operator`, with unrestricted human `/admin` authority.
- The four reviewer types are FrontFrame Operator, Delegate, Staff, and Client Tester.
- Delegates may manage Staff and Client Tester records. That authority is bounded by reviewer type, not by who created a record.
- Do not add `managed_by`, ownership tracking, reporting relationships, or organizational-chart structures.
- Staff and Client Testers cannot manage reviewer records.
- Reviewer removal means deactivation, not deletion. Deactivation removes login and effective `/admin` access while retaining identity and action attribution.
- Normal recovery from an Operator lockout remains direct, controlled Supabase-project access, outside `/admin`.

## Protected authority paths

Constitutional Amendment authority and KGR/Knowledge_Base authority are separate.

- Existing Constitutional Amendment behavior and existing fields, including `can_amend_constitution` and `can_grant_constitution_amendment`, are preserved. `can_grant_constitution_amendment` is a binary field on a Delegate record, not a separate workflow to redesign.
- KGR/Knowledge_Base sign-off must authorize the logged-in reviewer with its dedicated binary authority. The server verifies it when sign-off is executed, and the admin UI must not display the sign-off control to a reviewer without that authority.
- The KGR/Knowledge_Base workflow itself is not redesigned; the necessary migration is the authority transition from its legacy role gate to the dedicated binary authority.

## Admin access model

- Panel-only permissions are the default. Add per-action complexity only when verified DDL/code proves a particular panel cannot safely use whole-panel access.
- The model must support adding and retiring `/admin` panels as FrontFrame evolves.
- The Solutions Panel is excluded from this correction. Do not create, retain, seed, or migrate a Solutions permission object.
- Client Testers are limited to an engagement they are authorized to access once that engagement exists. Engagement creation, orders/agreements, fixture design, reporting, and cleanup are outside this correction.
- Every `/admin` session must visibly display the signed-in reviewer identity and effective role; Client Testers also see their authorized engagement. UI visibility is a safety aid and does not replace server verification.

## Testing

The Operator will test using four separate email addresses: FrontFrame Operator, Delegate, Staff, and Client Tester. A temporary theoretical engagement is permitted only for acceptance testing and is backed out after testing.

## Confirmed current-state facts

- `public.reviewers` is the identity and attribution anchor. Its IDs are referenced by Constitutional and KGR records; reviewers must not be deleted, replaced, or re-keyed.
- Legacy `reviewers.role` values and their constraint are load-bearing for current validated Constitutional and KGR behavior and remain untouched during the authority-schema migration.
- Current reviewer deletion is a real service-role delete and must be replaced by deactivation in the later code/route phase.
- Current KGR sign-off uses a legacy role check and a matching UI visibility check. The authority migration must replace that gate with the dedicated KGR/Knowledge_Base binary authority without changing the sign-off workflow.
- No general panel-permission catalog exists today.
- Existing `reviewers.engagement_id` is not the scope model for Client Tester engagement access.

## Approved sequencing

1. Documentation and implementation models reconcile verified live DDL/code facts against this record.
2. Draft and approve a granular future-state DDL definition and migration plan only.
3. Implement and independently verify the migration.
4. Only then plan and implement routes, Worker logic, UI, and RLS policies.

The implementation model must distinguish confirmed evidence, explicit Operator decisions, unknowns, and conflicts. It may not silently invent restrictions or advance into code/policy work before the relevant planning phase is approved.

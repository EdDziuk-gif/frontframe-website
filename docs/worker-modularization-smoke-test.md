# Worker Modularization Production Smoke Test

## Purpose

Verify that the modularized Cloudflare Worker preserves the deployed API contract and that defects introduced by moving routing, authentication, shared infrastructure, or handler code are identified before the modularization project is summarized and closed.

This is a production smoke test, not a full regression suite. The default checks are read-only or deliberately rejected requests. Any check that creates, changes, sends, or deletes production data requires separate approval and a cleanup procedure.

## Migration under test

- Repository: `EdDziuk-gif/frontframe-website`
- Modularization commit: `96d4143`
- Worker: `frontframe-worker`
- Production host: `https://api.frontframe.co`
- Contract: 92 routes in their original first-match order
- Access policy: `/admin`, `/admin/*`, and `ADMIN_EXTRA_PROTECTED_PATHS` require an active reviewer with an allowed role

## Closure gate

Do not summarize or close the modularization project until all required checks below pass or every observed defect has:

1. A written defect record.
2. An identified route group or shared module.
3. A disposition: fixed and retested, accepted with rationale, or rolled back.

## Evidence to capture

Record the following for the deployment and every check:

- Deployment version ID and timestamp.
- Git commit deployed.
- Route and HTTP method.
- Authentication state: none, invalid token, or valid reviewer.
- Expected status and response shape.
- Actual status and response shape.
- Pass or fail.
- Relevant Worker log line or request ID when available.
- Defect reference when failed.

Never store bearer tokens, API keys, webhook signatures, vault values, or full sensitive response bodies in the evidence.

## Pre-deployment gate

These checks must pass against the exact commit being deployed:

- `npm test -- --run`
- `npx wrangler deploy --dry-run`
- `git diff --check`
- Working tree clean.
- `main` resolves to commit `96d4143` or a documented descendant containing only smoke-test documentation.
- Route contract test reports 92 routes.
- Protected-route contract test reports all admin routes and the six extra protected path patterns.

## Recorded pre-deployment baseline

Captured against production on 2026-08-13 before deploying the modularized build:

| Request | Baseline result |
|---|---|
| `OPTIONS /chat` | `204` |
| `GET /__worker-smoke-not-found__` | `404` with `{"error":"Not found"}` |
| `GET /chat` | `404` with `{"error":"Not found"}` |
| `GET /podcast-episodes` | `200` |
| `GET /api/office-hours` | `200` |
| `GET /admin/config` without a token | `401` with `Missing Authorization header` |
| `GET /api/rd-log` without a token | `401` with `Missing Authorization header` |
| `GET /admin/config` with an invalid token | `401` with `Invalid or expired session` |
| `GET /blackout` | `500`, Cloudflare error code `1101` |

The `/blackout` failure predates this migration. If it remains after deployment, record it as an existing production defect rather than a modularization regression. If its behavior changes, investigate the difference before closure.

## Deployment gate

1. Record the currently deployed Worker version so it can be restored.
2. Deploy from verified `main`.
3. Record the new deployment version ID and deployment timestamp.
4. Confirm `api.frontframe.co` still resolves and serves HTTPS.
5. Begin Worker log monitoring before sending smoke requests.

## Required smoke checks

### Router and HTTP boundary

| Check | Request | Expected result |
|---|---|---|
| CORS preflight | `OPTIONS /chat` | `204` with the existing CORS headers |
| Unknown route | `GET /__worker-smoke-not-found__` | `404` JSON response with `{"error":"Not found"}` |
| Unsupported method | `GET /chat` | `404` JSON response |
| Public route matching | `GET /podcast-episodes` | Successful JSON response; not `401`, `403`, `404`, or `500` |
| Public office hours | `GET /api/office-hours` | Successful response with the existing response shape |
| Public blackout data | `GET /blackout` | Successful JSON response with the existing response shape |

### Authentication boundary

Run these without a bearer token:

| Check | Request | Expected result |
|---|---|---|
| Admin prefix protection | `GET /admin/config` | `401` with `Missing Authorization header` |
| Admin parameter route protection | `PATCH /admin/defects/smoke-id` | `401` before handler execution; no data change |
| Extra protected path | `GET /api/rd-log` | `401` with `Missing Authorization header` |
| Extra protected parameter route | `PATCH /api/office-hours/schedule/monday` | `401` before handler execution; no data change |

Repeat `GET /admin/config` with an invalid bearer token. Expect `401` with `Invalid or expired session`, not `403`, `404`, or `500`.

### Authenticated read-only admin coverage

Use a valid `frontframe_admin` or `frontframe_staff` session. Confirm each route returns its established success status and response shape without exposing secrets in the test record.

- `GET /admin/config`
- `GET /admin/defects`
- `GET /admin/feedback`
- `GET /admin/changelog`
- `GET /admin/leads`
- `GET /admin/lead-alerts`
- `GET /admin/agreements`
- `GET /admin/reviewers`
- `GET /admin/podcast-episodes`
- `GET /admin/marketing-log`
- `GET /admin/problem-statements`
- `GET /admin/deliverables`
- `GET /admin/subscriptions`
- `GET /admin/vault`
- `GET /api/office-hours/schedule`
- `GET /api/office-hours/overrides`
- `GET /api/rd-log`
- `GET /admin/outreach`
- `GET /admin/review-queue`

Also load the production admin and development-admin pages in the browser. Confirm initial data loads complete without failed API notices or console errors.

### Route-precedence checks

These checks protect the literal-before-parameter behavior that the router contract locks:

- `GET /admin/lead-alerts/{known-id}/session` resolves to the session route.
- `POST /admin/subscriptions/{known-id}/send` is not executed during the default smoke test because it sends externally. Confirm its route position through the automated contract test.
- `DELETE /admin/review-queue/bulk` is not executed during the default smoke test. Confirm its route position through the automated contract test.

### Public interactive paths

Exercise these only with clearly labeled synthetic input and confirm expected side effects before proceeding:

- `POST /chat`
- `POST /inquiry`
- `POST /schedule`
- `POST /proposal/review`

The default production smoke test does not call these routes because they can create database records, invoke paid services, or send notifications.

### Webhook safety

Do not send fabricated Stripe or DocuSeal success events to production.

- Confirm `/webhooks/stripe` and `/webhooks/docuseal` remain present through the route contract.
- Confirm the Worker bundle contains both webhook handlers through the dry-run build.
- Review Worker error logs after deployment for unexpected webhook failures from real traffic.
- If an actual webhook arrives during the observation window, record only its status and request ID. Do not capture payload contents.

## Observation window

Monitor Worker logs during the smoke test and for at least 15 minutes after the final request.

Fail the smoke test for:

- Any new uncaught exception.
- Any `500` from a required smoke route.
- Any protected route that reaches its handler without valid reviewer authentication.
- Any public route returning `401` or `403`.
- Any route returning `404` when its method and path are in the 92-route manifest.
- Any unexpected notification, email, SMS, payment action, or production data mutation.

## Rollback rule

Roll back immediately if authentication can be bypassed, multiple unrelated route groups fail, a shared module causes broad `500` responses, or production side effects occur unexpectedly.

For an isolated read-only defect:

1. Stop smoke testing the affected domain.
2. Record the route, request conditions, response, logs, and suspected module.
3. Decide whether to fix forward or roll back.
4. Rerun the full required smoke set after the fix or rollback.

## Completion record

The modularization project may be summarized and closed only when:

- The deployment version and commit are recorded.
- All required router, authentication, public read-only, and authenticated read-only checks pass.
- The observation window completes without a new Worker error.
- Every defect has a disposition.
- Any approved write-path probe has been cleaned up and verified.

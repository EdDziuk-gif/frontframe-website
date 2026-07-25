# SEO Copy Recommendations — resources.html
**Date:** 2026-06-08  
**Status:** Awaiting approval before file edit

---

## 1. Current State Audit

| Element | Current |
|---|---|
| `<title>` | Resources — FrontFrame |
| `<meta name="description">` | Tools and resources for small business owners preparing to scale, sell, or systematize — and the advisors who work with them. |
| `<meta property="og:title">` | Resources — FrontFrame |
| `<meta property="og:description">` | (same as meta description) |
| `<meta name="twitter:title">` | Resources — FrontFrame |
| `<meta name="twitter:description">` | (same as meta description) |
| H1 | For owners who are building something worth keeping. |
| Eyebrow above H1 | RESOURCES (present — `<span class="page-eyebrow">`) ✅ |
| Subtitle | A book, articles in progress, and conversations on the way. |
| Live H2s | None in rendered body — all H2s are inside `<template id="staged-sections">` |
| Advisor section H2 | Not present |

---

## 2. Recommended Changes — Exact Replacement Copy

### Title tag
**Replace with:**
```
Local Service Business Owner & Advisor Resources | FrontFrame
```

### Meta description
**Replace with:**
```
Most local service businesses are invisible to the people who would buy them, advise them, or send them clients. This page gives owners and their advisors practical tools to change that.
```

> Apply the same replacement to `og:description` and `twitter:description`. Update `og:title` and `twitter:title` to match the new `<title>` value.

### H1
**No change required.** Current H1 already reads:
> For owners who are building something worth keeping.

### Eyebrow label
**No change required.** `<span class="page-eyebrow">Resources</span>` is already present in markup. ✅

### Subtitle (page-header-sub)
**Current:**
> A book, articles in progress, and conversations on the way.

**Replace both subtitle lines with:**
> Most local service businesses are invisible to the people who would buy them, advise them, or send them clients. This page is for owners who intend to change that — and for the advisors who work with them.

Render as a single `<p class="page-header-sub">` element.

---

## 3. Advisor Audience Section — Finished Copy

Insert as a new `<section>` in the live body (not inside the `<template>`), placed between the page header and the existing Advisor Intel section.

**H2:**
> For advisors who work with local owners

**Body paragraph:**
> Your clients' businesses are often invisible to the people who might buy them, lend to them, or send them work. This section gives you simple language and tools you can use with local service owners when you want them to start treating the business like an asset, not just a job.

**Referral CTA paragraph (plain text link — no button):**
> If you work with owner-operators and want a consistent resource to point them to, this page is built for that. [Reach out](/contact) to talk about how FrontFrame fits into your existing advisory work.

Render the link as a plain `<a href="/contact">Reach out</a>` inline — no button, no CTA class. Match body text size and color (`var(--gray)`), with the link styled amber or navy underline per existing `a` treatment.

---

## 4. Internal Linking Audit

### Book — *Your Business Is Invisible*
The book is referenced in two places inside `<template id="staged-sections">` (not rendered):

- Line ~670: `<h2>Your Business Is Invisible</h2>` — **no link applied**
- Lines ~674–676: eBook and print Stripe buy links present, Amazon link is `href="#"` placeholder

**Recommendation:**
- No `/book` page currently exists at frontframe.co/book.
- Add `<!-- TODO: link to book page -->` comment on the H2 element when staging section is moved live.
- Replace Amazon `href="#"` with actual Amazon listing URL when available.

### Other internal references
- Nav logo links to `/` ✅
- "Get Started" nav CTA links to `intake.html` ✅
- "← Back to Home" links to `/` ✅
- `/contact` — referenced in the new advisor CTA paragraph above. Confirm this route exists or update to the correct contact path before going live.

---

## 5. Notes on Scope

- No structural redesign. All changes honor the existing dark-header / light-body layout, `--navy` / `--amber` / `--offwhite` variable system, and DM Sans / Inter type stack.
- The `<template id="staged-sections">` block is untouched by these recommendations — it remains inert until Ed moves it to the live body.
- Chat widget `PAGE` variable is currently set to `'ADVISOR'`. After the system prompt upsert runs for `page = 'resources'`, this should be updated to `'resources'` so the worker routes to the correct prompt.
- Chat widget `greet()` function contains a hardcoded greeting tied to the Advisor Intel feed. After the system prompt upsert, update it to match the new opening question: *"Welcome. Are you a local service business owner, or do you work with them — as a bookkeeper, CPA, attorney, or coach?"*

# FrontFrame — Project Status

_Updated: 2026-04-04_

---

## Overall Phase

**Execution phase.** All strategic decisions finalized. Working environment setup complete. Development not yet started.

---

## Completed

- [x] Company name finalized: FrontFrame
- [x] Domain selected: frontframe.com
- [x] Brand positioning, taglines, and homepage copy finalized
- [x] Tone and visual axis defined
- [x] Hero illustration concept approved (Grok output)
- [x] Hero concept variations reviewed (ChatGPT); strongest alternative identified
- [x] Platform component sketches generated (ChatGPT, directional)
- [x] Social media mockup direction approved for Eleanor's contractor (ChatGPT, directional)
- [x] Technical stack decided (Cloudflare Pages + Workers, Supabase, Resend, Turnstile)
- [x] Database schema designed (inquiries, contact_log, verticals)
- [x] File structure decided
- [x] Pages list finalized (7 pages, no portal at launch)
- [x] Worker architecture specified
- [x] Communication system specified (email-only at launch, SMS future)
- [x] Project working environment created
- [x] brand.md written
- [x] stack.md written
- [x] status.md written
- [x] team.md written
- [x] Folder structure scaffolded with placeholder files
- [x] Grok prompt PDF storage location confirmed: /docs/assets/

---

## In Progress

- [ ] **Graphics designer engagement** — Initial outreach and brief sent. Awaiting confirmation of engagement.
- [ ] **ChatGPT follow-up** — Prompt prepared to extract clean plain-text typography and color palette values from prior ChatGPT response (rendered in unreadable format). Needs to be run; output to be added to /docs/.
- [ ] **Domain registration** — frontframe.com pending. Treat as confirmed.

---

## Not Yet Started

### Design
- [ ] Production hero SVG (designer deliverable)
- [ ] Platform component SVG suite — 5 icons: website, intake form, e-signature, payments, client portal (designer deliverable)
- [ ] Visual identity document — typeface selection, hex palette, spacing principles (designer deliverable)
- [ ] Color palette confirmed with hex values
- [ ] Typeface selection confirmed

### Development
- [ ] schema.sql — full Supabase schema
- [ ] seed.sql — verticals reference data
- [ ] Cloudflare Worker — index.js routing
- [ ] handleInquiry.js — form handler with Turnstile validation, Supabase write, Resend notification
- [ ] handleContact.js — secondary contact handler (scope TBD)
- [ ] wrangler.toml — Worker configuration
- [ ] index.html — Home page
- [ ] how-it-works.html
- [ ] who-its-for.html
- [ ] our-work.html — Case study: Elie's Bird Sitting
- [ ] pricing.html
- [ ] contact.html — Primary conversion point
- [ ] about.html
- [ ] CSS — visual design implementation
- [ ] JS — form handling, Turnstile integration
- [ ] Cloudflare Pages deployment
- [ ] Cloudflare Worker deployment
- [ ] Supabase project setup and schema deployment
- [ ] Resend account setup and domain verification
- [ ] Turnstile site key configuration
- [ ] DNS configuration in Cloudflare

### Content
- [ ] Case study copy — Elie's Bird Sitting / Eleanor's Avian Care
- [ ] Who It's For — vertical-specific body copy for each of 4 verticals
- [ ] About page copy
- [ ] Pricing page placeholder copy

### External
- [ ] Social media contractor visual brief — ready to send once designer confirms palette and typeface
- [ ] Grok prompt PDF imported to /docs/assets/

---

## Blockers

| Blocker | Blocks |
|---|---|
| Designer engagement not confirmed | Production SVGs, visual identity doc, color hex values, typeface confirmation |
| Color/typeface not confirmed | Social media contractor visual brief (ready to send pending this) |
| ChatGPT follow-up not run | Typography and palette values from prior session |

---

## Development Readiness

Development can begin on the Worker and schema independently of design. HTML/CSS development requires the visual identity document and confirmed palette/typeface. The contact form and Worker are the critical path for launch.

---

_Next session goal: Begin development. Recommended starting point: schema.sql + seed.sql, then Worker scaffold._

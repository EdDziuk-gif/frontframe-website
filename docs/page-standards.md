# FrontFrame — Page Layout Standards

_These conventions came out of building the Constitution and "An AI Assistant Needs More Than Your Business Information" pages. Apply them to any new or updated page under `public/`. Reference implementations are named in each section — copy the actual CSS/JS from there rather than re-deriving it._

---

## Don't force a page to fill the screen

Do not put `min-height: 100vh` (or similar) on a page wrapper just to make a short page "feel" full-height. It looks fine on the viewport you tested at and produces a large, unstyled dead zone on any taller or wider one — a portrait monitor, a 1920×1080 display, anything bigger than a laptop. Let a page be exactly as tall as its content. A page that ends partway down a big monitor is normal and expected; it's what every content-driven site does.

If a section is genuinely meant to be a full-screen hero (a landing page opener, for instance), that's a deliberate exception — state the reason in a CSS comment so the next person doesn't mistake it for a default.

---

## Keep headers proportionate to their content

A page header (eyebrow + title + meta, or a hero block) should read as an introduction, not the main event. If a header's padding, title size, or decorative elements make it the visually dominant part of the page, shrink it. There's no fixed number to hit — the test is whether the header still looks like it's introducing something below it, or like it's trying to fill space on its own.

Reference: the `.article-header` treatment in `public/resources/an-ai-assistant-needs-more-than-your-business-information.html` and the `.hero` treatment in `public/discovery.html` — both were cut roughly in half from their original padding/type-size without losing any content.

---

## Collapsible, reveal-at-bottom footer

Pattern used on the essay and Constitution pages: the site footer stays hidden below the viewport while a visitor is reading, and slides into view only once they've scrolled to the true bottom of the page — collapsing again if they scroll back up.

Implementation notes:
- It's progressive enhancement. The default (no-JS) state is the footer behaving exactly as a normal static footer — always visible, in normal flow. JS adds a `js-collapsible-footer` class to `<body>`, and only CSS scoped under that class turns the footer into the hide/reveal behavior. A page with this pattern must never be *worse* than a plain footer if JS fails to run.
- A `.footer-spacer` element (sized to the footer's own measured height via a `--footer-h` CSS custom property, set in JS) reserves the footer's space in normal document flow, so the footer doesn't jump the page height around when it reveals, and doesn't overlap real content when it slides in.
- The trigger is the page's own `window` scroll position reaching the true document bottom (within a small threshold), not any inner scrollable element. If a page has an internally-scrolling reading pane (see below), that inner scroll is separate from this check — don't try to gate the footer reveal on it.
- If the page has a floating chat widget anchored to the bottom corner, nudge it out of the way (`translateY`) at the same moment the footer reveals, so the two never overlap.

Reference: the inline `<script>` and the `footer` / `.footer-spacer` / `.chat-widget.footer-open` CSS at the bottom of `public/constitution.html` and `public/resources/an-ai-assistant-needs-more-than-your-business-information.html` — copy both the CSS and the script as a unit.

---

## Internally-scrolling reading panes

The essay page reads inside a fixed-height `.article-body` (`height: 62vh; overflow-y: auto`) rather than letting the whole page scroll through the article text. If a future page uses this pattern, remember: anything placed *outside* that inner box (a CTA, a footnote, the footer) is reached by scrolling the outer page, not by finishing the inner box — reaching the end of the article and reaching the bottom of the page are two different user actions. Don't assume one implies the other when wiring up scroll-triggered behavior.

---

## CTA placement should match how much commitment the content asks for

Don't default to a CTA that's permanently visible regardless of how much a visitor has actually read. For a short piece, a visitor who didn't scroll to the end was unlikely to act on the CTA anyway — put it at the end of the content (inside the reading pane, if there is one) so it's the payoff for finishing, not dead weight sitting under the fold on every load. A longer or multi-section page may still warrant a persistently visible CTA — this is a judgment call per page, not a fixed rule, but the default should be "earn its placement," not "always on."

---

## Prefer native HTML interactivity over JS where the browser already does the job

The Constitution page's ten sections use native `<details>`/`<summary>` (with a shared `name` attribute for single-open-at-a-time behavior) instead of a JS-driven accordion. No JS required, keyboard and screen-reader support built in, content stays indexable when collapsed. Reach for this before writing custom show/hide JS for anything that's fundamentally "expand this section."

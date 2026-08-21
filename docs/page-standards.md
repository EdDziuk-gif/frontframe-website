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

Pattern used on the essay and Constitution pages: the site footer stays collapsed while a visitor is reading, and expands into view only once they've scrolled the true end of the content into view — collapsing again if they scroll back up.

Implementation notes:
- It's progressive enhancement. The default (no-JS) state is the footer behaving exactly as a normal static footer — always visible, in normal flow. JS adds a `js-collapsible-footer` class to `<body>`, and only CSS scoped under that class turns the footer into the collapse/expand behavior. A page with this pattern must never be *worse* than a plain footer if JS fails to run.
- The footer stays in **normal document flow** at all times — no `position: fixed`, no reserved spacer element. It's collapsed by default (`max-height: 0; overflow: hidden;`) and expands to its real height (measured via `footer.scrollHeight`, stored in a `--footer-h` custom property) when revealed. This was a fixed-position + spacer design originally; that broke whenever the page's real content was shorter than the viewport (a short article on a tall or portrait monitor), because the footer would detach from the content above it, leaving a visible gap between the spacer and the fixed-position footer. Keeping it in normal flow means it's always contiguous with whatever precedes it, on any screen.
- The trigger is an `IntersectionObserver` watching a dedicated `<div class="footer-sentinel" aria-hidden="true"></div>` placed right after the real content, immediately before the footer — not a comparison of scroll position against `document.documentElement.scrollHeight`. That scroll-math approach has a trap: when a page's content is shorter than the viewport, the browser reports `scrollHeight` as clamped to the viewport height, so the "have we scrolled to the bottom" check comes back true immediately on load, before the visitor has scrolled at all. Watching a real sentinel element's visibility sidesteps that entirely.
- If the page has a floating chat widget anchored to the bottom corner, nudge it out of the way (`translateY`) at the same moment the footer reveals, so the two never overlap.

Reference: the inline `<script>` and the `footer` / `.footer-sentinel` / `.chat-widget.footer-open` CSS at the bottom of `public/constitution.html` and `public/resources/an-ai-assistant-needs-more-than-your-business-information.html` — copy both the CSS and the script as a unit.

---

## Don't put reading content inside a fixed-height scrolling pane

The essay page originally read inside a fixed-height `.article-body` (`height: 62vh; overflow-y: auto`), with the CTA placed at the end of that inner box so it would only be seen by a reader who finished the article. This was abandoned — it's a trap, not a pattern.

The problem: a visitor's natural gesture is to scroll the *page*, not to discover that a small box mid-page has its own independent scrollbar. On an ordinary desktop viewport the outer page can reach its true bottom (revealing the footer) after only a few hundred pixels of scroll, while the inner pane — still sitting at scroll position zero — is showing just the first paragraph or two. The result: the footer and footnote appear right under the article opening, the CTA is never seen at all, and the visitor never encounters 90% of the content. This is exactly what happened on the essay page and took several rounds to properly diagnose, because every symptom (footer too close, CTA "missing," blank space) looked like a separate layout bug when they were all downstream of the same cause.

Let long-form reading content flow in normal page layout, full stop. If a CTA should be "earned" by reading to the end, place it in normal flow directly after the closing content — the reader reaches it by the same single, ordinary page scroll that reveals everything else. No inner scroll surface, no ambiguity about which scroll gesture does what.

---

## CTA placement should match how much commitment the content asks for

Don't default to a CTA that's permanently visible regardless of how much a visitor has actually read. For a short piece, a visitor who didn't scroll to the end was unlikely to act on the CTA anyway — put it directly after the closing content, in normal page flow, so it's the payoff for finishing, not dead weight sitting under the fold on every load. A longer or multi-section page may still warrant a persistently visible CTA — this is a judgment call per page, not a fixed rule, but the default should be "earn its placement," not "always on."

---

## Prefer native HTML interactivity over JS where the browser already does the job

The Constitution page's ten sections use native `<details>`/`<summary>` (with a shared `name` attribute for single-open-at-a-time behavior) instead of a JS-driven accordion. No JS required, keyboard and screen-reader support built in, content stays indexable when collapsed. Reach for this before writing custom show/hide JS for anything that's fundamentally "expand this section."

---

## Watch for CSS specificity collisions when nesting a colored callout inside body copy

A dark-background callout box (a CTA, a pull-quote, anything with `color: #fff` text set on its own class) that lives inside a generic content container is vulnerable to a subtle bug: a broad rule like `.article-body h2 { color: var(--navy); }` or `.article-body p { color: var(--ink); }` can end up *more specific* than the callout's own `.callout-heading` / `.callout-body` class rule (one class + one element beats one class alone), silently overriding its white text back to dark navy-on-navy — text that's technically there but invisible. This exact bug shipped on the essay page's CTA after it was moved inside `.article-body` and wasn't caught until a real screenshot was compared against the rendered computed styles.

The fix is to always scope a callout's own text-color rules with its parent class (`.blueprint-callout .callout-heading`, not just `.callout-heading`) so they win on specificity regardless of what broad rules exist in whatever container the callout ends up nested inside. When something "looks faded" or "washed out" in a screenshot rather than cleanly wrong, check `getComputedStyle(...).color` before assuming it's a spacing or opacity issue — a specificity collision reads visually like faint/faded text.

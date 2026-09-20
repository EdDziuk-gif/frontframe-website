# FrontFrame Deployment SOP

Written after a Stage B (Supabase SDK login) deploy that took far longer than
it should have -- not because the code was wrong, but because of a chain of
git/deploy-mechanics mistakes that produced confusing, misleading symptoms.
This doc exists so that chain never repeats, regardless of which AI tool or
human is driving.

---

## The core problem this solves

**"Committed" is not "pushed." "Pushed" is not "deployed." "Deployed" is not
"deployed with the value you think is in it."** Four different states, each
one silently assumed to be true because the previous one was. Every step in
this SOP exists to force an explicit check instead of an assumption.

---

## Know your deploy mechanism before you start

FrontFrame has **two independent deploy paths** -- confusing one for the
other wastes time:

| Component | Deploy trigger | Command | Independent of git push? |
|---|---|---|---|
| Worker (`worker/src/index.js`, API routes) | Manual | `npm run deploy` (= `wrangler deploy`) from `worker/` | Yes -- ships immediately, regardless of git state |
| Static frontend (`public/*.html`, `public/js/*.js`) | Cloudflare Pages auto-build | `git push` to `main` | No -- nothing ships until you push |

A Worker change can be live in production while the matching frontend change
sits un-pushed on your laptop for hours, looking identical in your editor.
**Before debugging "why doesn't my change work," identify which of these two
paths the changed files belong to, and confirm that specific path actually
ran.**

---

## Session opening (required at the start of every working session)

Before any code is written or any change is proposed, the model must:

1. **Confirm which domain and folders are in scope** for this session.
   Ask Ed which area we're working in if it isn't stated. Do not assume
   continuity from a prior session summary.
2. **State the test-coverage posture for that area.** The pre-commit hook
   only fires for high-risk files (shared utilities, constitution, webhooks,
   KGR, chat). For anything in scope that falls into one of those categories,
   name it upfront so Ed knows a test prompt may appear during the commit.
3. **Review the pre-change analysis checklist below** and confirm it will
   be followed before any change in this session.

This takes thirty seconds and prevents the pattern where test prompts and
deploy reminders appear mid-session without context, get bypassed, and
accumulate as invisible debt.

---

## Pre-change analysis (required before writing any code)

This step exists because most wasted time in this project has come from
making a change in one file without tracing its downstream impact first.
The model must complete and report this analysis before proposing any code.

**For any worker route change:**
1. Grep every file in `worker/src/` that references the affected table,
   function, or route. Read them. List what each one does with it.
2. Check the live Supabase DDL for the affected table: column names,
   check constraints, foreign keys. Do not assume the template DDL is current.
3. Identify every caller of any function being changed, not just the
   immediate one. If `captureContactHandoff` is being changed, find
   every place it is called.
4. State explicitly which deploy path is required (worker deploy, Pages
   push, or both) and include the deploy step in the same set of
   instructions as the code change — never as a separate follow-up.

**For any database change:**
1. Query the live table DDL before writing a migration.
2. List all foreign keys referencing the affected table and the order
   in which they must be addressed (e.g. delete child rows before parent).
3. If adding a value to a CHECK constraint, verify the constraint exists
   on the live table, not just the template DDL.

**For any frontend change:**
1. Read the full relevant section of the HTML file, not just the line
   being changed. State what the surrounding logic does before modifying it.
2. Identify any JS functions called from the changed section and confirm
   they exist and behave as expected.

**Reporting:** Before writing code, the model states in plain language:
- What files will change and why
- What downstream effects were checked and what they are
- What deploy steps are required
- What verification will confirm the change is working

If this analysis cannot be completed because files are missing or unclear,
the model asks before proceeding — not after the code is written.

---

## Pre-commit checklist

1. **Diff before you stage.** Run `git status` and `git diff` and actually
   read the file list. Don't assume you know what's dirty -- unrelated WIP
   (a stray new page, a SQL migration draft, a docs edit from three days ago)
   accumulates as untracked/modified files and will get swept into your
   commit if you're not looking.
2. **Never `git add -A` on a repo with any unrelated WIP sitting in it.**
   Stage files by explicit path:
   ```bash
   git add public/js/config.js public/admin.html
   ```
   If you genuinely want everything, `git status` first and confirm the full
   list is intentional -- then `git add -A`.
3. **Write multi-line or special-character commit messages to a file first,
   then commit with `-F`.** Backticks, `$`, and `!` inside a `git commit -m
   "..."` double-quoted string are still live to zsh/bash and will silently
   mangle your message (a backtick pair around a word can vanish entirely,
   with no error, because the shell "helpfully" tries to execute it as a
   command).
   ```bash
   cat > /tmp/commit_msg.txt << 'EOF'
   Your message here, with any `backticks` or $variables safe inside
   this quoted heredoc.
   EOF
   git commit -F /tmp/commit_msg.txt
   ```
4. **If a value (API key, secret, config placeholder) needs to be hand-edited
   locally after the code is written, do that edit *before* the commit, not
   after.** If you edit it after, `git status` will show it as a new
   modification -- don't push until that shows clean for the file you just
   edited.

---

## Push + deploy checklist

1. `git push`. Read the output -- confirm it actually shows commits moving
   (`abc123..def456  main -> main`), not "Everything up-to-date" when you
   expected new commits.
2. **Give the target platform a minute to build** (Cloudflare Pages) or
   confirm the deploy command's own success output (`wrangler deploy`
   prints a deployed URL/version ID -- that's your confirmation, not the
   local shell exiting 0).
3. **Verify against the live URL, not against your local editor.** Fetch the
   actual deployed file and grep for a marker that only exists in the new
   version:
   ```bash
   curl -s https://frontframe.co/js/config.js | grep SUPABASE_ANON_KEY
   curl -s https://frontframe.co/admin.html | grep -A1 supabase-client.js
   ```
   If the marker isn't there, the deploy didn't ship what you think it did
   -- stop and find out why before testing functionality.
4. **Check config/secret values in the live output specifically**, not just
   structural markers (script tags, function names). A structurally correct
   deploy with a leftover placeholder value (`PASTE_ANON_KEY_HERE`) will
   fail in a way that looks like a code bug but isn't.

---

## When something looks broken after a deploy

Work in this order, not in reverse:

1. **Confirm the new code is actually live** (see verification step above)
   before assuming the new code has a bug. A stale/un-pushed deploy produces
   symptoms that look exactly like a broken rewrite.
2. **Check the real network request/response**, not just the on-screen error
   message. Generic UI error strings (e.g. a catch-all "Failed to X." wired
   as a fallback for unset error messages) can coincidentally look like a
   new bug when they're actually the *old* code's generic error, still
   firing because the old code is still what's live.
3. **Watch for rate limits during your own testing.** Repeated manual retries
   while debugging can trip a backend rate limiter, producing a 429 that has
   nothing to do with the change you're testing. If you see a 429, wait
   before concluding anything about the code itself.
4. Only after 1-3 rule out "not actually deployed" and "unrelated rate
   limit," treat it as an actual code defect and start reading the new
   implementation.

---

## Enforcement: versioned git hooks

The checklist above is now also enforced mechanically via hooks in
`githooks/` (versioned in this repo -- `.git/hooks` itself is not, so
scripts live here instead and git is pointed at them):

- **`commit-msg`** -- rejects any commit message containing a backtick,
  closing off the shell command-substitution mangling risk at the source
  instead of relying on remembering to write messages to a file. Also
  enforces basic message formatting: non-empty subject line, subject
  <=72 characters, no trailing period, and a blank line separating the
  subject from any body text (standard git convention -- matches the
  style already used for every commit in this SOP).
- **`pre-commit`** -- if a commit stages 6+ files or touches 3+ top-level
  paths, prints the full staged file list and requires a typed `YES`
  confirmation before proceeding. Catches `git add -A` sweeping in
  unrelated WIP before it becomes a commit, not after. Also runs, in
  order, before that check:
  - **Lint** -- `npx eslint .`, only if an ESLint config file is present
    at the repo root. No config exists yet, so this is currently a no-op;
    it activates automatically the day a config is added.
  - **Worker tests** -- `npx vitest run` inside `worker/`, only when
    staged changes touch `worker/` *and* at least one `*.test.js` file
    exists there. `worker/package.json` already has a `test` script
    wired to vitest, but no test files exist yet, so this is also
    currently a no-op until real tests are added.
  - **New-feature test-coverage reminder** (`pre-commit-test-check`,
    called from `pre-commit` -- git only runs one script per hook name,
    so this lives as a separate script rather than a second hook) --
    when a *newly added* file under `worker/src/` or `public/` (excluding
    `debug-*.js`) has no matching `*.test.js`/`*.spec.js` file anywhere in
    the repo, drafts a ready-to-paste LLM prompt (the new file's content
    embedded, plus a suggested test path) to `/tmp/test_prompt_<name>.txt`
    and requires a typed `YES` to commit without a test for now. This does
    not call any LLM API -- no key needed, no per-commit cost -- you paste
    the prompt into Perplexity (or whichever LLM you're using) yourself
    and review what comes back before committing it.
- **`pre-push`** -- inspects the commits about to be pushed and prints
  which deploy step(s) apply (`worker/` changes need a separate
  `npm run deploy`; `public/` changes trigger Cloudflare Pages and should
  be verified live afterward), so the two deploy paths stop getting
  conflated.
- **`post-commit`** -- fires right after a commit lands (it cannot block
  or undo anything -- the commit object already exists) and prints the
  same worker/public deploy reminder as `pre-push`, but immediately, so
  you see it the moment you commit rather than only at push time.

**One-time setup per clone:**
```bash
bash githooks/install.sh
```
This `chmod +x`'s the hook scripts and runs
`git config core.hooksPath githooks` so git actually uses them. Re-run it
after any fresh clone or if `core.hooksPath` ever gets reset.

---

## Standing rules (carried over from existing practice)

- Git commands are run by Ed, in his own terminal -- never executed on his
  behalf via automated tooling. Any assistant preparing a deploy provides
  exact commands, doesn't run them.
- Debug files (`debug-*.js`) are not refactored or deleted as a matter of
  course -- see `DEBUG-SYSTEM.md` for that policy and its rearchitecture
  exception.
- Physical file deletions/moves require explicit confirmation before any
  command is proposed.

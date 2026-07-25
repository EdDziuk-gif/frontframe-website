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
  instead of relying on remembering to write messages to a file.
- **`pre-commit`** -- if a commit stages 6+ files or touches 3+ top-level
  paths, prints the full staged file list and requires a typed `YES`
  confirmation before proceeding. Catches `git add -A` sweeping in
  unrelated WIP before it becomes a commit, not after.
- **`pre-push`** -- inspects the commits about to be pushed and prints
  which deploy step(s) apply (`worker/` changes need a separate
  `npm run deploy`; `public/` changes trigger Cloudflare Pages and should
  be verified live afterward), so the two deploy paths stop getting
  conflated.
- **`post-commit`** -- fires right after a commit lands (it cannot block
  or undo anything -- the commit object already exists) and prints the
  same worker/public deploy reminder as `pre-push`, but immediately, so
  you see it the moment you commit rather than only at push time.

`pre-commit` also runs two additional checks before the wide-commit
list/confirmation, each skipping gracefully until the underlying tooling
actually exists in the repo:

- **Lint** -- runs `npx eslint .` only if an ESLint config file is
  present at the repo root. No config exists yet, so this is currently a
  no-op; it activates automatically the day a config is added.
- **Worker tests** -- runs `npx vitest run` inside `worker/` only when
  staged changes touch `worker/` *and* at least one `*.test.js` file
  exists there. `worker/package.json` already has a `test` script wired
  to vitest, but no test files exist yet, so this is also currently a
  no-op until real tests are added.

`commit-msg` also enforces basic message formatting, on top of the
backtick guard: non-empty subject line, subject <=72 characters, no
trailing period on the subject, and a blank line separating the subject
from any body text (standard git convention -- matches the style already
used for every commit in this SOP).

**One-time setup per clone:**
```bash
bash githooks/install.sh
```
This `chmod +x`'s the three hook scripts and runs
`git config core.hooksPath githooks` so git actually uses them. Re-run it
after any fresh clone or if `core.hooksPath` ever gets reset.

---

## Enforcement: versioned git hooks

The checklist above is now also enforced mechanically via hooks in
`githooks/` (versioned in this repo -- `.git/hooks` itself is not, so
scripts live here instead and git is pointed at them):

- **`commit-msg`** -- rejects any commit message containing a backtick,
  closing off the shell command-substitution mangling risk at the source
  instead of relying on remembering to write messages to a file.
- **`pre-commit`** -- if a commit stages 6+ files or touches 3+ top-level
  paths, prints the full staged file list and requires a typed `YES`
  confirmation before proceeding. Catches `git add -A` sweeping in
  unrelated WIP before it becomes a commit, not after.
- **`pre-push`** -- inspects the commits about to be pushed and prints
  which deploy step(s) apply (`worker/` changes need a separate
  `npm run deploy`; `public/` changes trigger Cloudflare Pages and should
  be verified live afterward), so the two deploy paths stop getting
  conflated.

**One-time setup per clone:**
```bash
bash githooks/install.sh
```
This `chmod +x`'s the three hook scripts and runs
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

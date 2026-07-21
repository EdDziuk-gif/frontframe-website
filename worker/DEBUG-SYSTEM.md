# FrontFrame Debug System

A lightweight, repo-permanent debugging pattern for Worker + HTML admin builds.
Debug files are never deleted. They are activated and deactivated by a single
line in the production file.

---

## Concept

Production files (`src/index.js`, `admin.html`) are never edited during a debug
session. All debug code lives in dedicated files that stay in the repo permanently.
To start a session, add one activation block. To end it, delete that block.
No other files change.

---

## File Naming Convention

```
src/
  index.js              ← production Worker, always clean
  debug-{feature}.js    ← Worker debug module for that feature

site/
  admin.html            ← production HTML, always clean
  debug-{feature}.js    ← HTML debug override script for that feature
```

Examples:
- `src/debug-worker.js`    — OTP auth routes (Worker)
- `src/debug-notify.js`    — /notify route
- `debug-otp.js`           — HTML overrides for OTP login functions
- `debug-chat.js`          — HTML overrides for chat send/receive functions

---

## Worker Activation Block

Add these 3 lines to `src/index.js` inside the route dispatch block.
The import goes at the top of the file. The two route lines go in the
dispatch block above any catch-all 404 return.

```js
// [DEBUG:otp] ── remove these 3 lines to end debug session
import { handleSendOtp, handleVerifyOtp } from './debug-worker.js';
if (method === "POST" && url.pathname === "/auth/otp")        return await handleSendOtp(request, env, corsHeaders);
if (method === "POST" && url.pathname === "/auth/otp/verify") return await handleVerifyOtp(request, env, corsHeaders);
```

**To deactivate:** delete all 3 lines. `debug-worker.js` stays untouched.

---

## HTML Activation Block

Add these 2 lines to `admin.html`, after the closing `</script>` tag,
immediately before `</body>`.

```html
<!-- [DEBUG:otp] ── remove this tag to end debug session -->
<script src="/debug-otp.js"></script>
```

The script loads after the main `<script>` block, so the debug versions of
`sendOtp` and `verifyOtp` overwrite the production versions via `window.*`
assignment. The override fires at page load automatically.

**To deactivate:** delete both lines. `debug-otp.js` stays untouched.

---

## Searching for Active Debug Sessions

Every activation line contains the tag `[DEBUG:{feature}]`. To find all
active debug sessions across either repo at any time:

```bash
grep -r "\[DEBUG:" src/
grep -r "\[DEBUG:" --include="*.html" .
```

---

## Output Locations

| Source          | Where to read output                                                      |
|-----------------|---------------------------------------------------------------------------|
| Worker module   | Cloudflare dashboard → Workers & Pages → {worker} → Logs → Begin log stream |
| HTML override   | Browser DevTools → Console tab (F12). Open before interacting with the page. |

---

## Debug File Authoring Rules

1. **Worker modules** export named functions only. No side effects at module scope.
2. **HTML scripts** wrap everything in an IIFE and assign overrides to `window.*`.
3. Every `console.log` line is prefixed with `[DEBUG {route-or-function}]` for
   easy filtering in noisy log streams.
4. Tokens and secrets are never logged. Payloads containing auth tokens log
   only their presence (`true/false`) or length, never the value.
5. The activation comment tag `[DEBUG:{feature}]` appears on every activation
   line so grep reliably finds all open sessions.
6. Each debug file opens with a header block showing the feature, the exact
   activation block to paste, and where output appears.

---

## Reusing for a New Client Build

1. Copy `src/debug-worker.js` into the new client's worker repo `src/` folder.
   Update any host constant names if the client uses different naming
   (e.g. `ADMIN_EMAIL` may be `OWNER_EMAIL` in another build).

2. Copy `debug-otp.js` (HTML version) into the new client's site repo root.
   Confirm `WORKER_URL` is defined in the host HTML before the script tag loads.

3. Follow the activation blocks above verbatim.

---

## Current Debug Files

| File                    | Repo        | Feature                        | Status    |
|-------------------------|-------------|--------------------------------|-----------|
| `src/debug-worker.js`   | Worker      | Supabase email OTP auth        | Ready     |
| `src/debug-defects.js`  | Worker      | POST /admin/defects (create)   | Ready     |
| `debug-otp.js`          | Site        | OTP login sendOtp / verifyOtp  | Ready     |

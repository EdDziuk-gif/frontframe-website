// FrontFrame — shared admin client utilities
// api / toast / esc / fmtDate / loadSession / saveSession / clearSession,
// deduped from admin.html and dev-admin.html.
//
// Depends on window.WORKER_URL (config.js) and a page-level `session`
// variable declared with `let session = ...` in the page's own inline
// script. Classic (non-module) top-level `let`/`const` declarations share
// one lexical environment across all <script> tags on a page, so functions
// defined here can read/write that later `session` declaration as long as
// they're only invoked after the page's own script has run (always true —
// they're only called from event handlers / async init, never at parse
// time). Load this file before the page's own inline script.

// Backed by the Supabase SDK's own session storage (supabaseClient from
// supabase-client.js) instead of hand-rolled sessionStorage -- sessions now
// persist across tabs/restarts and auto-refresh. loadSession() is async
// (was sync before); call sites use `await`.
async function loadSession() {
  const { data } = await supabaseClient.auth.getSession();
  if (!data?.session) return null;
  return {
    access_token: data.session.access_token,
    refresh_token: data.session.refresh_token,
    user: { email: data.session.user.email },
  };
}
async function clearSession() {
  await supabaseClient.auth.signOut();
  session = null;
}

let toastTimer;
function toast(msg, type) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className   = 'show' + (type === 'error' ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = ''; }, 3200);
}

async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token}` },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(WORKER_URL + path, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || `Request failed: ${res.status}`);
  }
  return res.json();
}

function fmtDate(iso) {
  if (!iso) return '\u2014';
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

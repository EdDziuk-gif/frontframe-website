// FrontFrame — shared config
// Single source of truth for the backend Worker URL.
// Load this before any other FrontFrame script that references WORKER_URL.
window.WORKER_URL = 'https://api.frontframe.co';

// Cloudflare Turnstile site key (public — safe to ship to the browser).
// Ed: replace with the real site key after creating a Turnstile widget at
// https://dash.cloudflare.com/ -> Turnstile -> Add site (use "Managed" mode).
// The matching secret key goes server-side only, via:
//   wrangler secret put TURNSTILE_SECRET_KEY
window.TURNSTILE_SITE_KEY = '0x4AAAAAAD9DLDtbdGjc_aUS';

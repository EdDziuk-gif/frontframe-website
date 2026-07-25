// FrontFrame — shared config
// Single source of truth for the backend Worker URL.
// Load this before any other FrontFrame script that references WORKER_URL.
window.WORKER_URL = 'https://api.frontframe.co';

// Supabase project — used by supabase-client.js for direct SDK auth calls
// (signInWithOtp / verifyOtp / getSession). The anon key is safe to ship
// client-side by design; it only grants what Supabase Auth + your RLS
// policies allow. Get it from Dashboard -> Project Settings -> API.
window.SUPABASE_URL = 'https://ifjsepyzdnpmwyuytppr.supabase.co';
window.SUPABASE_ANON_KEY = 'PASTE_ANON_KEY_HERE';

// Cloudflare Turnstile site key (public — safe to ship to the browser).
// Ed: replace with the real site key after creating a Turnstile widget at
// https://dash.cloudflare.com/ -> Turnstile -> Add site (use "Managed" mode).
// The matching secret key goes server-side only, via:
//   wrangler secret put TURNSTILE_SECRET_KEY
window.TURNSTILE_SITE_KEY = '0x4AAAAAAD9DLDtbdGjc_aUS';

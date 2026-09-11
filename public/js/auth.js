// FrontFrame — shared login helper
// sendMagicLink, calling the Worker's /auth/magic-link route rather than
// the Supabase SDK's own signInWithOtp. That endpoint generates the link
// server-side via the Supabase Admin API (service-role key) and emails it
// through Resend directly - it does not touch Supabase's own built-in
// email/OTP rate limit, which repeated admin-login testing hit hard with
// no way to raise it from our side. Depends on window.WORKER_URL
// (config.js) - load that before this file.

async function sendMagicLink(email) {
  const res = await fetch(WORKER_URL + '/auth/magic-link', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to send sign-in link.');
  }
}

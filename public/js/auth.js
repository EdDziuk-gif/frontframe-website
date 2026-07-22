// FrontFrame — shared OTP auth helpers
// sendOtp / verifyOtp, deduped from admin.html.
// Depends on window.WORKER_URL (config.js) — load config.js first.
// Note: debug-otp.js (used only during narrow debugging windows) overrides
// window.sendOtp / window.verifyOtp when temporarily added to a page — that
// still works correctly regardless of where these are defined, as long as
// this script loads before it.

async function sendOtp(email) {
  const res = await fetch(`${WORKER_URL}/auth/otp`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Failed to send code.');
  }
}

async function verifyOtp(email, token) {
  const res = await fetch(`${WORKER_URL}/auth/otp/verify`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, token }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Invalid or expired code.');
  }
  return res.json();
}

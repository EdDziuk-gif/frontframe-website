// FrontFrame — shared OTP auth helpers
// sendOtp / verifyOtp, deduped from admin.html.
// Depends on window.WORKER_URL (config.js) — load config.js first.

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

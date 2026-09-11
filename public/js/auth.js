// FrontFrame — shared OTP auth helpers
// sendOtp / verifyOtp, calling the Supabase SDK directly (supabaseClient
// from supabase-client.js). Depends on window.SUPABASE_URL/ANON_KEY
// (config.js) and supabase-client.js — load both before this file.
//
// Reinstated after the FrontFrame Supabase project got its own custom SMTP
// configured (matching the Cox Meadows project, which never had a rate-limit
// problem) — the earlier "switch to magic link" fix addressed the wrong
// layer: OTP itself was fine, Supabase's *default* email sender is what's
// rate-limited, and magic links don't fit this app's actual workflow anyway
// (a link is bound to whatever device/browser opens it — no reading the
// code on your phone and typing it into your desktop).

async function sendOtp(email) {
  const { error } = await supabaseClient.auth.signInWithOtp({
    email,
    options: { shouldCreateUser: false },
  });
  if (error) throw new Error(error.message || 'Failed to send code.');
}

async function verifyOtp(email, token) {
  const { data, error } = await supabaseClient.auth.verifyOtp({ email, token, type: 'email' });
  if (error) throw new Error(error.message || 'Invalid or expired code.');
  return { access_token: data.session.access_token, refresh_token: data.session.refresh_token };
}

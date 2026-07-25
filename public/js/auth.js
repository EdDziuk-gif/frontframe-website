// FrontFrame — shared OTP auth helpers
// sendOtp / verifyOtp, calling the Supabase SDK directly (supabaseClient
// from supabase-client.js). Depends on window.SUPABASE_URL/ANON_KEY
// (config.js) and supabase-client.js — load both before this file.

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

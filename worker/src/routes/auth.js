import { jsonResponse } from "../shared/http.js";
import { ADMIN_EMAIL, ADMIN_URL, sendResendEmail } from "../shared/runtime.js";

// § DOMAIN: auth
// ════════════════════════════════════════════════════════════════════════════

async function handleSendOtp(request, env, corsHeaders) {
  const { email } = await request.json().catch(() => ({}));
  if (!email) return jsonResponse({ error: "email is required" }, 400, corsHeaders);
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/otp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": env.SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ email, create_user: false }),
  });
  if (!res.ok) {
    console.error("OTP send failed:", await res.text());
    return jsonResponse({ error: "Failed to send code." }, res.status, corsHeaders);
  }
  return jsonResponse({ sent: true }, 200, corsHeaders);
}

async function handleVerifyOtp(request, env, corsHeaders) {
  const { email, token } = await request.json().catch(() => ({}));
  if (!email || !token) return jsonResponse({ error: "email and token are required" }, 400, corsHeaders);
  const res = await fetch(`${env.SUPABASE_URL}/auth/v1/verify`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": env.SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ email, token, type: "email" }),
  });
  if (!res.ok) {
    console.error("OTP verify failed:", await res.text());
    return jsonResponse({ error: "Invalid or expired code." }, 401, corsHeaders);
  }
  const data = await res.json();
  return jsonResponse({ access_token: data.access_token, refresh_token: data.refresh_token }, 200, corsHeaders);
}

async function handleMagicLink(request, env, corsHeaders) {
  const { email } = await request.json();
  if (!email || email.toLowerCase() !== ADMIN_EMAIL)
    return jsonResponse({ error: "Unauthorized" }, 403, corsHeaders);

  const genRes = await fetch(`${env.SUPABASE_URL}/auth/v1/admin/generate_link`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "apikey": env.SUPABASE_SERVICE_ROLE_KEY, "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}` },
    body: JSON.stringify({ type: "magiclink", email: ADMIN_EMAIL, options: { redirect_to: ADMIN_URL } }),
  });
  if (!genRes.ok) throw new Error(`Magic link generation failed: ${await genRes.text()}`);
  const genData   = await genRes.json();
  const magicLink = genData.action_link;
  if (!magicLink) return jsonResponse({ error: "Failed to generate sign-in link" }, 500, corsHeaders);

  const html = `<!DOCTYPE html><html><body style="font-family:Inter,system-ui,sans-serif;color:#1E2D40;max-width:480px;margin:0 auto;padding:40px 24px">
<div style="margin-bottom:32px"><strong style="font-size:1.1rem">FrontFrame Admin</strong></div>
<p style="margin-bottom:20px">Click below to sign in to the FrontFrame Admin Portal. This link expires in 1 hour and can only be used once.</p>
<p style="margin:32px 0"><a href="${magicLink}" style="background:#1E2D40;color:white;padding:14px 28px;border-radius:8px;text-decoration:none;font-weight:700;display:inline-block">Sign In to Admin</a></p>
<p style="font-size:0.8rem;color:#8A9BAE">If you did not request this link, you can safely ignore this email.</p>
<hr style="border:none;border-top:1px solid #E8ECF0;margin:32px 0">
<p style="font-size:0.75rem;color:#8A9BAE">FrontFrame LLC</p>
</body></html>`;

  await sendResendEmail(env, ADMIN_EMAIL, "FrontFrame Admin Sign-In Link", html);
  return jsonResponse({ sent: true }, 200, corsHeaders);
}


// ════════════════════════════════════════════════════════════════════════════

export { handleSendOtp, handleVerifyOtp, handleMagicLink };

/**
 * debug-otp-routes.js
 * FrontFrame Debug System -- Worker Module
 *
 * Feature: Supabase Email OTP Auth -- POST /auth/otp and POST /auth/otp/verify
 *
 * ACTIVATION (add to src/index.js):
 * ------------------------------------------------------------------
 * // [DEBUG:otp-routes] -- remove these 3 lines to end debug session
 * import { handleSendOtp, handleVerifyOtp } from './debug-otp-routes.js';
 * if (method === "POST" && url.pathname === "/auth/otp")        return await handleSendOtp(request, env, corsHeaders);
 * if (method === "POST" && url.pathname === "/auth/otp/verify") return await handleVerifyOtp(request, env, corsHeaders);
 * ------------------------------------------------------------------
 * Place the import at the top of the file.
 * Place the two route lines ABOVE the existing POST /auth/magic-link line.
 *
 * DEACTIVATION: delete the 3 lines above. This file stays in the repo.
 *
 * OUTPUT: Cloudflare dashboard -> Workers & Pages -> frontframe-worker -> Logs -> Begin log stream
 */

const TAG = "[DEBUG otp-routes]";

function jsonResponse(body, status, headers) {
  return new Response(JSON.stringify(body), {
	status: status || 200,
	headers: Object.assign({ "Content-Type": "application/json" }, headers || {})
  });
}

// ---------------------------------------------------------------------------
// POST /auth/otp -- send OTP email via Supabase
// ---------------------------------------------------------------------------

export async function handleSendOtp(request, env, corsHeaders) {
  console.log(TAG + " POST /auth/otp -- handler entered");

  let body;
  try {
	body = await request.json();
  } catch (e) {
	console.error(TAG + " Failed to parse request body: " + e.message);
	return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders);
  }

  const email = body.email;
  console.log(TAG + " Email received: " + (email || "(none)"));

  if (!email) {
	console.error(TAG + " No email in request body");
	return jsonResponse({ error: "email is required" }, 400, corsHeaders);
  }

  console.log(TAG + " SUPABASE_URL present: " + !!env.SUPABASE_URL);
  console.log(TAG + " SUPABASE_SERVICE_ROLE_KEY present: " + !!env.SUPABASE_SERVICE_ROLE_KEY);

  const otpUrl = env.SUPABASE_URL + "/auth/v1/otp";
  console.log(TAG + " Calling Supabase OTP URL: " + otpUrl);

  let res;
  try {
	res = await fetch(otpUrl, {
	  method: "POST",
	  headers: {
		"Content-Type": "application/json",
		"apikey": env.SUPABASE_SERVICE_ROLE_KEY,
		"Authorization": "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY
	  },
	  body: JSON.stringify({ email: email, create_user: false })
	});
  } catch (e) {
	console.error(TAG + " Fetch to Supabase threw: " + e.message);
	return jsonResponse({ error: "Network error calling Supabase: " + e.message }, 500, corsHeaders);
  }

  console.log(TAG + " Supabase OTP response status: " + res.status + " " + res.statusText);
  const resText = await res.text();
  console.log(TAG + " Supabase OTP response body: " + resText);

  if (!res.ok) {
	return jsonResponse({ error: "Failed to send OTP: " + resText }, res.status, corsHeaders);
  }

  console.log(TAG + " OTP send succeeded");
  return jsonResponse({ sent: true }, 200, corsHeaders);
}

// ---------------------------------------------------------------------------
// POST /auth/otp/verify -- verify OTP token via Supabase
// ---------------------------------------------------------------------------

export async function handleVerifyOtp(request, env, corsHeaders) {
  console.log(TAG + " POST /auth/otp/verify -- handler entered");

  let body;
  try {
	body = await request.json();
  } catch (e) {
	console.error(TAG + " Failed to parse request body: " + e.message);
	return jsonResponse({ error: "Invalid JSON body" }, 400, corsHeaders);
  }

  const email = body.email;
  const token = body.token;
  console.log(TAG + " Email received: " + (email || "(none)"));
  console.log(TAG + " Token length: " + (token ? token.length : 0));

  if (!email || !token) {
	console.error(TAG + " Missing email or token");
	return jsonResponse({ error: "email and token are required" }, 400, corsHeaders);
  }

  const verifyUrl = env.SUPABASE_URL + "/auth/v1/verify";
  console.log(TAG + " Calling Supabase verify URL: " + verifyUrl);

  let res;
  try {
	res = await fetch(verifyUrl, {
	  method: "POST",
	  headers: {
		"Content-Type": "application/json",
		"apikey": env.SUPABASE_SERVICE_ROLE_KEY,
		"Authorization": "Bearer " + env.SUPABASE_SERVICE_ROLE_KEY
	  },
	  body: JSON.stringify({ email: email, token: token, type: "email" })
	});
  } catch (e) {
	console.error(TAG + " Fetch to Supabase threw: " + e.message);
	return jsonResponse({ error: "Network error calling Supabase: " + e.message }, 500, corsHeaders);
  }

  console.log(TAG + " Supabase verify response status: " + res.status + " " + res.statusText);
  const resText = await res.text();
  console.log(TAG + " Supabase verify response body: " + resText);

  if (!res.ok) {
	return jsonResponse({ error: "Invalid or expired code" }, 401, corsHeaders);
  }

  let data;
  try {
	data = JSON.parse(resText);
  } catch (e) {
	console.error(TAG + " Failed to parse Supabase verify response: " + e.message);
	return jsonResponse({ error: "Unexpected response from Supabase" }, 500, corsHeaders);
  }

  console.log(TAG + " access_token present: " + !!data.access_token);
  console.log(TAG + " refresh_token present: " + !!data.refresh_token);
  console.log(TAG + " Verify succeeded");

  return jsonResponse({
	access_token:  data.access_token,
	refresh_token: data.refresh_token
  }, 200, corsHeaders);
}
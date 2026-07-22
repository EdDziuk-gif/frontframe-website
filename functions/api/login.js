// FrontFrame Preview — Login API
// POST /api/login
// Body: { password: string }
// Sets session cookie on success, returns 401 on failure.

import { COOKIE_NAME, COOKIE_MAX_AGE, getSalt, hashPassword } from "../_shared/session.js";

export async function onRequestPost(context) {
  const { request, env } = context;

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid request" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const { password, next = "/" } = body;

  if (!password || password !== env.PREVIEW_PASSWORD) {
    return new Response(JSON.stringify({ error: "Incorrect password" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  const token = await hashPassword(password, getSalt(env));

  return new Response(JSON.stringify({ success: true, next }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Set-Cookie": `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}`,
    },
  });
}

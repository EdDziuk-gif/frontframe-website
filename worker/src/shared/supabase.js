export function supabaseHeaders(env) {
  return {
    "Content-Type": "application/json",
    "apikey": env.SUPABASE_SERVICE_ROLE_KEY,
    "Authorization": `Bearer ${env.SUPABASE_SERVICE_ROLE_KEY}`,
    "Prefer": "return=representation",
  };
}

export async function supabaseFetch(env, table, query = "", _userJwt = null) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}${query}`,
    { method: "GET", headers: supabaseHeaders(env) });
  if (!res.ok) throw new Error(`Supabase GET ${table} failed: ${await res.text()}`);
  return res.json();
}

export async function supabasePost(env, table, payload, _userJwt = null) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`,
    { method: "POST", headers: supabaseHeaders(env), body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`Supabase POST ${table} failed: ${await res.text()}`);
  return res.json();
}

export async function supabasePatch(env, table, id, payload, _userJwt = null) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`,
    { method: "PATCH", headers: supabaseHeaders(env), body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`Supabase PATCH ${table} failed: ${await res.text()}`);
  return res.json();
}

export async function supabasePatchByField(env, table, field, value, payload) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/${table}?${field}=eq.${encodeURIComponent(value)}`,
    { method: "PATCH", headers: supabaseHeaders(env), body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`Supabase PATCH ${table} by ${field} failed: ${await res.text()}`);
  return res.json();
}

export async function supabaseUpsert(env, table, payload, _userJwt = null) {
  const headers = { ...supabaseHeaders(env), "Prefer": "return=representation,resolution=merge-duplicates" };
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}`,
    { method: "POST", headers, body: JSON.stringify(payload) });
  if (!res.ok) throw new Error(`Supabase UPSERT ${table} failed: ${await res.text()}`);
  return res.json();
}

export async function supabaseDelete(env, table, id, _userJwt = null) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/${table}?id=eq.${id}`,
    { method: "DELETE", headers: supabaseHeaders(env) });
  if (!res.ok) throw new Error(`Supabase DELETE ${table} failed: ${await res.text()}`);
}

export async function supabaseRpc(env, fnName, params = {}) {
  const res = await fetch(`${env.SUPABASE_URL}/rest/v1/rpc/${fnName}`,
    { method: "POST", headers: supabaseHeaders(env), body: JSON.stringify(params) });
  if (!res.ok) throw new Error(`Supabase RPC ${fnName} failed: ${await res.text()}`);
  return res.json();
}

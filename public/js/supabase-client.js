// FrontFrame — shared Supabase client
// Depends on window.SUPABASE_URL / SUPABASE_ANON_KEY (config.js) and the
// Supabase JS SDK <script> tag — load both before this file, and load this
// file before client-utils.js / auth.js.

const supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Mirrors the SDK's own session state into the page-level `session` variable
// (declared with `let session = ...` in each page's own inline script) so
// existing code that reads session.access_token / session.user.email keeps
// working unchanged. Fires on sign-in, sign-out, auto token refresh, and
// cross-tab auth changes (the SDK listens for localStorage updates from
// other tabs) — covers everything except the immediate post-verifyOtp
// moment, which each page's login handler sets directly to avoid any race.
supabaseClient.auth.onAuthStateChange((_event, sdkSession) => {
  session = sdkSession
    ? {
        access_token: sdkSession.access_token,
        refresh_token: sdkSession.refresh_token,
        user: { email: sdkSession.user.email },
      }
    : null;
});

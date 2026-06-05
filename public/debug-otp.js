/**
 * debug-otp.js  (site repo — loaded by admin.html)
 * FrontFrame Debug System — HTML Override Script
 *
 * Feature: Supabase Email OTP Authentication
 * Overrides: sendOtp()  |  verifyOtp()
 *
 * ACTIVATION (add to admin.html, after the closing </script> tag, before </body>):
 * ─────────────────────────────────────────────────────────────────
 * <!-- [DEBUG:otp] ── remove this tag to end debug session -->
 * <script src="/debug-otp.js"></script>
 * ─────────────────────────────────────────────────────────────────
 *
 * DEACTIVATION: delete the 2 lines above. This file stays in the repo.
 *
 * OUTPUT: Browser DevTools console (F12 → Console tab)
 *   Open before clicking Send Code. All steps log in sequence.
 *
 * REUSE: Copy to any client site repo. WORKER_URL must be defined in
 *   the host admin.html <script> block before this file loads.
 */

(function installOtpDebug() {

  // -------------------------------------------------------------------------
  // Override sendOtp — instruments the POST /auth/otp call
  // -------------------------------------------------------------------------

  window.sendOtp = async function sendOtp(email) {
    const tag = '[DEBUG sendOtp]';
    const url = `${WORKER_URL}/auth/otp`;

    console.group(`${tag} Initiating OTP send`);
    console.log('URL:    ', url);
    console.log('Email:  ', email);

    let res;
    try {
      res = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email }),
      });
    } catch (networkErr) {
      console.error(`${tag} Network error — fetch never completed:`, networkErr);
      console.groupEnd();
      throw new Error('Network error. Check that the Worker is deployed.');
    }

    console.log('Status: ', res.status, res.statusText);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error(`${tag} Worker returned error:`, err);
      console.groupEnd();
      throw new Error(err.error || 'Failed to send code.');
    }

    const data = await res.json().catch(() => ({}));
    console.log(`${tag} Success. Response body:`, data);
    console.groupEnd();
  };

  // -------------------------------------------------------------------------
  // Override verifyOtp — instruments the POST /auth/otp/verify call
  // -------------------------------------------------------------------------

  window.verifyOtp = async function verifyOtp(email, token) {
    const tag = '[DEBUG verifyOtp]';
    const url = `${WORKER_URL}/auth/otp/verify`;

    console.group(`${tag} Initiating OTP verify`);
    console.log('URL:         ', url);
    console.log('Email:       ', email);
    console.log('Token length:', token?.length ?? 0);

    let res;
    try {
      res = await fetch(url, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email, token }),
      });
    } catch (networkErr) {
      console.error(`${tag} Network error — fetch never completed:`, networkErr);
      console.groupEnd();
      throw new Error('Network error. Check that the Worker is deployed.');
    }

    console.log('Status: ', res.status, res.statusText);

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      console.error(`${tag} Worker returned error:`, err);
      console.groupEnd();
      throw new Error(err.error || 'Invalid or expired code.');
    }

    const data = await res.json();
    console.log(`${tag} access_token present: `, !!data.access_token);
    console.log(`${tag} refresh_token present:`, !!data.refresh_token);
    console.groupEnd();
    return data;
  };

  console.info('[DEBUG:otp] OTP debug overrides installed. sendOtp and verifyOtp are now instrumented.');

})();

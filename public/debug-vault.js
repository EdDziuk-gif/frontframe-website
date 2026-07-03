/*
 * debug-vault.js — traces the vault load/populate pipeline in admin.html
 *
 * Wraps window.vaultLoad and window.vaultPopulate (both plain `function`
 * declarations in admin.html's main <script>, so they exist as window
 * properties) without touching the originals. Logs, for every vendor:
 *   - the raw entries object returned by GET /admin/vault
 *   - what DOM input/select elements actually exist for that vendor
 *   - whether the returned data object has a matching key for each element
 *   - the element's value immediately after assignment
 *   - the element's value again 500ms later, to catch anything that wipes
 *     the fields after populate runs
 *
 * Activation: a two-line block in admin.html right before </body>.
 * Remove that block to end the debug session — this file can stay in the
 * repo either way, it does nothing unless loaded.
 */
(function () {
  console.log('%c[DEBUG:vault] debug-vault.js loaded', 'color:#F5A623;font-weight:bold');

  if (typeof window.vaultPopulate !== 'function') {
    console.error('[DEBUG:vault] window.vaultPopulate is not a function — cannot wrap. Check load order (this script must load AFTER the main admin.html <script> block).');
    return;
  }
  if (typeof window.vaultLoad !== 'function') {
    console.error('[DEBUG:vault] window.vaultLoad is not a function — cannot wrap.');
    return;
  }

  const origPopulate = window.vaultPopulate;
  const origLoad      = window.vaultLoad;

  function domFieldsForVendor(vendor) {
    const panel = document.getElementById('subPanel-' + vendor);
    if (!panel) {
      console.warn(`[DEBUG:vault] no #subPanel-${vendor} found in the DOM`);
      return [];
    }
    const prefix = vendor + '_';
    return Array.from(panel.querySelectorAll('[id^="' + prefix + '"]')).map(el => ({
      id:    el.id,
      field: el.id.slice(prefix.length),
      tag:   el.tagName,
    }));
  }

  window.vaultPopulate = function (vendor, data) {
    console.group(`[DEBUG:vault] vaultPopulate("${vendor}")`);
    console.log('data argument:', data);
    console.log('typeof data:', typeof data, Array.isArray(data) ? '(array!)' : '');

    const domFields = domFieldsForVendor(vendor);
    console.log(`DOM fields found under #subPanel-${vendor}:`, domFields.map(f => f.field));

    if (data && typeof data === 'object') {
      console.log('keys present in data:', Object.keys(data));
      domFields.forEach(({ id, field }) => {
        const inData = Object.prototype.hasOwnProperty.call(data, field);
        console.log(
          `  field "${field}" (el #${id}):`,
          inData ? `✓ key in data (value: ${JSON.stringify(data[field]).slice(0, 40)})` : '✗ MISSING from data object'
        );
      });
    } else {
      console.warn('data is not a populatable object — original guard `if (!data) return;` will likely short-circuit here');
    }

    // Call the real implementation
    const result = origPopulate.apply(this, arguments);

    // Check what actually landed in the DOM immediately after
    console.log('--- post-populate DOM values (immediate) ---');
    domFields.forEach(({ id }) => {
      const el = document.getElementById(id);
      console.log(`  #${id}.value =`, JSON.stringify((el && el.value) || '').slice(0, 60));
    });

    // Check again shortly after, in case something else clears the fields
    setTimeout(() => {
      console.group(`[DEBUG:vault] vaultPopulate("${vendor}") — 500ms follow-up check`);
      domFields.forEach(({ id }) => {
        const el = document.getElementById(id);
        console.log(`  #${id}.value =`, JSON.stringify((el && el.value) || '').slice(0, 60));
      });
      console.groupEnd();
    }, 500);

    console.groupEnd();
    return result;
  };

  // NOTE: admin.html declares `const WORKER_URL` and `let session` at the
  // top level of its own classic <script> block. Neither becomes a window
  // property (that's only true of top-level `function`/`var` declarations),
  // so this script cannot read them directly. Hardcode the known-current
  // Worker URL and pull the session token straight from sessionStorage
  // (same key admin.html's own loadSession() reads) instead.
  const DEBUG_WORKER_URL = 'https://api.frontframe.co';
  function debugGetToken() {
    try { return JSON.parse(sessionStorage.getItem('ff_session'))?.access_token ?? null; }
    catch { return null; }
  }

  async function debugFetchVault(bustCache) {
    const token = debugGetToken();
    if (!token) { console.error('[DEBUG:vault] no session token found in sessionStorage("ff_session")'); return null; }
    const url = DEBUG_WORKER_URL + '/admin/vault' + (bustCache ? ('?_=' + Date.now()) : '');
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${token}`, ...(bustCache ? { 'Cache-Control': 'no-cache' } : {}) },
      cache: bustCache ? 'no-store' : 'default',
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body, cfCacheStatus: res.headers.get('cf-cache-status') };
  }

  window.vaultLoad = async function () {
    console.group('[DEBUG:vault] vaultLoad()');
    try {
      // Normal-path fetch — mirrors exactly what the app itself does.
      const normal = await debugFetchVault(false).catch(e => { console.error('[DEBUG:vault] normal fetch failed:', e); return null; });
      if (normal) {
        console.log('normal fetch → status:', normal.status, ' cf-cache-status:', normal.cfCacheStatus);
        console.log('normal fetch → surge.data:', normal.body?.surge?.data);
        console.log('normal fetch → cloudflare.data:', normal.body?.cloudflare?.data);
      }

      // Cache-busted fetch — unique query string + no-store + Cache-Control: no-cache.
      const busted = await debugFetchVault(true).catch(e => { console.error('[DEBUG:vault] cache-busted fetch failed:', e); return null; });
      if (busted) {
        console.log('cache-busted fetch → status:', busted.status, ' cf-cache-status:', busted.cfCacheStatus);
        console.log('cache-busted fetch → surge.data:', busted.body?.surge?.data);
        console.log('cache-busted fetch → cloudflare.data:', busted.body?.cloudflare?.data);
      }

      if (normal && busted) {
        const same = JSON.stringify(normal.body?.surge?.data) === JSON.stringify(busted.body?.surge?.data);
        console.log(same
          ? '%cnormal vs cache-busted surge.data: IDENTICAL — caching ruled out'
          : '%cnormal vs cache-busted surge.data: DIFFERENT — caching is very likely the cause',
          'font-weight:bold;color:' + (same ? '#888' : '#e74c3c'));
      }

      const result = await origLoad.apply(this, arguments);
      console.log('vaultLoad() completed without throwing');
      console.groupEnd();
      return result;
    } catch (e) {
      console.error('[DEBUG:vault] vaultLoad() threw:', e);
      console.groupEnd();
      throw e;
    }
  };

  console.log('[DEBUG:vault] wrapping complete — reload the Subscriptions tab (or the whole page) to capture a trace.');
})();

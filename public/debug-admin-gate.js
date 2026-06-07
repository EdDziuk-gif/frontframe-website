/**
 * debug-admin-gate.js  (site repo — loaded by admin.html)
 * FrontFrame Debug System — HTML Override Script
 *
 * Feature: Admin gate — showAdmin() dev_access check
 * Overrides: showAdmin()
 *
 * ACTIVATION (add to admin.html, after the closing </script> tag, before </body>):
 * ─────────────────────────────────────────────────────────────────
 * <!-- [DEBUG:admin-gate] ── remove this tag to end debug session -->
 * <script src="/debug-admin-gate.js"></script>
 * ─────────────────────────────────────────────────────────────────
 *
 * DEACTIVATION: delete the 2 lines above. This file stays in the repo.
 *
 * OUTPUT: Browser DevTools console (F12 → Console tab)
 *   Open before logging in. All steps log in sequence.
 */

(function installAdminGateDebug() {

  window.showAdmin = async function showAdmin() {
	const tag = '[DEBUG showAdmin]';

	console.group(`${tag} showAdmin entered`);

	// Step 1 — reveal the shell
	document.getElementById('login-screen').classList.add('hidden');
	document.getElementById('app-shell').classList.remove('hidden');
	console.log(`${tag} 1. Shell revealed`);

	// Step 2 — session state
	console.log(`${tag} 2. session object present: ${!!session}`);
	console.log(`${tag} 2. session.access_token present: ${!!session?.access_token}`);
	console.log(`${tag} 2. session.user.email: ${session?.user?.email ?? '(none)'}`);

	// Step 3 — fetch reviewers
	console.log(`${tag} 3. Fetching /admin/reviewers …`);
	let reviewerList;
	try {
	  const res = await fetch(WORKER_URL + '/admin/reviewers', {
		headers: {
		  'Content-Type': 'application/json',
		  'Authorization': `Bearer ${session?.access_token}`,
		},
	  });
	  console.log(`${tag} 3. Response status: ${res.status} ${res.statusText}`);
	  if (!res.ok) {
		const errBody = await res.text();
		console.error(`${tag} 3. Non-OK response body: ${errBody}`);
		reviewerList = [];
	  } else {
		reviewerList = await res.json();
		console.log(`${tag} 3. Reviewer count returned: ${reviewerList.length}`);
		console.log(`${tag} 3. Reviewer emails: ${reviewerList.map(r => r.email).join(', ')}`);
		console.log(`${tag} 3. dev_access values: ${JSON.stringify(reviewerList.map(r => ({ email: r.email, dev_access: r.dev_access })))}`);
	  }
	} catch (e) {
	  console.error(`${tag} 3. Fetch threw: ${e.message}`);
	  reviewerList = [];
	}

	// Step 4 — match session email to reviewer
	const userEmail = session?.user?.email ?? '';
	const me = reviewerList.find(r => r.email === userEmail);
	console.log(`${tag} 4. Looking for email: "${userEmail}"`);
	console.log(`${tag} 4. Reviewer match found: ${!!me}`);
	console.log(`${tag} 4. Matched reviewer: ${JSON.stringify(me ?? null)}`);
	console.log(`${tag} 4. dev_access on match: ${me?.dev_access ?? '(no match)'}`);

	// Step 5 — dev tools link
	const devLink = document.getElementById('dev-tools-link');
	console.log(`${tag} 5. dev-tools-link element found: ${!!devLink}`);
	const shouldShow = me?.dev_access === true;
	console.log(`${tag} 5. shouldShow dev tools: ${shouldShow}`);
	if (devLink) {
	  devLink.style.display = shouldShow ? '' : 'none';
	  console.log(`${tag} 5. devLink.style.display set to: "${devLink.style.display}"`);
	}

	// Step 6 — switch to default tab
	console.log(`${tag} 6. Calling switchTab('pipeline')`);
	console.groupEnd();
	switchTab('pipeline');
  };

  console.info('[DEBUG:admin-gate] showAdmin debug override installed.');

})();
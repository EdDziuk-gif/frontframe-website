// FrontFrame — chat-widget.js
// Shared chat widget logic, extracted from ~12 pages of copy-pasted inline
// <script> blocks (see: about.html, yours.html, resources/*.html, intake.html,
// added-intake.html, discovery.html, intake-confirmation.html, operating-model.html,
// blueprint.html, etc.).
//
// Usage:
//   <script src="/js/chat-widget.js" data-page="yours"></script>
//
// Optional per-page customization (all have sensible defaults matching the
// original "canonical" widget, so most pages need only data-page):
//   data-greeting            Custom opening message. Default: the standard
//                             FrontFrame intro.
//   data-source               Label sent to /notify so leads can be traced back
//                             to the page they came from. Default: "agent".
//   data-handoff              "false" disables the [COLLECTED:...] parsing and
//                             the notify-Ed handoff entirely — the chat stays
//                             plain Q&A. Default: enabled. Use this for pages
//                             where the visitor's contact info is already known
//                             (e.g. right after they've submitted a form).
//   data-confirm-msg          Message shown after a successful handoff. Default:
//                             "Got it — Ed will follow up directly." Ignored if
//                             data-handoff="false".
//   data-show-privacy-note    "false" skips the "Contact info stored by
//                             FrontFrame..." privacy line after handoff. Default:
//                             shown. Ignored if data-handoff="false".
//   data-placeholder-after    Input placeholder shown once the input is disabled
//                             after handoff. Default: "Ed will be in touch."
//
// The page name is read from this script tag's data-page attribute (and the
// customization above from the same tag) so a single file can serve every
// page without per-page copies.

(function () {
  var scriptEl = document.currentScript;
  var ds = (scriptEl && scriptEl.dataset) || {};

  var PAGE = ds.page || 'unknown';
  var WORKER_URL = 'https://api.frontframe.co';
  var SK = 'chatDismissed_' + PAGE;

  var GREETING = ds.greeting ||
    "Hi — I'm an AI assistant for FrontFrame. Ask me anything about our services, or I can connect you with Ed.";
  var SOURCE = ds.source || 'agent';
  var HANDOFF_ENABLED = ds.handoff !== 'false';
  var CONFIRM_MSG = ds.confirmMsg || 'Got it — Ed will follow up directly.';
  var SHOW_PRIVACY_NOTE = ds.showPrivacyNote !== 'false';
  var PLACEHOLDER_AFTER = ds.placeholderAfter || 'Ed will be in touch.';

  var panel = document.getElementById('chatPanel');
  var toggle = document.getElementById('chatToggle');
  var closeBtn = document.getElementById('chatClose');
  var messages = document.getElementById('chatMessages');
  var input = document.getElementById('chatInput');
  var sendBtn = document.getElementById('chatSend');
  var bubble = document.getElementById('chatBubble');

  // Pages that don't render the floating widget markup (chatPanel/chatToggle)
  // simply won't have these elements — bail out quietly instead of throwing.
  if (!panel || !toggle || !closeBtn || !messages || !input || !sendBtn) return;

  var sessionId = crypto.randomUUID();
  var isOpen = false, history = [], greeted = false, expanded = false, handoffDone = false;

  input.addEventListener('input', function () {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });

  function expandPanel() { if (!expanded) { expanded = true; panel.classList.add('expanded'); } }

  function openChat() {
    isOpen = true; panel.classList.add('open'); toggle.style.display = 'none';
    if (!greeted) { greeted = true; greet(); }
    setTimeout(function () { input.focus(); }, 300);
  }

  function closeChat() {
    isOpen = false; panel.classList.remove('open'); toggle.style.display = 'flex';
    sessionStorage.setItem(SK, 'true');
  }

  toggle.addEventListener('click', openChat);
  closeBtn.addEventListener('click', closeChat);

  function addMessage(text, role) {
    var d = document.createElement('div');
    d.className = 'msg ' + (role === 'user' ? 'user' : role === 'confirmed' ? 'confirmed' : 'agent');
    d.textContent = text; messages.appendChild(d); messages.scrollTop = messages.scrollHeight;
  }

  function addTyping() {
    var d = document.createElement('div');
    d.className = 'msg typing'; d.id = 'np-typing'; d.textContent = 'Thinking…';
    messages.appendChild(d); messages.scrollTop = messages.scrollHeight;
  }

  function removeTyping() { var el = document.getElementById('np-typing'); if (el) el.remove(); }

  function parseCollected(r) {
    var m = r.match(/\[COLLECTED:([\s\S]*?)\]/);
    if (!m) return null;
    try { return JSON.parse(m[1]); } catch (e) { return null; }
  }

  async function notifyEd(contactData) {
    if (handoffDone) return; handoffDone = true;
    var transcript = history.filter(function (m) { return m.role === 'user' || m.role === 'assistant'; })
      .map(function (m) { return (m.role === 'user' ? 'Visitor' : 'Assistant') + ': ' + m.content; }).join('\n');
    try {
      await fetch(WORKER_URL + '/notify', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId, name: contactData.name || '',
          contact: contactData.contact || '', method: contactData.method || '',
          summary: contactData.summary || '', transcript: transcript, source: SOURCE
        }),
      });
    } catch (e) {}
  }

  async function sendMessage(text) {
    if (!text.trim()) return;
    expandPanel(); addMessage(text, 'user'); history.push({ role: 'user', content: text });
    input.value = ''; input.style.height = 'auto'; sendBtn.disabled = true; addTyping();
    try {
      var res = await fetch(WORKER_URL + '/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page: PAGE, message: text, history: history.slice(-10), session_id: sessionId }),
      });
      var data = await res.json(); removeTyping();
      var reply = data.response || 'Sorry, something went wrong.';
      var collected = HANDOFF_ENABLED ? parseCollected(reply) : null;
      if (collected) {
        var clean = reply.replace(/\[COLLECTED:[\s\S]*?\]/, '').trim();
        if (clean) { addMessage(clean, 'agent'); history.push({ role: 'assistant', content: clean }); }
        setTimeout(function () {
          addMessage(CONFIRM_MSG, 'confirmed');
          if (SHOW_PRIVACY_NOTE) {
            var privacyNote = document.createElement('div');
            privacyNote.style.cssText = 'font-size:0.72rem;color:#8A9BAE;padding:2px 14px 8px;';
            privacyNote.innerHTML = 'Contact info stored by FrontFrame. <a href="/about#privacy" style="color:#8A9BAE;text-decoration:underline;">Privacy policy</a>';
            messages.appendChild(privacyNote);
            messages.scrollTop = messages.scrollHeight;
          }
          input.disabled = true; sendBtn.disabled = true; input.placeholder = PLACEHOLDER_AFTER;
        }, 600);
        await notifyEd(collected); return;
      }
      addMessage(reply, 'agent'); history.push({ role: 'assistant', content: reply });
    } catch (e) { removeTyping(); addMessage('Having trouble connecting right now. Please try again.', 'agent'); }
    finally { if (!handoffDone) sendBtn.disabled = false; input.focus(); }
  }

  function greet() {
    addMessage(GREETING, 'agent'); history.push({ role: 'assistant', content: GREETING });
  }

  sendBtn.addEventListener('click', function () { sendMessage(input.value); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(input.value); }
  });

  if (bubble && !sessionStorage.getItem(SK)) {
    setTimeout(function () {
      bubble.classList.add('visible');
      setTimeout(function () { bubble.classList.remove('visible'); }, 6000);
    }, 1500);
    bubble.addEventListener('click', function () { bubble.classList.remove('visible'); openChat(); });
  }
})();

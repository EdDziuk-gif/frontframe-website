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
//   data-show-privacy-note    "false" skips the "Contact info stored by
//                             FrontFrame..." privacy line shown after the
//                             visitor's contact request has been sent.
//                             Default: shown.
//
// The conversation lives on the server. This script sends only the page, the
// visitor's message, and the session ticket the server issued; it never sends
// earlier messages and never sends contact details anywhere itself. When a
// visitor asks for a person, the server asks for the details in the chat, shows
// the visitor exactly what will be sent, and sends it only after a yes.
//
// The page name is read from this script tag's data-page attribute (and the
// customization above from the same tag) so a single file can serve every
// page without per-page copies.

(function () {
  var scriptEl = document.currentScript;
  var ds = (scriptEl && scriptEl.dataset) || {};

  var PAGE = ds.page || 'unknown';
  // Reads the shared value set by /js/config.js when that script is loaded
  // on the page; falls back to the hardcoded default for any page that
  // hasn't added config.js yet.
  var WORKER_URL = window.WORKER_URL || 'https://api.frontframe.co';
  var SK = 'chatDismissed_' + PAGE;

  var GREETING = ds.greeting ||
    "Hi — I'm an AI assistant for FrontFrame. Ask me anything about our services, or I can connect you with Ed.";
  var SHOW_PRIVACY_NOTE = ds.showPrivacyNote !== 'false';

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

  // Issued by the server with the first reply; null until then, and again after a
  // contact request is sent (the next message starts a fresh chat).
  var ticket = null;
  var isOpen = false, greeted = false, expanded = false;

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
    d.style.whiteSpace = 'pre-wrap'; d.textContent = text; messages.appendChild(d); messages.scrollTop = messages.scrollHeight;
  }

  function addTyping() {
    var d = document.createElement('div');
    d.className = 'msg typing'; d.id = 'np-typing'; d.textContent = 'Thinking…';
    messages.appendChild(d); messages.scrollTop = messages.scrollHeight;
  }

  function removeTyping() { var el = document.getElementById('np-typing'); if (el) el.remove(); }

  function showPrivacyNote() {
    if (!SHOW_PRIVACY_NOTE) return;
    var privacyNote = document.createElement('div');
    privacyNote.style.cssText = 'font-size:0.72rem;color:#8A9BAE;padding:2px 14px 8px;';
    privacyNote.innerHTML = 'Contact info stored by FrontFrame. <a href="/about#privacy" style="color:#8A9BAE;text-decoration:underline;">Privacy policy</a>';
    messages.appendChild(privacyNote);
    messages.scrollTop = messages.scrollHeight;
  }

  async function sendMessage(text) {
    if (!text.trim()) return;
    expandPanel(); addMessage(text, 'user');
    input.value = ''; input.style.height = 'auto'; sendBtn.disabled = true; addTyping();
    try {
      var res = await fetch(WORKER_URL + '/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ page: PAGE, message: text, session_id: ticket }),
      });
      var data = await res.json(); removeTyping();
      if (!res.ok) { addMessage(data.error || 'Sorry, something went wrong.', 'agent'); return; }
      ticket = data.session_id || null;
      addMessage(data.response || 'Sorry, something went wrong.', 'agent');
      if (data.handoff) showPrivacyNote();
    } catch (e) { removeTyping(); addMessage('Having trouble connecting right now. Please try again.', 'agent'); }
    finally { sendBtn.disabled = false; input.focus(); }
  }

  function greet() {
    addMessage(GREETING, 'agent');
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

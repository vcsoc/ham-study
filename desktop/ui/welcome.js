(() => {
  const key = 'ham-study-speech-consent-v1';
  let decision = null;
  try { decision = localStorage.getItem(key); } catch (_) {}
  const icons = {
    audio: '<path d="M3 9v6h4l5 4V5L7 9H3Zm12-1a6 6 0 0 1 0 8m3-11a10 10 0 0 1 0 14"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5m0-8h.01"/>',
    settings: '<path d="m9 3-.8 2.1-2 .9-2.1-.7-1.5 2.6L4.2 9l-.1 2.4L2.5 13l1.5 2.6 2.2-.5 1.9 1.2.6 2.2h3l.8-2.1 2-.9 2.1.7 1.5-2.6-1.6-1.5.1-2.4 1.6-1.6-1.5-2.6-2.2.5-1.9-1.2L12 3H9Z" transform="translate(1.5 1.25)"/><circle cx="12" cy="12" r="2.5"/>',
    refresh: '<path d="M20 5v5h-5M4 19v-5h5M5.5 9a7 7 0 0 1 11.6-3L20 9m-16 6 2.9 3A7 7 0 0 0 18.5 15"/>',
    sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
    moon: '<path d="M20.9 13A9 9 0 0 1 11 3.1 9 9 0 1 0 20.9 13Z"/>'
  };
  function icon(name) {
    return '<svg class="ham-icon" aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">' + icons[name] + '</svg>';
  }
  for (const [selector, name] of [['#reader-info', 'info'], ['#reader-settings-info', 'info'], ['.settings-button', 'settings'], ['#speech-refresh', 'refresh']]) {
    const button = document.querySelector(selector);
    if (button) button.innerHTML = icon(name);
  }
  const themeButton = document.getElementById('theme-toggle');
  if (themeButton) {
    const sync = () => { themeButton.innerHTML = icon(document.documentElement.dataset.theme === 'dark' ? 'sun' : 'moon'); };
    sync();
    new MutationObserver(sync).observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme']});
  }
  function remember(value) {
    decision = value === 'off' ? 'off' : 'enabled';
    try { localStorage.setItem(key, decision); } catch (_) {}
  }
  window.HamStudyWelcome = {
    remember,
    async choose(supported, preferred) {
      if (decision === 'off') return 'off';
      if (decision === 'enabled') return supported ? preferred : 'off';
      const dialog = document.createElement('dialog');
      dialog.className = 'welcome-dialog';
      dialog.setAttribute('aria-labelledby', 'welcome-heading');
      dialog.innerHTML = '<div class="welcome-emblem">' + icon('audio') + '</div><p class="welcome-kicker">CANADIAN AMATEUR RADIO</p><h1 id="welcome-heading">Welcome to Ham Study</h1><p>Browse the Basic question bank, read offline explanations, and take practice exams.</p>' +
        (supported ? '<p>Optional read-aloud can speak questions, answers, and expanded explanations. Piper is the default voice engine. It needs a one-time download of about <strong>82 MB</strong>, then works offline.</p><p class="welcome-note">You can enable, disable, or change the sound engine later under Reader Settings.</p>' : '<p>Read-aloud is unavailable on this device. The study bank and practice tests still work offline.</p>') +
        '<form method="dialog" class="welcome-actions"><button class="welcome-button" value="off" autofocus>' + (supported ? 'Continue without sound' : 'Start studying') + '</button>' + (supported ? '<button class="welcome-button welcome-button-primary" value="piper">Download Piper</button>' : '') + '</form>';
      document.body.append(dialog);
      return new Promise(resolve => {
        dialog.addEventListener('close', () => {
          const selected = supported && dialog.returnValue === 'piper' ? 'piper' : 'off';
          remember(selected);
          dialog.remove();
          resolve(selected);
        }, {once: true});
        dialog.showModal();
      });
    }
  };
})();

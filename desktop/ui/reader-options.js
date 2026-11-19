(() => {
  'use strict';
  const settings = document.querySelector('.settings-panel');
  const study = document.getElementById('study-page');
  const key = 'ham-reader-expanded-explanations';
  const label = document.createElement('label');
  label.className = 'reader-explanation-option';
  const toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.id = 'reader-explanations';
  toggle.checked = true;
  try { toggle.checked = localStorage.getItem(key) !== 'false'; } catch (_) {}
  label.append(toggle, 'Read expanded explanations');
  settings.append(label);
  toggle.addEventListener('change', () => {
    try { localStorage.setItem(key, String(toggle.checked)); } catch (_) {}
  });

  function chunks(root) {
    const blocks = [];
    for (const child of root.children.length ? root.children : [root]) {
      if (/^H[1-6]$/.test(child.tagName) && /^references\b/i.test(child.textContent.trim())) break;
      const text = child.textContent.replace(/\bhttps?:\/\/\S+/gi, ' ').replace(/\s+/g, ' ').trim();
      if (text) blocks.push(text);
    }
    const words = blocks.join(' ').split(' ').filter(Boolean);
    const parts = [];
    let part = '';
    for (const word of words) {
      if (part && (part.length + word.length > 550 || (part.length >= 220 && /[.!?]$/.test(part)))) {
        parts.push(part);
        part = '';
      }
      part += (part ? ' ' : '') + word;
    }
    if (part) parts.push(part);
    return parts;
  }

  study.addEventListener('click', event => {
    const summary = event.target.closest('.question-explanation > summary.answer');
    if (summary) summary.parentElement.dataset.readerExpanded = String(!summary.parentElement.open);
  });

  window.HamStudyReaderOptions = {
    async readExplanation(passage, active, speak) {
      if (passage.kind !== 'answer' || !toggle.checked) return;
      const details = passage.row.querySelector('.question-explanation');
      const expanded = () => active() && toggle.checked && details?.open && details.dataset.readerExpanded === 'true';
      if (!expanded()) return;
      const root = details.querySelector('.explanation-body') || details.querySelector('.explanation-content > p');
      if (!root || root.textContent.startsWith('No offline explanation')) return;
      for (const text of chunks(root)) {
        if (!expanded()) return;
        await speak({row: passage.row, text, kind: 'explanation', words: []}, expanded);
      }
    },
    shortcuts({active, togglePause, stop, skip}) {
      document.addEventListener('keydown', event => {
        if (event.defaultPrevented || event.repeat || event.altKey || event.ctrlKey || event.metaKey || !active() || study.hidden) return;
        const eligible = !event.target.closest('input, textarea, select, [contenteditable], [role="separator"], a, summary:not(.answer), button:not(#reader-play, #reader-pause, #reader-stop)');
        if (!eligible) return;
        const desktop = !/Android|iPhone|iPad/i.test(navigator.userAgent);
        if (event.code === 'Space') { event.preventDefault(); togglePause(); }
        else if (event.key === 'Escape') { event.preventDefault(); stop(); }
        else if (desktop && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
          event.preventDefault();
          skip(event.key === 'ArrowUp' ? -1 : 1);
        }
      });
    },
    adjacent(row, offset) {
      const rows = [...study.querySelectorAll('ol.study-questions > li')];
      const index = rows.indexOf(row);
      return index === -1 ? null : rows[index + offset];
    }
  };
})();

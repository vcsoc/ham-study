(() => {
  'use strict';
  const bankUrl = 'https://www.clares.ca/en/annotated-test-banks/basic-canadian-amateur-radio';
  const ric3 = 'https://ised-isde.canada.ca/site/spectrum-management-telecommunications/en/licences-and-certificates/radiocom-information-circulars-ric/ric-3-information-amateur-radio-service';
  const notes = {
    'B-001-004-001': 'There is no minimum or maximum age for the Basic qualification. The examination tests whether you have the required knowledge; being under 18 or over 70 does not disqualify you.',
    'B-003-019-008': 'Bond the equipment chassis to the same station ground point. This gives the interconnected equipment a common reference instead of separate ground paths that can form loops. This does not replace protective AC grounding or the requirements of local electrical codes.'
  };
  const bankIds = new Set(JSON.parse(document.getElementById('question-data').textContent).map(question => question.id));

  function element(tag, text) {
    const node = document.createElement(tag);
    node.textContent = text;
    return node;
  }

  function appendLink(parent, label, href) {
    const link = element('a', label);
    link.href = href;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    parent.append(link);
    if (window.__TAURI__?.core && /^Linux/.test(navigator.platform) && !/Android/.test(navigator.userAgent)) {
      link.addEventListener('click', async event => {
        event.preventDefault();
        const error = parent.querySelector('[role="status"]');
        error?.remove();
        try {
          await window.__TAURI__.core.invoke('open_study_reference', { url: href });
        } catch (_) {
          const message = element('p', 'Could not open your browser. Copy this link to open it manually: ' + href);
          message.setAttribute('role', 'status');
          parent.append(message);
        }
      });
    }
    return link;
  }

  function panel(id, open = false) {
    if (!bankIds.has(id)) return null;
    const details = document.createElement('details');
    details.className = 'question-explanation';
    details.open = open;
    const summary = element('summary', 'Explanation');
    const content = document.createElement('div');
    content.className = 'explanation-content';
    if (notes[id]) content.append(element('p', notes[id]));
    if (id === 'B-001-004-001') {
      appendLink(content.appendChild(document.createElement('p')), 'ISED: RIC-3 amateur radio service', ric3);
    }
    // CLARES tracks a newer bank revision; match by question text where the IDs differ.
    const claresId = id === 'B-003-019-008' ? null : id === 'B-008-002-011' ? 'B-003-019-008' : id;
    if (claresId) {
      const link = appendLink(content.appendChild(document.createElement('p')), 'Read the explanation on CLARES', bankUrl + '#question-' + claresId);
      link.setAttribute('aria-label', 'Read the explanation for ' + id + ' on CLARES (opens in browser)');
      const hint = claresId === id ? 'Opens ' + id : 'CLARES lists this question as ' + claresId;
      content.append(element('p', hint + '. References and diagrams, when available, are on the source page. Internet required.'));
    } else {
      content.append(element('p', 'This question is not in the current CLARES bank.'));
    }
    details.append(summary, content);
    return details;
  }

  const study = document.getElementById('study-page');
  study.querySelectorAll('section ol > li').forEach(row => {
    const id = row.querySelector('.question-id')?.textContent.trim();
    const details = panel(id);
    if (details) row.lastElementChild.append(details);
  });
  study.addEventListener('click', event => {
    const passage = event.target.closest('.question, .answer');
    if (!passage || window.getSelection()?.toString()) return;
    const details = passage.closest('ol > li')?.querySelector('.question-explanation');
    if (details) details.open = true;
  });

  window.HamStudyExplanations = {
    addToResults(container, items) {
      container.querySelectorAll('.results-answers > .sim-question').forEach((row, index) => {
        const item = items[index];
        if (!item || item.correct) return;
        const details = panel(item.id, true);
        if (details) row.append(details);
      });
    }
  };
})();

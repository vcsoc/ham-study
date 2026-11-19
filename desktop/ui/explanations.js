(() => {
  'use strict';
  const bankIds = new Set(JSON.parse(document.getElementById('question-data').textContent).map(question => question.id));
  // The personal build injects its sanitized dataset before loading this script.
  const archive = window.HamStudyPrivateExplanations ?? {};
  const localNotes = {
    'B-003-019-008': 'Bond the equipment chassis to the same station ground point. This gives the interconnected equipment a common reference instead of separate ground paths that can form loops. This does not replace protective AC grounding or the requirements of local electrical codes.'
  };

  function element(tag, text) {
    const node = document.createElement(tag);
    node.textContent = text;
    return node;
  }

  function panel(id, open = false) {
    if (!bankIds.has(id)) return null;
    const details = document.createElement('details');
    details.className = 'question-explanation';
    const summary = element('summary', 'Explanation');
    const content = document.createElement('div');
    content.className = 'explanation-content';
    details.append(summary, content);
    function populate() {
      if (!details.open || content.hasChildNodes()) return;
      const entry = archive[id];
      if (entry) {
        const body = document.createElement('div');
        body.className = 'explanation-body';
        body.innerHTML = entry.html;
        content.append(body, element('p', 'Source: CLARES annotated Basic test bank' + (entry.sourceId !== id ? ' (' + entry.sourceId + ')' : '') + '.' + (entry.reviewed ? '' : ' CLARES marks this explanation as not manually reviewed.')));
      } else if (localNotes[id]) {
        content.append(element('p', localNotes[id]), element('p', 'Ham Study note. This question is not in the current CLARES bank.'));
      } else {
        content.append(element('p', 'No offline explanation is installed for this question.'));
      }
    }
    details.addEventListener('toggle', populate);
    details.open = open;
    populate();
    return details;
  }

  const study = document.getElementById('study-page');
  study.querySelectorAll('section ol > li').forEach(row => {
    const details = panel(row.querySelector('.question-id')?.textContent.trim());
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

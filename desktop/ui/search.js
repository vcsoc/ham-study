(() => {
  const input = document.getElementById('question-search');
  const panel = document.getElementById('search-results');
  const rows = Array.from(document.querySelectorAll('#study-page section ol > li')).map(row => ({
    row,
    id: row.querySelector('.question-id').textContent.trim(),
    question: row.querySelector('.question').textContent.trim(),
    section: row.closest('section')
  }));
  function close() { panel.hidden = true; input.setAttribute('aria-expanded', 'false'); }
  function openResult(result) {
    close();
    input.value = result.id;
    document.dispatchEvent(new CustomEvent('ham-select-question', {detail: result.row}));
    const target = '#' + result.section.id;
    if (location.hash !== target) location.hash = target;
    else {
      document.getElementById('study-page').hidden = false;
      document.getElementById('simulator-page').hidden = true;
      document.getElementById('about-page').hidden = true;
    }
    requestAnimationFrame(() => requestAnimationFrame(() => {
      result.row.scrollIntoView({behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block:'center'});
      result.row.setAttribute('tabindex', '-1');
      result.row.focus({preventScroll:true});
    }));
  }
  function render() {
    const query = input.value.trim().toLocaleLowerCase();
    panel.replaceChildren();
    if (!query) { close(); return; }
    const matches = rows.filter(item => item.id.toLocaleLowerCase().includes(query) || item.question.toLocaleLowerCase().includes(query));
    const count = document.createElement('div'); count.className = 'search-count';
    count.textContent = matches.length > 30 ? `${matches.length} matches; showing the first 30` : `${matches.length} ${matches.length === 1 ? 'match' : 'matches'}`;
    panel.append(count);
    matches.slice(0, 30).forEach(item => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'search-result';
      const id = document.createElement('span'); id.className = 'search-result-id'; id.textContent = item.id;
      const text = document.createElement('span'); text.textContent = item.question;
      button.append(id, text); button.addEventListener('click', () => openResult(item)); panel.append(button);
    });
    panel.hidden = false; input.setAttribute('aria-expanded', 'true');
  }
  input.addEventListener('input', render);
  input.addEventListener('focus', () => { if (input.value.trim()) render(); });
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') { close(); input.blur(); }
    else if (event.key === 'Enter') { const first = panel.querySelector('button'); if (first) { event.preventDefault(); first.click(); } }
  });
  document.addEventListener('click', event => { if (!event.target.closest('.question-search')) close(); });
})();

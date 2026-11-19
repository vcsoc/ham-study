(() => {
  'use strict';
  const study = document.getElementById('study-page');
  const nav = document.querySelector('.sidebar nav[aria-label="Categories"]');
  const names = window.HamStudyPrivateGroups ?? {};
  const archive = window.HamStudyPrivateExplanations ?? {};
  const categories = new Map();
  const sections = new Map();
  const rows = [...study.querySelectorAll('section > ol > li')];

  function element(tag, className, text) {
    const node = document.createElement(tag);
    node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function connect(details, id, title, buttonClass, destination, children) {
    const button = element('button', buttonClass);
    button.type = 'button';
    button.setAttribute('aria-controls', details.id);
    button.append(element('span', 'nav-id', id), element('span', '', title));
    function sync() {
      button.setAttribute('aria-expanded', String(details.open));
      if (children) children.hidden = !details.open;
    }
    details.addEventListener('toggle', sync);
    button.addEventListener('click', () => {
      details.open = !details.open;
      sync();
      if (!details.open) return;
      if (location.hash !== '#' + destination.id) location.hash = '#' + destination.id;
      requestAnimationFrame(() => requestAnimationFrame(() => (children ? destination : details).scrollIntoView({block: 'start'})));
    });
    sync();
    return button;
  }

  nav.classList.add('study-nav');
  nav.replaceChildren();
  for (const category of study.querySelectorAll('section[id^="category-"]')) {
    const id = 'B-' + category.id.slice('category-'.length);
    const heading = category.querySelector('h2');
    const label = heading.querySelector('span');
    const title = names.categories?.[id] ?? heading.textContent.slice(label.textContent.length).trim();
    const details = element('details', 'study-category');
    details.id = id;
    details.open = categories.size === 0;
    const summary = element('summary', 'study-heading');
    heading.replaceChildren(label, document.createTextNode(title));
    summary.append(heading);
    details.append(summary);
    category.replaceChildren(details);

    const controls = element('div', 'study-nav-sections');
    const button = connect(details, id, title, 'study-nav-category', category, controls);
    nav.append(button, controls);
    categories.set(id, {category, details, controls});
  }

  for (const row of rows) {
    const questionId = row.querySelector('.question-id').textContent.trim();
    const sourceId = archive[questionId]?.sourceId ?? questionId;
    const id = sourceId.slice(0, 9);
    const {category, details, controls} = categories.get(id.slice(0, 5));
    if (!sections.has(id)) {
      const title = names.sections?.[id] ?? 'Section ' + id.slice(-3);
      const group = element('details', 'study-section');
      group.id = 'section-' + id;
      group.open = sections.size === 0;
      const summary = element('summary', 'study-heading');
      const heading = element('h3', 'study-section-title');
      heading.append(element('span', 'nav-id', id), document.createTextNode(title));
      summary.append(heading);
      const list = element('ol', 'study-questions');
      group.append(summary, list);
      details.append(group);
      controls.append(connect(group, id, title, 'study-nav-section', category));
      sections.set(id, list);
    }
    sections.get(id).append(row);
  }

  for (const {details} of categories.values()) {
    const count = details.querySelectorAll(':scope > .study-section').length;
    details.firstElementChild.append(element('span', 'study-count', `${count} sections`));
  }
  for (const list of sections.values()) {
    const count = list.childElementCount;
    list.previousElementSibling.append(element('span', 'study-count', `${count} questions`));
  }

  window.HamStudyGroups = {
    reveal(row) {
      const section = row.closest('.study-section');
      if (!section) return;
      section.closest('.study-category').open = true;
      section.open = true;
    },
    openCategory(category) {
      const details = category?.querySelector('.study-category');
      if (details) details.open = true;
    }
  };
})();

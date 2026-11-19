(() => {
  'use strict';
  const layout = document.querySelector('.layout');
  const sidebar = layout.querySelector('.sidebar');
  const storageKey = 'ham-study-sidebar-width';
  const min = 180;
  const limit = () => Math.floor(Math.min(720, innerWidth * 0.55, innerWidth - 360));
  const desktop = matchMedia('(min-width:761px)');
  let preference = 232;
  try {
    const saved = Number(localStorage.getItem(storageKey));
    if (saved >= min && saved <= 720) preference = saved;
  } catch (_) { /* Storage is optional. */ }

  const divider = document.createElement('div');
  divider.className = 'sidebar-divider';
  divider.tabIndex = 0;
  divider.setAttribute('role', 'separator');
  divider.setAttribute('aria-orientation', 'vertical');
  divider.setAttribute('aria-label', 'Sidebar width');
  sidebar.id = 'study-sidebar';
  divider.setAttribute('aria-controls', sidebar.id);
  divider.setAttribute('aria-valuemin', String(min));
  sidebar.after(divider);

  function sync() {
    layout.style.setProperty('--sidebar-preference', preference + 'px');
    if (desktop.matches) {
      divider.setAttribute('aria-valuemax', String(limit()));
      divider.setAttribute('aria-valuenow', String(Math.min(limit(), preference)));
    }
  }
  function adjust(width) {
    preference = Math.round(Math.max(min, Math.min(width, limit())));
    sync();
  }
  function save() {
    try { localStorage.setItem(storageKey, String(preference)); } catch (_) { /* Storage is optional. */ }
  }

  let drag;
  divider.addEventListener('pointerdown', event => {
    if (!desktop.matches || !event.isPrimary || event.button !== 0) return;
    drag = { id: event.pointerId, x: event.clientX, width: sidebar.getBoundingClientRect().width, changed: false };
    divider.setPointerCapture(event.pointerId);
    divider.focus({preventScroll: true});
    document.documentElement.classList.add('resizing-sidebar');
    event.preventDefault();
  });
  divider.addEventListener('pointermove', event => {
    if (drag?.id !== event.pointerId || (!drag.changed && event.clientX === drag.x)) return;
    drag.changed = true;
    adjust(drag.width + event.clientX - drag.x);
  });
  divider.addEventListener('lostpointercapture', event => {
    if (drag?.id !== event.pointerId) return;
    if (drag.changed) save();
    drag = null;
    document.documentElement.classList.remove('resizing-sidebar');
  });
  divider.addEventListener('keydown', event => {
    const width = sidebar.getBoundingClientRect().width;
    const destinations = { ArrowLeft: width - 16, ArrowRight: width + 16, Home: min, End: limit() };
    if (!desktop.matches || !Object.hasOwn(destinations, event.key)) return;
    event.preventDefault();
    adjust(destinations[event.key]);
    save();
  });
  window.addEventListener('resize', sync);
  sync();
})();

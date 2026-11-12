(() => {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) return;
  invoke('app_version').then(version => {
    document.querySelectorAll('.app-version').forEach(element => {
      element.textContent = 'v' + version;
    });
  }).catch(() => {});
})();

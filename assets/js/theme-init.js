// Classic (non-module) script that runs synchronously in <head>, before the
// first paint, so the page never flashes the wrong colour scheme.
//
// Keep the storage key and the resolution rules in sync with theme.js
// (tests/theme.test.js runs both and checks that they agree).
(() => {
  const root = document.documentElement;
  root.classList.add('js');

  let stored = null;
  try {
    stored = localStorage.getItem('mskamal3:theme');
  } catch {
    /* storage blocked: fall back to the system preference */
  }

  let prefersLight = false;
  try {
    prefersLight = window.matchMedia('(prefers-color-scheme: light)').matches;
  } catch {
    /* matchMedia unavailable: default to dark */
  }

  root.dataset.theme = stored === 'light' || stored === 'dark' ? stored : prefersLight ? 'light' : 'dark';
})();

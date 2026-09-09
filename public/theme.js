// Run before the stylesheet so the saved theme is applied before the first paint.
(() => {
  const storageKey = 'service-incident-timeline.theme';
  const page = document.documentElement;
  let defaultTheme = page.dataset.defaultTheme === 'dark' ? 'dark' : 'light';
  const valid = value => value === 'light' || value === 'dark';
  let current;

  function apply(theme) {
    current = theme;
    page.dataset.theme = theme;
    const color = document.querySelector('meta[name="theme-color"]');
    if (color) color.content = theme === 'dark' ? '#111b18' : '#f5f7f4';
    document.dispatchEvent(new Event('themechange'));
  }

  let saved;
  try { saved = localStorage.getItem(storageKey); } catch {}
  let preference = valid(saved) ? saved : null;
  // Do not persist the default: visitors without a choice follow branding changes.
  apply(valid(saved) ? saved : defaultTheme);

  window.timelineTheme = Object.freeze({
    get current() { return current; },
    setDefault(theme) {
      if (!valid(theme)) return;
      defaultTheme = theme;
      page.dataset.defaultTheme = theme;
      if (!preference) apply(theme);
    },
    toggle() {
      const next = current === 'dark' ? 'light' : 'dark';
      preference = next;
      try { localStorage.setItem(storageKey, next); } catch {}
      // Storage may be blocked; switching still works for this page.
      apply(next);
    }
  });

  window.addEventListener('storage', event => {
    try {
      if (event.storageArea !== localStorage || (event.key !== storageKey && event.key !== null)) return;
      preference = valid(event.newValue) ? event.newValue : null;
      apply(preference ?? defaultTheme);
    } catch {}
  });
})();

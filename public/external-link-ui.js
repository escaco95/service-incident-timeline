export function createExternalLinkUI({ toast }) {
  const dialog = document.querySelector('#external-link-dialog');
  const address = document.querySelector('#external-link-url');
  let target = null;
  let opener = null;

  function openGate(url, element) {
    target = url;
    opener = element;
    address.textContent = url.href;
    dialog.showModal();
  }

  dialog.addEventListener('close', () => {
    // A queued close event can arrive after this dialog has reopened.
    if (dialog.open) return;
    target = null;
    const element = opener;
    opener = null;
    element?.focus();
  });

  document.querySelector('#external-link-confirm').addEventListener('click', () => {
    const url = target;
    if (!url) return;
    dialog.close();
    // With noopener, both a blocked popup and an opened tab return null.
    try { window.open(url.href, '_blank', 'noopener,noreferrer'); }
    catch { toast('브라우저가 새 창을 차단했습니다. 팝업 허용 후 다시 시도해 주세요.', true); }
  });

  function intercept(event) {
    const anchor = event.target?.closest?.('a[href]');
    if (!anchor) return;
    if (!['http:', 'https:'].includes(anchor.protocol)) {
      // Blob and data URLs saved through the download attribute are not navigation.
      if (!anchor.hasAttribute('download')) event.preventDefault();
      return;
    }
    if (anchor.origin === location.origin) return;
    event.preventDefault();
    openGate(new URL(anchor.href), anchor);
  }

  // Delegation covers links created after startup without per-feature opt-in.
  document.addEventListener('click', intercept, true);
  // Middle clicks fire auxclick instead of click.
  document.addEventListener('auxclick', event => { if (event.button === 1) intercept(event); }, true);
}

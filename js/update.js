/* Tartarus Simulator: a page left open tells the player when a newer
 * version is out, so the latest fixes reach them without knowing to
 * hard-refresh (most of one day's boards came from the day before's page).
 * A minute after loading, then every 5 minutes and whenever the tab comes
 * back into view, it fetches its own page fresh and compares the asset tag
 * (?v=) with the one it loaded. A newer one shows a bar with Reload. Boards
 * and runs are saved in the browser, so reloading keeps them. */
(function () {
  'use strict';

  const src = document.currentScript ? document.currentScript.src : '';
  const tag = (/[?&]v=([\w.-]+)/.exec(src) || [])[1];
  if (!tag || location.protocol === 'file:' || typeof fetch !== 'function') return;

  let shown = false;
  let snoozed = 0;

  async function check() {
    if (shown || document.hidden || Date.now() < snoozed) return;
    try {
      const res = await fetch(`${location.pathname}?update=${Date.now()}`, { cache: 'no-store' });
      if (!res.ok) return;
      const html = await res.text();
      const latest = (/js\/[\w-]+\.js\?v=([\w.-]+)/.exec(html) || [])[1];
      if (latest && latest !== tag) show();
    } catch (e) {
      // Offline or blocked: try again later.
    }
  }

  function show() {
    shown = true;
    const bar = document.createElement('div');
    bar.className = 'update-bar';
    bar.setAttribute('role', 'status');
    bar.innerHTML = '<span>本頁面有新版本了，包含最新修正。你的盤面已經存好。</span>'
      + '<span class="update-actions"><button type="button" class="btn btn-primary" data-update="reload">重新載入</button>'
      + '<button type="button" class="btn" data-update="later">稍後</button></span>';
    bar.addEventListener('click', (e) => {
      const b = e.target.closest('[data-update]');
      if (!b) return;
      if (b.dataset.update === 'reload') location.reload();
      else {
        bar.remove();
        shown = false;
        snoozed = Date.now() + 30 * 60 * 1000;
      }
    });
    document.body.appendChild(bar);
  }

  setTimeout(check, 60 * 1000);
  setInterval(check, 5 * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) check();
  });
})();

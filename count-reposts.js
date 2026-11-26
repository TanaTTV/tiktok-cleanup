/*!
 * TikTok Repost Counter — prints how many reposts your account has.
 * Paste into the browser console on tiktok.com. Read-only: it changes nothing.
 * https://github.com/TanaTTV/tiktok-repost-remover · MIT License
 */
(async () => {
  const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
  const ctx = el && JSON.parse(el.textContent).__DEFAULT_SCOPE__['webapp.app-context'];
  if (!ctx || !ctx.user) return console.warn('Log in to tiktok.com, refresh, and try again.');

  let cursor = '0';
  let total = 0;
  for (let page = 0; page < 1000; page++) {
    const params = new URLSearchParams({ aid: '1988', count: '30', cursor, secUid: ctx.user.secUid });
    const res = await (await fetch(`/api/repost/item_list/?${params}`, { credentials: 'same-origin' })).json();
    total += (res.itemList || []).length;
    if (!res.hasMore || !res.cursor) break;
    cursor = String(res.cursor);
  }
  console.log(`%cYou have ${total} reposts`, 'font: 600 18px system-ui; color: #8b7bff');
})();

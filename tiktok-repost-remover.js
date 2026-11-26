/*!
 * TikTok Repost Remover
 * Remove every TikTok repost on your account — automatically, from your own browser.
 * https://github.com/TanaTTV/tiktok-repost-remover · MIT License
 *
 * USAGE
 *  1. Log in at https://www.tiktok.com on a computer (Chrome, Edge, Brave or Safari).
 *  2. Open the browser console:
 *       Chrome / Edge / Brave : Cmd+Option+J  (Windows: Ctrl+Shift+J)
 *       Safari                : Cmd+Option+C  (enable Settings → Advanced → "Show features for web developers")
 *  3. Paste this entire file and press Enter.
 *  4. Use the panel in the top-right corner:
 *       Test 5      removes 5 reposts so you can confirm it works
 *       Remove all  removes every repost, then re-checks until none are left
 *
 * Only reposts are removed. Your own videos, likes and favorites are never touched.
 */
(async () => {
  if (window.__repostRemover) { console.log('[RepostRemover] Already running — use the panel.'); return; }
  window.__repostRemover = true;

  const CFG = {
    minDelayMs: 1500,        // shortest pause between removals
    maxDelayMs: 4000,        // longest pause between removals
    listPauseMs: 400,        // pause between list pages while counting
    maxPasses: 4,            // list → remove → re-check, up to this many times
    maxRetriesPerItem: 3,    // give up on a single video after this many tries
    maxBackoffMs: 30 * 60e3, // longest wait when TikTok is rate-limiting (30 min)
    testCount: 5,
  };

  // ---------- small helpers ----------
  const log = (...a) => console.log('[RepostRemover]', ...a);
  const fmtTime = (ms) => {
    if (ms < 60000) return `${Math.max(1, Math.round(ms / 1000))} sec`;
    const m = Math.round(ms / 60000);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
  };

  // Timers in a Web Worker aren't slowed down when the tab is in the background.
  // If the site blocks workers, fall back to normal timers.
  // TikTok's security settings may block this (a "worker-src" message in the console);
  // that's harmless — we test the worker first and only use it if it really answers.
  const timeoutSleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let workerSleep = null;
  (async () => {
    try {
      const src = 'onmessage=e=>setTimeout(()=>postMessage(e.data.id),e.data.ms)';
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      const waiting = new Map(); let n = 0; let broken = false;
      w.onerror = () => { broken = true; workerSleep = null; waiting.forEach((r) => r()); waiting.clear(); };
      w.onmessage = (e) => { const r = waiting.get(e.data); waiting.delete(e.data); r && r(); };
      const candidate = (ms) => new Promise((r) => { const id = ++n; waiting.set(id, r); w.postMessage({ id, ms }); });
      const answered = await Promise.race([candidate(5).then(() => !broken), timeoutSleep(1500).then(() => false)]);
      if (answered && !broken) workerSleep = candidate; else { try { w.terminate(); } catch {} }
    } catch {}
    log(workerSleep ? 'Background timers: on' : 'Background timers blocked by TikTok — using normal timers (fine, just keep the tab in front).');
  })();
  // Always add a safety timeout so a stuck worker can never freeze the script.
  const rawSleep = (ms) => (workerSleep
    ? Promise.race([workerSleep(ms), timeoutSleep(ms + 2000)])
    : timeoutSleep(ms));

  // ---------- state ----------
  const S = { running: false, paused: false, stopped: false, removed: 0, failed: 0, total: 0, startedAt: 0 };

  // Sleep that respects Pause and Stop.
  async function sleep(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (S.stopped) throw new Error('STOPPED');
      await rawSleep(Math.min(500, end - Date.now()));
    }
    while (S.paused && !S.stopped) await rawSleep(300);
    if (S.stopped) throw new Error('STOPPED');
  }
  const jitter = () => CFG.minDelayMs + Math.random() * (CFG.maxDelayMs - CFG.minDelayMs);

  // ---------- read your account info from the page ----------
  function getContext() {
    try {
      let data = window.__$UNIVERSAL_DATA$__;
      if (!data || !data.__DEFAULT_SCOPE__) {
        const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
        if (el) data = JSON.parse(el.textContent);
      }
      const ctx = data && data.__DEFAULT_SCOPE__ && data.__DEFAULT_SCOPE__['webapp.app-context'];
      if (!ctx || !ctx.user || !ctx.user.secUid) return null;
      return { secUid: ctx.user.secUid, username: ctx.user.uniqueId || '', csrf: ctx.csrfToken || '' };
    } catch { return null; }
  }
  const cookie = (n) => (document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)')) || [])[1] || '';

  // ---------- TikTok requests ----------
  class TikTokError extends Error {
    constructor(kind, detail) { super(kind); this.kind = kind; this.detail = detail; }
  }
  async function callTikTok(url, opts) {
    let res;
    try { res = await fetch(url, { credentials: 'same-origin', ...opts }); }
    catch (e) { throw new TikTokError('NETWORK', String(e)); }
    const raw = await res.text().catch(() => '');
    if (res.status === 429) throw new TikTokError('RATE_LIMITED', raw.slice(0, 200));
    if (res.status === 401 || res.status === 403) throw new TikTokError('LOGGED_OUT', raw.slice(0, 200));
    if (!res.ok) throw new TikTokError(res.status >= 500 ? 'SERVER' : 'HTTP', `HTTP ${res.status}`);
    if (!raw.trim()) return {};
    let json;
    try { json = JSON.parse(raw); } catch { throw new TikTokError('BAD_RESPONSE', raw.slice(0, 200)); }
    if (json.status_code && json.status_code !== 0) {
      const msg = String(json.status_msg || '').toLowerCase();
      if (json.status_code === 8 || msg.includes('login')) throw new TikTokError('LOGGED_OUT', JSON.stringify(json));
      if (msg.includes('frequent') || msg.includes('too many') || msg.includes('limit')) throw new TikTokError('RATE_LIMITED', JSON.stringify(json));
      throw new TikTokError('REJECTED', JSON.stringify(json));
    }
    return json;
  }

  async function listPage(ctx, cursor) {
    const p = new URLSearchParams({
      aid: '1988', count: '30', coverFormat: '2', cursor: String(cursor),
      needPinnedItemIds: 'true', post_item_list_request_type: '0', secUid: ctx.secUid,
    });
    const json = await callTikTok(`https://www.tiktok.com/api/repost/item_list/?${p}`, { headers: { accept: '*/*' } });
    return {
      ids: (json.itemList || []).map((it) => String(it.id)).filter(Boolean),
      hasMore: !!json.hasMore,
      cursor: json.cursor != null ? String(json.cursor) : null,
    };
  }

  async function removeOne(ctx, id) {
    const headers = { accept: '*/*', 'content-type': 'application/x-www-form-urlencoded' };
    const csrf = ctx.csrf || cookie('tt_csrf_token');
    if (csrf) headers['tt-csrf-token'] = csrf;
    const p = new URLSearchParams({ aid: '1988', item_id: id });
    await callTikTok(`https://www.tiktok.com/tiktok/v1/upvote/delete?${p}`, { method: 'POST', headers, body: '' });
  }

  // Runs fn; on rate limits / server errors waits longer and longer, then retries.
  let backoff = 0;
  async function withRetry(fn, label, maxTries) {
    for (let attempt = 1; ; attempt++) {
      try { const r = await fn(); backoff = 0; return r; }
      catch (e) {
        if (!(e instanceof TikTokError)) throw e;
        if (e.kind === 'LOGGED_OUT') throw e;
        const retryable = ['RATE_LIMITED', 'NETWORK', 'SERVER', 'BAD_RESPONSE'].includes(e.kind);
        log(`${label} failed (${e.kind}, try ${attempt})`, e.detail || '');
        if (!retryable || attempt >= maxTries) throw e;
        backoff = Math.min(backoff ? backoff * 2 : (e.kind === 'RATE_LIMITED' ? 60e3 : 10e3), CFG.maxBackoffMs);
        ui.status(`TikTok is slowing us down — waiting ${fmtTime(backoff)}, then continuing…`, 'warn');
        await sleep(backoff);
      }
    }
  }

  async function listAll(ctx) {
    const ids = []; const seen = new Set(); const seenCursors = new Set();
    let cursor = '0';
    for (let page = 1; page <= 1000; page++) {
      ui.status(`Counting your reposts… ${ids.length} so far`);
      const r = await withRetry(() => listPage(ctx, cursor), 'Listing', 8);
      r.ids.forEach((id) => { if (!seen.has(id)) { seen.add(id); ids.push(id); } });
      if (!r.hasMore || !r.cursor || seenCursors.has(r.cursor)) break;
      seenCursors.add(r.cursor); cursor = r.cursor;
      await sleep(CFG.listPauseMs);
    }
    return ids;
  }

  // ---------- screen wake lock ----------
  let wakeLock = null;
  async function keepAwake() {
    try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch {}
  }
  document.addEventListener('visibilitychange', () => { if (S.running && document.visibilityState === 'visible') keepAwake(); });

  // ---------- main run ----------
  async function run(limit) {
    if (S.running) return;
    const ctx = getContext();
    if (!ctx) { ui.status('Couldn\'t find your account. Make sure you\'re logged in, refresh tiktok.com, and paste the script again.', 'err'); return; }
    Object.assign(S, { running: true, paused: false, stopped: false, removed: 0, failed: 0, total: 0, startedAt: Date.now() });
    ui.mode('running'); keepAwake();
    const gaveUp = new Set();
    try {
      for (let pass = 1; pass <= CFG.maxPasses; pass++) {
        const ids = (await listAll(ctx)).filter((id) => !gaveUp.has(id));
        if (pass === 1) S.total = ids.length;
        if (!ids.length) break;
        log(`Pass ${pass}: ${ids.length} reposts to remove`);
        const batch = limit ? ids.slice(0, limit - S.removed) : ids;
        for (const id of batch) {
          try {
            await withRetry(() => removeOne(ctx, id), `Removing ${id}`, CFG.maxRetriesPerItem + 6);
            S.removed++;
          } catch (e) {
            if (e.kind === 'LOGGED_OUT' || e.message === 'STOPPED') throw e;
            S.failed++; gaveUp.add(id); log('Skipping', id, e.kind, e.detail || '');
          }
          ui.progress(pass);
          if (limit && S.removed >= limit) break;
          await sleep(jitter());
        }
        if (limit) break;
        ui.status('Double-checking for any reposts that were missed…');
        await sleep(3000);
      }
      if (limit) ui.status(`Test done: removed ${S.removed}. Refresh your Reposts tab to check they're gone, then press "Remove all".`, 'ok');
      else if (!S.removed && !S.failed) ui.status('No reposts found — your Reposts tab is already empty. ✅', 'ok');
      else ui.status(`All done! Removed ${S.removed} reposts${S.failed ? `, ${S.failed} couldn't be removed (see console)` : ''} 🎉`, 'ok');
    } catch (e) {
      if (e.message === 'STOPPED') ui.status(`Stopped. Removed ${S.removed}. Press "Remove all" to continue.`);
      else if (e.kind === 'LOGGED_OUT') ui.status(`TikTok logged you out or refused access. Removed ${S.removed}. Log in again, refresh, and re-run.`, 'err');
      else { ui.status(`Stopped because of an error (${e.kind || e.message}). Removed ${S.removed}. Copy the red console messages and send them over.`, 'err'); console.error(e); }
    } finally {
      S.running = false; S.paused = false; ui.mode('idle');
      if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    }
  }

  // ---------- panel ----------
  const ui = (() => {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;width:300px;background:#141418;color:#f4f4f6;' +
      'font:13px/1.45 system-ui,-apple-system,sans-serif;padding:14px;border-radius:12px;box-shadow:0 8px 30px #000a;border:1px solid #2a2a33';
    const btn = (id, label, bg) => `<button data-a="${id}" style="flex:1;background:${bg};color:#fff;border:0;border-radius:7px;padding:7px 0;font:600 12px system-ui;cursor:pointer">${label}</button>`;
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
        <b style="font-size:14px">Repost Remover</b>
        <span data-a="close" style="cursor:pointer;opacity:.6;font-size:18px;line-height:1">×</span>
      </div>
      <div data-r="status" style="margin-bottom:8px">Ready. Start with <b>Test 5</b> to make sure it works.</div>
      <div data-r="bar" style="height:6px;background:#26262e;border-radius:3px;overflow:hidden;margin-bottom:6px;display:none"><div data-r="fill" style="height:100%;width:0;background:linear-gradient(90deg,#7c6cff,#b4a8ff);transition:width .3s"></div></div>
      <div data-r="stats" style="font-size:12px;opacity:.75;margin-bottom:10px;min-height:1em"></div>
      <div data-r="idle" style="display:flex;gap:6px">${btn('test', 'Test 5', '#2b2b33')}${btn('all', 'Remove all', '#7c6cff')}</div>
      <div data-r="busy" style="display:none;gap:6px">${btn('pause', 'Pause', '#2b2b33')}${btn('stop', 'Stop', '#3a3a44')}</div>
      <div style="font-size:11px;opacity:.5;margin-top:8px">Keep this tab open and your computer awake.</div>`;
    document.body.appendChild(el);
    const $ = (r) => el.querySelector(`[data-r="${r}"]`);
    const colors = { ok: '#5be37d', warn: '#ffcc4d', err: '#ff6b81' };
    el.addEventListener('click', (e) => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'test') run(CFG.testCount);
      if (a === 'all') run(0);
      if (a === 'pause') { S.paused = !S.paused; e.target.textContent = S.paused ? 'Resume' : 'Pause'; if (S.paused) api.status('Paused. Press Resume to continue.'); }
      if (a === 'stop') { S.stopped = true; S.paused = false; api.status('Stopping…'); }
      if (a === 'close') { if (S.running && !confirm('Still running. Stop and close?')) return; S.stopped = true; el.remove(); window.__repostRemover = false; }
    });
    const api = {
      status(t, kind) { $('status').textContent = t; $('status').style.color = colors[kind] || '#fff'; log(t); },
      mode(m) {
        $('idle').style.display = m === 'idle' ? 'flex' : 'none';
        $('busy').style.display = m === 'running' ? 'flex' : 'none';
        el.querySelector('[data-a="pause"]').textContent = 'Pause';
      },
      progress(pass) {
        const total = Math.max(S.total, S.removed + S.failed);
        const done = S.removed + S.failed;
        const elapsed = Date.now() - S.startedAt;
        const perMin = elapsed > 30e3 ? (S.removed / (elapsed / 60000)) : 0;
        const left = perMin ? fmtTime(((total - done) / perMin) * 60000) : '…';
        $('bar').style.display = 'block';
        $('fill').style.width = `${total ? Math.min(100, (done / total) * 100) : 0}%`;
        api.status(`Removing${pass > 1 ? ' leftovers' : ''}… ${S.removed} of ${total}`);
        $('stats').textContent = `${perMin ? perMin.toFixed(0) + '/min · ~' + left + ' left · ' : ''}running ${fmtTime(elapsed)}${S.failed ? ` · ${S.failed} skipped` : ''}`;
      },
    };
    return api;
  })();

  if (!/(^|\.)tiktok\.com$/.test(location.hostname)) { ui.status('Open tiktok.com first, then paste the script there.', 'err'); window.__repostRemover = false; return; }
  const ctx = getContext();
  if (!ctx) ui.status('Couldn\'t find your account on this page. Make sure you\'re logged in, refresh tiktok.com, and paste again.', 'err');
  else log(`Ready for @${ctx.username}`);
})();

/*!
 * TikTok Cleanup
 * Clear your TikTok reposts, likes, favorites and following — automatically, from your own browser.
 * https://github.com/TanaTTV/tiktok-cleanup · MIT License
 *
 * USAGE
 *  1. Log in at https://www.tiktok.com on a computer (Chrome, Edge, Brave or Safari).
 *  2. Open the browser console:
 *       Chrome / Edge / Brave : Cmd+Option+J  (Windows: Ctrl+Shift+J)
 *       Safari                : Cmd+Option+C  (enable Settings → Advanced → "Show features for web developers")
 *  3. Paste this entire file and press Enter.
 *  4. In the panel (top-right), pick what to clean, press "Test" first, then "Remove all".
 *
 * Before removing everything, a backup list (CSV) is downloaded so you know what was removed.
 */
(async () => {
  if (window.__tiktokCleanup) { console.log('[TikTokCleanup] Already running — use the panel.'); return; }
  window.__tiktokCleanup = true;

  const CFG = {
    minDelayMs: 1500,        // shortest pause between removals
    maxDelayMs: 4000,        // longest pause between removals
    followDelayFactor: 1.6,  // unfollowing is rate-limited harder, so go a bit slower
    listPauseMs: 400,        // pause between list pages while counting
    maxPasses: 50,           // keep re-checking while each pass still removes something
    maxRetriesPerItem: 3,    // give up on a single item after this many failed tries
    maxBackoffMs: 30 * 60e3, // longest wait when TikTok is rate-limiting (30 min)
  };

  // ---------- helpers ----------
  const log = (...a) => console.log('[TikTokCleanup]', ...a);
  const fmtTime = (ms) => {
    if (ms < 60000) return `${Math.max(1, Math.round(ms / 1000))} sec`;
    const m = Math.round(ms / 60000);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
  };
  const fmtNum = (n) => Number(n).toLocaleString('en-US');
  const cookie = (n) => (document.cookie.match(new RegExp('(?:^|; )' + n + '=([^;]*)')) || [])[1] || '';
  const timeoutSleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Background-tab-friendly timers via a Worker. TikTok's security policy usually blocks this
  // (a "worker-src" console message); we test it first and fall back to normal timers.
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
    log(workerSleep ? 'Background timers: on' : 'Background timers blocked by TikTok — using normal timers (fine, keep the tab in front).');
  })();
  const rawSleep = (ms) => (workerSleep ? Promise.race([workerSleep(ms), timeoutSleep(ms + 2000)]) : timeoutSleep(ms));

  // ---------- state ----------
  const S = { running: false, paused: false, stopped: false, removed: 0, failed: 0, total: 0, startedAt: 0, kind: 'reposts' };

  async function sleep(ms) {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (S.stopped) throw new Error('STOPPED');
      await rawSleep(Math.min(500, end - Date.now()));
    }
    while (S.paused && !S.stopped) await rawSleep(300);
    if (S.stopped) throw new Error('STOPPED');
  }

  // ---------- account info from the page ----------
  function getContext() {
    try {
      let data = window.__$UNIVERSAL_DATA$__;
      if (!data || !data.__DEFAULT_SCOPE__) {
        const el = document.getElementById('__UNIVERSAL_DATA_FOR_REHYDRATION__');
        if (el) data = JSON.parse(el.textContent);
      }
      const c = data && data.__DEFAULT_SCOPE__ && data.__DEFAULT_SCOPE__['webapp.app-context'];
      if (!c || !c.user || !c.user.secUid) return null;
      return {
        secUid: c.user.secUid, username: c.user.uniqueId || '', csrf: c.csrfToken || '',
        deviceId: c.wid || '', odinId: c.odinId || '', region: c.region || '', language: c.language || 'en',
      };
    } catch { return null; }
  }

  // The like and follow endpoints expect the same query fields TikTok's web app sends.
  function webParams(ctx, extra) {
    const p = new URLSearchParams({
      aid: '1988', app_language: ctx.language, app_name: 'tiktok_web',
      browser_language: navigator.language || ctx.language, browser_name: 'Mozilla', browser_online: 'true',
      browser_platform: navigator.platform || '', browser_version: navigator.userAgent, channel: 'tiktok_web',
      cookie_enabled: 'true', device_platform: 'web_pc', focus_state: 'true', history_len: '2',
      is_fullscreen: 'false', is_page_visible: 'true', odinId: ctx.odinId, os: /Mac/i.test(navigator.platform) ? 'mac' : 'windows',
      priority_region: ctx.region, referer: '', region: ctx.region,
      screen_height: String(screen.height || 900), screen_width: String(screen.width || 1440),
      tz_name: Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC', user_is_login: 'true', webcast_language: ctx.language,
      ...extra,
    });
    if (ctx.deviceId) p.set('device_id', ctx.deviceId);
    const fp = cookie('s_v_web_id'); if (fp) p.set('verifyFp', fp);
    const ms = cookie('msToken'); if (ms) p.set('msToken', ms);
    return p;
  }

  // ---------- TikTok requests ----------
  class TikTokError extends Error { constructor(kind, detail) { super(kind); this.kind = kind; this.detail = detail; } }

  async function callTikTok(url, opts = {}) {
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

  const POST_HEADERS = (ctx) => {
    const h = { accept: '*/*', 'content-type': 'application/x-www-form-urlencoded' };
    const csrf = ctx.csrf || cookie('tt_csrf_token');
    if (csrf) h['tt-csrf-token'] = csrf;
    return h;
  };
  const post = (ctx, path, params) => callTikTok(`https://www.tiktok.com${path}?${params}`, { method: 'POST', headers: POST_HEADERS(ctx), body: '' });

  const videoList = (path, pinned) => async (ctx, cursor) => {
    const p = new URLSearchParams({
      aid: '1988', count: '30', coverFormat: '2', cursor: String(cursor),
      needPinnedItemIds: pinned, post_item_list_request_type: '0', secUid: ctx.secUid,
    });
    const json = await callTikTok(`https://www.tiktok.com${path}?${p}`, { headers: { accept: '*/*' } });
    return {
      items: (json.itemList || []).filter((it) => it && it.id).map((it) => ({
        id: String(it.id), user: (it.author && it.author.uniqueId) || '', text: it.desc || '',
        url: `https://www.tiktok.com/@${(it.author && it.author.uniqueId) || '_'}/video/${it.id}`,
      })),
      hasMore: !!json.hasMore,
      cursor: json.cursor != null ? String(json.cursor) : null,
    };
  };

  // ---------- what can be cleaned ----------
  const KINDS = {
    reposts: {
      label: 'Reposts', verb: 'Removing', noun: 'reposts', testCount: 5,
      list: videoList('/api/repost/item_list/', 'true'),
      remove: (ctx, it) => post(ctx, '/tiktok/v1/upvote/delete', new URLSearchParams({ aid: '1988', item_id: it.id })),
    },
    likes: {
      label: 'Likes', verb: 'Unliking', noun: 'likes', testCount: 5,
      list: videoList('/api/favorite/item_list/', 'true'),
      async remove(ctx, it) {
        const json = await post(ctx, '/api/commit/item/digg/', webParams(ctx, { aweme_id: it.id, type: '0', from_page: 'video' }));
        if (json.is_digg === 1) throw new TikTokError('REJECTED', 'TikTok says the video is still liked');
      },
    },
    favorites: {
      label: 'Favorites', verb: 'Unfavoriting', noun: 'favorites', testCount: 5,
      list: videoList('/api/user/collect/item_list/', 'false'),
      remove: (ctx, it) => post(ctx, '/api/item/collect/', new URLSearchParams({ aid: '1988', action: '2', itemId: it.id, secUid: ctx.secUid })),
    },
    following: {
      label: 'Following', verb: 'Unfollowing', noun: 'accounts', testCount: 3, keepable: true, slower: true,
      async list(ctx, cursor) {
        const p = new URLSearchParams({ aid: '1988', count: '30', maxCursor: '0', minCursor: String(cursor), scene: '21', secUid: ctx.secUid });
        const json = await callTikTok(`https://www.tiktok.com/api/user/list/?${p}`, { headers: { accept: '*/*' } });
        return {
          items: (json.userList || []).map((e) => e && e.user).filter((u) => u && u.id).map((u) => ({
            id: String(u.id), secUid: u.secUid || '', user: u.uniqueId || '', text: u.nickname || '',
            url: `https://www.tiktok.com/@${u.uniqueId || ''}`,
          })),
          hasMore: !!json.hasMore,
          cursor: json.minCursor != null ? String(json.minCursor) : null,
        };
      },
      async remove(ctx, it) {
        const json = await post(ctx, '/api/commit/follow/user/', webParams(ctx, {
          user_id: it.id, sec_user_id: it.secUid, type: '0', action_type: '0',
          from: '18', from_pre: '0', channel_id: '0', fromWeb: '1', from_page: 'user',
        }));
        // Safety check: if TikTok says we still follow them, stop instead of guessing.
        if (json.follow_status != null && json.follow_status !== 0) throw new TikTokError('NOT_APPLIED', 'TikTok says you still follow this account');
      },
    },
  };

  // ---------- retry / backoff ----------
  let backoff = 0;
  async function withRetry(fn, label, maxTries) {
    for (let attempt = 1; ; attempt++) {
      try { const r = await fn(); backoff = 0; return r; }
      catch (e) {
        if (!(e instanceof TikTokError)) throw e;
        if (e.kind === 'LOGGED_OUT' || e.kind === 'NOT_APPLIED') throw e;
        const retryable = ['RATE_LIMITED', 'NETWORK', 'SERVER', 'BAD_RESPONSE'].includes(e.kind);
        log(`${label} failed (${e.kind}, try ${attempt})`, e.detail || '');
        if (!retryable || attempt >= maxTries) throw e;
        backoff = Math.min(backoff ? backoff * 2 : (e.kind === 'RATE_LIMITED' ? 60e3 : 10e3), CFG.maxBackoffMs);
        ui.status(`TikTok is slowing us down — waiting ${fmtTime(backoff)}, then continuing…`, 'warn');
        await sleep(backoff);
      }
    }
  }

  async function listAll(ctx, kind, { limit } = {}) {
    const items = []; const seen = new Set(); const seenCursors = new Set();
    let cursor = '0';
    for (let page = 1; page <= 2000; page++) {
      ui.status(`Counting your ${KINDS[kind].noun}… ${fmtNum(items.length)} so far`);
      const r = await withRetry(() => KINDS[kind].list(ctx, cursor), 'Listing', 8);
      r.items.forEach((it) => { if (!seen.has(it.id)) { seen.add(it.id); items.push(it); } });
      if (limit && items.length >= limit) break;
      if (!r.hasMore || !r.cursor || seenCursors.has(r.cursor)) break;
      seenCursors.add(r.cursor); cursor = r.cursor;
      await sleep(CFG.listPauseMs);
    }
    return items;
  }

  // ---------- backup (CSV download) ----------
  function downloadBackup(kind, items) {
    const esc = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
    const rows = [['type', 'id', 'username', 'url', kind === 'following' ? 'name' : 'caption'], ...items.map((it) => [kind, it.id, it.user, it.url, it.text])];
    const csv = '﻿' + rows.map((r) => r.map(esc).join(',')).join('\n');
    const name = `tiktok-${kind}-backup-${new Date().toISOString().slice(0, 10)}.csv`;
    try {
      const a = document.createElement('a');
      let url;
      try { url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' })); }
      catch { url = 'data:text/csv;charset=utf-8,' + encodeURIComponent(csv); }
      a.href = url; a.download = name; a.style.display = 'none';
      document.body.appendChild(a); a.click(); a.remove();
      log(`Backup saved: ${name} (${items.length} rows)`);
      return name;
    } catch (e) { log('Backup download failed', e); return null; }
  }

  // ---------- screen wake lock ----------
  let wakeLock = null;
  async function keepAwake() {
    try { if ('wakeLock' in navigator && !wakeLock) { wakeLock = await navigator.wakeLock.request('screen'); wakeLock.addEventListener('release', () => { wakeLock = null; }); } } catch {}
  }
  document.addEventListener('visibilitychange', () => { if (S.running && document.visibilityState === 'visible') keepAwake(); });

  // ---------- main run ----------
  async function run(kind, test) {
    if (S.running) return;
    const K = KINDS[kind];
    const ctx = getContext();
    if (!ctx) { ui.status('Couldn\'t find your account. Make sure you\'re logged in, refresh tiktok.com, and paste the script again.', 'err'); return; }
    const keep = new Set(K.keepable ? ui.keepList() : []);
    const isKept = (it) => keep.has(String(it.user).toLowerCase());
    Object.assign(S, { running: true, paused: false, stopped: false, removed: 0, failed: 0, total: 0, startedAt: Date.now(), kind });
    ui.mode('running'); keepAwake();
    const gaveUp = new Set();
    const delay = () => (CFG.minDelayMs + Math.random() * (CFG.maxDelayMs - CFG.minDelayMs)) * (K.slower ? CFG.followDelayFactor : 1);
    try {
      for (let pass = 1; pass <= CFG.maxPasses; pass++) {
        const all = await listAll(ctx, kind, test ? { limit: K.testCount + keep.size + 30 } : {});
        const todo = all.filter((it) => !gaveUp.has(it.id) && !isKept(it));
        if (pass === 1) {
          S.total = test ? Math.min(K.testCount, todo.length) : todo.length;
          if (!todo.length) break;
          if (!test) {
            const kept = all.length - todo.length;
            const ok = confirm(`${K.verb} ${fmtNum(todo.length)} ${K.noun}${kept ? ` (keeping ${kept})` : ''}.\n\nA backup list (CSV) will download first. This can't be undone in bulk. Continue?`);
            if (!ok) { S.total = 0; throw new Error('STOPPED'); }
            const file = downloadBackup(kind, all);
            if (file) ui.note(`Backup saved: ${file}`);
          }
        }
        if (!todo.length) break;
        log(`Pass ${pass}: ${todo.length} ${K.noun} to process`);
        let removedThisPass = 0;
        for (const it of todo) {
          try {
            await withRetry(() => K.remove(ctx, it), `${K.verb} ${it.user || it.id}`, CFG.maxRetriesPerItem + 6);
            S.removed++; removedThisPass++;
          } catch (e) {
            if (e.kind === 'LOGGED_OUT' || e.kind === 'NOT_APPLIED' || e.message === 'STOPPED') throw e;
            S.failed++; gaveUp.add(it.id); log('Skipping', it.user || it.id, e.kind, e.detail || '');
          }
          ui.progress(pass);
          if (test && S.removed >= K.testCount) break;
          await sleep(delay());
        }
        if (test || !removedThisPass) break;
        ui.status('Double-checking for anything that was missed…');
        await sleep(3000);
      }
      if (!S.removed && !S.failed) ui.status(`No ${K.noun} found — nothing to clean. ✅`, 'ok');
      else if (test) ui.status(`Test done: ${K.verb.toLowerCase().replace(/ing$/, 'ed')} ${S.removed}. Check your ${K.label} tab, then press "Remove all".`, 'ok');
      else ui.status(`All done! ${fmtNum(S.removed)} ${K.noun} cleared${S.failed ? `, ${S.failed} couldn't be removed (see console)` : ''} 🎉`, 'ok');
    } catch (e) {
      if (e.message === 'STOPPED') ui.status(S.total ? `Stopped. Cleared ${S.removed}. Press "Remove all" to continue.` : 'Cancelled — nothing was removed.');
      else if (e.kind === 'LOGGED_OUT') ui.status(`TikTok logged you out or refused access. Cleared ${S.removed}. Log in again, refresh, and re-run.`, 'err');
      else if (e.kind === 'NOT_APPLIED') ui.status(`Stopped for safety: TikTok didn't apply the change. Cleared ${S.removed}. Please open an issue on GitHub.`, 'err');
      else { ui.status(`Stopped because of an error (${e.kind || e.message}). Cleared ${S.removed}. Copy the red console messages into a GitHub issue.`, 'err'); console.error(e); }
    } finally {
      S.running = false; S.paused = false; ui.mode('idle');
      if (wakeLock) { wakeLock.release().catch(() => {}); wakeLock = null; }
    }
  }

  // ---------- panel ----------
  const ui = (() => {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;top:16px;right:16px;z-index:2147483647;width:320px;background:#141418;color:#f4f4f6;' +
      'font:13px/1.45 system-ui,-apple-system,sans-serif;padding:14px;border-radius:12px;box-shadow:0 8px 30px #000a;border:1px solid #2a2a33';
    const btn = (id, label, bg) => `<button data-a="${id}" style="flex:1;background:${bg};color:#fff;border:0;border-radius:7px;padding:7px 0;font:600 12px system-ui;cursor:pointer">${label}</button>`;
    const tab = (k) => `<button data-k="${k}" style="flex:1;border:0;border-radius:6px;padding:5px 0;font:600 11.5px system-ui;cursor:pointer;background:transparent;color:#9a9aa8">${KINDS[k].label}</button>`;
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <b style="font-size:14px">TikTok Cleanup</b>
        <span data-a="close" style="cursor:pointer;opacity:.6;font-size:18px;line-height:1">×</span>
      </div>
      <div data-r="tabs" style="display:flex;gap:2px;background:#1d1d23;border-radius:8px;padding:3px;margin-bottom:10px">${Object.keys(KINDS).map(tab).join('')}</div>
      <div data-r="keep" style="display:none;margin-bottom:10px">
        <div style="font-size:11px;opacity:.6;margin:0 0 4px 2px">Keep following (optional)</div>
        <input data-r="keepInput" placeholder="@friend, @bestie" style="width:100%;box-sizing:border-box;background:#1d1d23;border:1px solid #2a2a33;border-radius:7px;color:#f4f4f6;padding:7px 9px;font:12px system-ui;outline:none">
      </div>
      <div data-r="status" style="margin-bottom:8px">Pick what to clean. Start with <b>Test</b> to make sure it works.</div>
      <div data-r="bar" style="height:6px;background:#26262e;border-radius:3px;overflow:hidden;margin-bottom:6px;display:none"><div data-r="fill" style="height:100%;width:0;background:linear-gradient(90deg,#7c6cff,#b4a8ff);transition:width .3s"></div></div>
      <div data-r="stats" style="font-size:12px;opacity:.75;margin-bottom:10px;min-height:1em"></div>
      <div data-r="idle" style="display:flex;gap:6px">${btn('test', 'Test', '#2b2b33')}${btn('all', 'Remove all', '#7c6cff')}</div>
      <div data-r="busy" style="display:none;gap:6px">${btn('pause', 'Pause', '#2b2b33')}${btn('stop', 'Stop', '#3a3a44')}</div>
      <div data-r="note" style="font-size:11px;opacity:.5;margin-top:8px">Keep this tab open and your computer awake.</div>`;
    document.body.appendChild(el);
    const $ = (r) => el.querySelector(`[data-r="${r}"]`);
    const colors = { ok: '#5be37d', warn: '#ffcc4d', err: '#ff6b81' };

    function select(kind) {
      if (S.running) return;
      S.kind = kind;
      el.querySelectorAll('[data-k]').forEach((b) => {
        const on = b.dataset.k === kind;
        b.style.background = on ? '#2e2a4a' : 'transparent';
        b.style.color = on ? '#fff' : '#9a9aa8';
      });
      $('keep').style.display = KINDS[kind].keepable ? 'block' : 'none';
      el.querySelector('[data-a="test"]').textContent = `Test ${KINDS[kind].testCount}`;
      $('bar').style.display = 'none'; $('stats').textContent = '';
    }

    el.addEventListener('click', (e) => {
      const k = e.target.closest('[data-k]')?.dataset.k;
      if (k) return select(k);
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a === 'test') run(S.kind, true);
      if (a === 'all') run(S.kind, false);
      if (a === 'pause') { S.paused = !S.paused; e.target.textContent = S.paused ? 'Resume' : 'Pause'; if (S.paused) api.status('Paused. Press Resume to continue.'); }
      if (a === 'stop') { S.stopped = true; S.paused = false; api.status('Stopping…'); }
      if (a === 'close') { if (S.running && !confirm('Still running. Stop and close?')) return; S.stopped = true; el.remove(); window.__tiktokCleanup = false; }
    });

    const api = {
      status(t, kind) { $('status').textContent = t; $('status').style.color = colors[kind] || '#f4f4f6'; log(t); },
      note(t) { $('note').textContent = t; },
      keepList: () => $('keepInput').value.split(/[\s,]+/).map((s) => s.replace(/^@/, '').trim().toLowerCase()).filter(Boolean),
      mode(m) {
        $('idle').style.display = m === 'idle' ? 'flex' : 'none';
        $('busy').style.display = m === 'running' ? 'flex' : 'none';
        $('tabs').style.opacity = m === 'running' ? '.5' : '1';
        $('keepInput').disabled = m === 'running';
        el.querySelector('[data-a="pause"]').textContent = 'Pause';
      },
      progress(pass) {
        const K = KINDS[S.kind];
        const total = Math.max(S.total, S.removed + S.failed);
        const done = S.removed + S.failed;
        const elapsed = Date.now() - S.startedAt;
        const perMin = elapsed > 30e3 ? (S.removed / (elapsed / 60000)) : 0;
        const left = perMin ? fmtTime(((total - done) / perMin) * 60000) : '…';
        $('bar').style.display = 'block';
        $('fill').style.width = `${total ? Math.min(100, (done / total) * 100) : 0}%`;
        api.status(`${K.verb}${pass > 1 ? ' leftovers' : ''}… ${fmtNum(S.removed)} of ${fmtNum(total)}`);
        $('stats').textContent = `${perMin ? perMin.toFixed(0) + '/min · ~' + left + ' left · ' : ''}running ${fmtTime(elapsed)}${S.failed ? ` · ${S.failed} skipped` : ''}`;
      },
    };
    select('reposts');
    return api;
  })();

  if (!/(^|\.)tiktok\.com$/.test(location.hostname)) { ui.status('Open tiktok.com first, then paste the script there.', 'err'); window.__tiktokCleanup = false; return; }
  const ctx = getContext();
  if (!ctx) ui.status('Couldn\'t find your account on this page. Make sure you\'re logged in, refresh tiktok.com, and paste again.', 'err');
  else log(`Ready for @${ctx.username}`);
})();

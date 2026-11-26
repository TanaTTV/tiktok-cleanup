// Runs tiktok-cleanup.js against a simulated TikTok backend in jsdom.
// Usage: npm test
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM } = require('jsdom');

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'tiktok-cleanup.js'), 'utf8');

// Shrink every delay so the suite runs in seconds.
const fast = (src) => src
  .replace('minDelayMs: 1500', 'minDelayMs: 1')
  .replace('maxDelayMs: 4000', 'maxDelayMs: 2')
  .replace('listPauseMs: 400', 'listPauseMs: 1')
  .replace('ms : 10e3', 'ms : 10')
  .replace('? 60e3 :', '? 20 :')
  .replace('await sleep(3000)', 'await sleep(1)');

const WORKERS = {
  none: () => undefined,
  blocked: () => class { constructor() { setTimeout(() => this.onerror && this.onerror(new Error('CSP')), 10); } postMessage() {} terminate() {} },
  silent: () => class { postMessage() {} terminate() {} },
  works: () => class { postMessage(d) { setTimeout(() => this.onmessage({ data: d.id }), d.ms); } terminate() {} },
};

// A tiny fake TikTok: one list + one remove endpoint per kind.
function fakeTikTok(opts) {
  const ids = (prefix) => Array.from({ length: opts.count }, (_, i) => `${prefix}${1000 + i}`);
  const db = { reposts: ids('r'), likes: ids('l'), favorites: ids('f'), following: ids('u') };
  let calls = 0;
  const bad = { csrf: 0, params: 0 };
  const reply = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
  const videoPage = (list, c) => ({ status_code: 0, itemList: list.slice(c, c + 30).map((id) => ({ id, desc: `caption ${id}`, author: { uniqueId: `creator_${id}` } })), hasMore: c + 30 < list.length, cursor: c + 30 });
  const drop = (kind, id) => { db[kind] = db[kind].filter((x) => x !== id); };

  async function fetch(url, init = {}) {
    calls++;
    const u = new URL(url);
    const q = (k) => u.searchParams.get(k);
    const isPost = init.method === 'POST';
    if (isPost && (init.headers || {})['tt-csrf-token'] !== 'CSRF') bad.csrf++;
    if (opts.logoutAfter && calls > opts.logoutAfter) return reply(200, { status_code: 8, status_msg: 'Please login' });
    if (opts.rateLimit && Math.random() < opts.rateLimit) return reply(429, {});
    switch (u.pathname) {
      case '/api/repost/item_list/': return reply(200, videoPage(db.reposts, +q('cursor')));
      case '/api/favorite/item_list/': return reply(200, videoPage(db.likes, +q('cursor')));
      case '/api/user/collect/item_list/': return reply(200, videoPage(db.favorites, +q('cursor')));
      case '/api/user/list/': {
        if (q('scene') !== '21') bad.params++;
        const c = +q('minCursor');
        const page = db.following.slice(c, c + 30);
        return reply(200, { status_code: 0, userList: page.map((id) => ({ user: { id, secUid: `sec_${id}`, uniqueId: `user_${id}`, nickname: `Name ${id}` } })), hasMore: c + 30 < db.following.length, minCursor: c + 30, maxCursor: 0 });
      }
      case '/tiktok/v1/upvote/delete': {
        if (q('item_id') === opts.stuck) return reply(200, { status_code: 2065, status_msg: 'cannot remove' });
        drop('reposts', q('item_id')); return reply(200, { status_code: 0 });
      }
      case '/api/commit/item/digg/': {
        if (q('type') !== '0') bad.params++;
        if (opts.diggIgnored) return reply(200, { status_code: 0, is_digg: 1 });
        drop('likes', q('aweme_id')); return reply(200, { status_code: 0, is_digg: 0 });
      }
      case '/api/item/collect/': {
        if (q('action') !== '2' || q('secUid') !== 'SEC') bad.params++;
        drop('favorites', q('itemId')); return reply(200, { status_code: 0 });
      }
      case '/api/commit/follow/user/': {
        if (q('type') !== '0' || q('sec_user_id') !== `sec_${q('user_id')}`) bad.params++;
        if (opts.followIgnored) return reply(200, { status_code: 0, follow_status: 1 });
        drop('following', q('user_id')); return reply(200, { status_code: 0, follow_status: 0 });
      }
      default: return reply(404, {});
    }
  }
  return { fetch, db, bad, calls: () => calls };
}

async function scenario(opts) {
  const appContext = { csrfToken: 'CSRF', region: 'US', language: 'en', wid: '123', user: { secUid: 'SEC', uniqueId: 'me' } };
  const dom = new JSDOM(
    `<body><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({ __DEFAULT_SCOPE__: { 'webapp.app-context': appContext } })}</script></body>`,
    { url: 'https://www.tiktok.com/@me', runScripts: 'outside-only' },
  );
  const w = dom.window;
  const tt = fakeTikTok(opts);
  const downloads = [];
  let confirms = 0;
  w.fetch = tt.fetch;
  w.Worker = WORKERS[opts.worker || 'none']();
  w.Blob = class { constructor(parts) { this.text = parts.join(''); } };
  w.URL.createObjectURL = (b) => { w.__lastBlob = b && b.text; return 'blob:test'; };
  w.HTMLAnchorElement.prototype.click = function () { downloads.push({ name: this.download, text: w.__lastBlob }); };
  w.console = { log() {}, warn() {}, error() {} };
  w.confirm = () => { confirms++; return opts.confirm !== false; };

  w.eval(fast(SCRIPT));
  await new Promise((r) => setTimeout(r, 30));
  const q = (s) => w.document.querySelector(s);
  q(`[data-k="${opts.kind}"]`).click();
  if (opts.keep) q('[data-r="keepInput"]').value = opts.keep;
  q(`[data-a="${opts.button}"]`).click();
  if (opts.stopAfterMs) { await new Promise((r) => setTimeout(r, opts.stopAfterMs)); q('[data-a="stop"]').click(); }
  await new Promise((r) => setTimeout(r, 20));
  for (let i = 0; i < 4000 && q('[data-r="idle"]').style.display !== 'flex'; i++) await new Promise((r) => setTimeout(r, 20));
  return { db: tt.db, bad: tt.bad, downloads, confirms, status: q('[data-r="status"]').textContent };
}

const KINDS = ['reposts', 'likes', 'favorites', 'following'];
const rest = (r, kind) => KINDS.filter((k) => k !== kind).every((k) => r.db[k].length === 95);

const cases = [];
for (const kind of KINDS) {
  const testN = kind === 'following' ? 3 : 5;
  cases.push(
    [`${kind}: Test removes exactly ${testN}, no confirm or backup`, { kind, count: 95, button: 'test' }, (r) => {
      assert.equal(r.db[kind].length, 95 - testN); assert.match(r.status, /Test done/);
      assert.equal(r.confirms, 0); assert.equal(r.downloads.length, 0);
    }],
    [`${kind}: Remove all clears everything and touches nothing else`, { kind, count: 95, button: 'all' }, (r) => {
      assert.equal(r.db[kind].length, 0); assert.match(r.status, /All done! 95/); assert.ok(rest(r, kind));
    }],
    [`${kind}: Remove all downloads a full CSV backup first`, { kind, count: 95, button: 'all' }, (r) => {
      assert.equal(r.downloads.length, 1);
      assert.match(r.downloads[0].name, new RegExp(`^tiktok-${kind}-backup-\\d{4}-\\d\\d-\\d\\d\\.csv$`));
      assert.equal(r.downloads[0].text.trim().split('\n').length, 96, 'header + 95 rows');
    }],
    [`${kind}: Cancelling the confirm removes nothing`, { kind, count: 95, button: 'all', confirm: false }, (r) => {
      assert.equal(r.db[kind].length, 95); assert.match(r.status, /Cancelled/); assert.equal(r.downloads.length, 0);
    }],
    [`${kind}: Empty list`, { kind, count: 0, button: 'all' }, (r) => assert.match(r.status, /No .* found/)],
  );
}
cases.push(
  ['following: keep list is respected (with or without @, any case)', { kind: 'following', count: 95, button: 'all', keep: '@user_u1003, USER_u1050  user_u1094' }, (r) => {
    assert.deepEqual(r.db.following.sort(), ['u1003', 'u1050', 'u1094']); assert.match(r.status, /All done! 92/);
  }],
  ['following: stops for safety if TikTok says you still follow', { kind: 'following', count: 95, button: 'all', followIgnored: true }, (r) => {
    assert.equal(r.db.following.length, 95); assert.match(r.status, /Stopped for safety/);
  }],
  ['likes: a like TikTok refuses to remove is skipped, not counted', { kind: 'likes', count: 5, button: 'all', diggIgnored: true }, (r) => {
    assert.equal(r.db.likes.length, 5); assert.match(r.status, /5 couldn't be removed/);
  }],
  ['reposts: survives rate limits and skips a stuck item', { kind: 'reposts', count: 95, button: 'all', rateLimit: 0.1, stuck: 'r1050' }, (r) => {
    assert.deepEqual(r.db.reposts, ['r1050']); assert.match(r.status, /1 couldn't be removed/);
  }],
  ['reposts: stops cleanly when logged out', { kind: 'reposts', count: 95, button: 'all', logoutAfter: 40 }, (r) => {
    assert.ok(r.db.reposts.length > 0); assert.match(r.status, /logged you out/);
  }],
  ['reposts: Stop button halts the run', { kind: 'reposts', count: 95, button: 'all', stopAfterMs: 150 }, (r) => {
    assert.ok(r.db.reposts.length > 0 && r.db.reposts.length < 95); assert.match(r.status, /Stopped\. Cleared/);
  }],
);

(async () => {
  let failed = 0; let passed = 0;
  const runCase = async (label, opts, check) => {
    try {
      const r = await scenario(opts);
      check(r);
      assert.equal(r.bad.csrf, 0, 'every write sends the CSRF token');
      assert.equal(r.bad.params, 0, 'every request uses the expected parameters');
      passed++; console.log(`  ✓ ${label}`);
    } catch (e) { failed++; console.log(`  ✗ ${label}\n      ${e.message}`); }
  };
  for (const [name, opts, check] of cases) await runCase(name, opts, check);
  // Timer fallbacks: every worker behaviour must still complete a full run.
  for (const worker of Object.keys(WORKERS)) {
    await runCase(`timers [${worker}]: full run completes`, { kind: 'likes', count: 40, button: 'all', worker }, (r) => assert.equal(r.db.likes.length, 0));
  }
  console.log(failed ? `\n${passed} passed, ${failed} failed` : `\nAll ${passed} tests passed`);
  process.exit(failed ? 1 : 0);
})();

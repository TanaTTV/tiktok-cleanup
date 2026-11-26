// Runs the script against a simulated TikTok backend in jsdom.
// Usage: npm test
const fs = require('fs');
const path = require('path');
const assert = require('assert');
const { JSDOM } = require('jsdom');

const SCRIPT = fs.readFileSync(path.join(__dirname, '..', 'tiktok-repost-remover.js'), 'utf8');

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

async function scenario(opts) {
  const appContext = { csrfToken: 'CSRF', user: { secUid: 'SEC', uniqueId: 'me' } };
  const dom = new JSDOM(
    `<body><script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application/json">${JSON.stringify({ __DEFAULT_SCOPE__: { 'webapp.app-context': appContext } })}</script></body>`,
    { url: 'https://www.tiktok.com/@me', runScripts: 'outside-only' },
  );
  const w = dom.window;
  let reposts = Array.from({ length: opts.count }, (_, i) => String(1000 + i));
  let calls = 0;
  let missingCsrf = 0;

  w.fetch = async (url, init = {}) => {
    calls++;
    const u = new URL(url);
    const reply = (status, body) => ({ ok: status < 400, status, text: async () => JSON.stringify(body) });
    if (opts.logoutAfter && calls > opts.logoutAfter) return reply(200, { status_code: 8, status_msg: 'Please login' });
    if (opts.rateLimit && Math.random() < opts.rateLimit) return reply(429, {});
    if (u.pathname === '/api/repost/item_list/') {
      const c = Number(u.searchParams.get('cursor'));
      return reply(200, { status_code: 0, itemList: reposts.slice(c, c + 30).map((id) => ({ id })), hasMore: c + 30 < reposts.length, cursor: c + 30 });
    }
    if (u.pathname === '/tiktok/v1/upvote/delete') {
      if ((init.headers || {})['tt-csrf-token'] !== 'CSRF') missingCsrf++;
      const id = u.searchParams.get('item_id');
      if (id === opts.stuck) return reply(200, { status_code: 2065, status_msg: 'cannot remove' });
      reposts = reposts.filter((r) => r !== id);
      return reply(200, { status_code: 0 });
    }
    return reply(404, {});
  };
  w.Worker = WORKERS[opts.worker || 'none']();
  w.Blob = class {};
  w.URL.createObjectURL = () => 'blob:test';
  w.console = { log() {}, warn() {}, error() {} };
  w.confirm = () => true;

  w.eval(fast(SCRIPT));
  await new Promise((r) => setTimeout(r, 30));
  const q = (s) => w.document.querySelector(s);
  q(`[data-a="${opts.button}"]`).click();
  if (opts.stopAfterMs) { await new Promise((r) => setTimeout(r, opts.stopAfterMs)); q('[data-a="stop"]').click(); }
  for (let i = 0; i < 3000 && q('[data-r="idle"]').style.display !== 'flex'; i++) await new Promise((r) => setTimeout(r, 20));
  return { remaining: reposts.length, missingCsrf, status: q('[data-r="status"]').textContent };
}

const cases = [
  ['Test 5 removes exactly five', { count: 95, button: 'test' }, (r) => { assert.equal(r.remaining, 90); assert.match(r.status, /Test done/); }],
  ['Remove all clears everything', { count: 95, button: 'all' }, (r) => { assert.equal(r.remaining, 0); assert.match(r.status, /All done! Removed 95/); }],
  ['Survives rate limits and skips a stuck item', { count: 95, button: 'all', rateLimit: 0.1, stuck: '1050' }, (r) => { assert.equal(r.remaining, 1); assert.match(r.status, /1 couldn't be removed/); }],
  ['Stops cleanly when logged out', { count: 95, button: 'all', logoutAfter: 40 }, (r) => { assert.ok(r.remaining > 0); assert.match(r.status, /logged you out/); }],
  ['Stop button halts the run', { count: 95, button: 'all', stopAfterMs: 150 }, (r) => { assert.ok(r.remaining > 0 && r.remaining < 95); assert.match(r.status, /Stopped/); }],
  ['Handles an account with no reposts', { count: 0, button: 'all' }, (r) => assert.match(r.status, /No reposts found/)],
];

(async () => {
  let failed = 0;
  for (const worker of Object.keys(WORKERS)) {
    for (const [name, opts, check] of cases) {
      const label = `${name} [worker: ${worker}]`;
      try {
        const r = await scenario({ ...opts, worker });
        check(r);
        assert.equal(r.missingCsrf, 0, 'every removal sends the CSRF token');
        console.log(`  ✓ ${label}`);
      } catch (e) {
        failed++;
        console.log(`  ✗ ${label}\n      ${e.message}`);
      }
    }
  }
  console.log(failed ? `\n${failed} failed` : '\nAll tests passed');
  process.exit(failed ? 1 : 0);
})();

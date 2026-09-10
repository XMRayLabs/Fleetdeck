// Run after building frontend, with playwright installed (and a browser available).
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../packages/frontend/dist');
const nginx = fs.readFileSync(path.resolve(__dirname, '../packages/frontend/nginx.conf'), 'utf8');
const csp = nginx.match(/add_header Content-Security-Policy "([^"]+)"/)[1];
let needsSetup = true;
const server = http.createServer((req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  res.setHeader('Content-Security-Policy', csp);
  if (pathname === '/healthz') {
    res.setHeader('Content-Type', 'text/html');
    return res.end('<!doctype html><title>Service worker test</title>');
  }
  if (pathname.startsWith('/api/')) {
    res.setHeader('Content-Type', 'application/json');
    if (pathname.endsWith('/auth/needs-setup')) return res.end(JSON.stringify({ needsSetup }));
    if (pathname.endsWith('/settings/captcha')) return res.end(JSON.stringify({ provider: 'none', enabled: false }));
    res.statusCode = 401;
    return res.end(JSON.stringify({ message: 'Unauthenticated test session' }));
  }
  let file = path.resolve(root, '.' + pathname);
  if (!file.startsWith(root + path.sep) && file !== root) { res.statusCode = 403; return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    if (path.extname(pathname)) { res.statusCode = 404; return res.end(); }
    file = path.join(root, 'index.html');
  }
  const types = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
  res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
  res.end(fs.readFileSync(file));
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
  try {
    for (const locale of ['zh-CN', 'en-US', 'ja-JP']) {
      for (const setup of [true, false]) {
        needsSetup = setup;
        const context = await browser.newContext({ locale, serviceWorkers: 'block' });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        page.on('console', m => { if (/EvalError|Content Security Policy|Uncaught|SyntaxError/.test(m.text())) errors.push(m.text()); });
        await page.goto(`http://127.0.0.1:${server.address().port}/`, { waitUntil: 'networkidle' });
        await page.locator('input#username').waitFor({ state: 'visible' });
        assert.match(page.url(), setup ? /\/setup$/ : /\/login$/);
        assert.ok((await page.locator('body').innerText()).length > 30);
        await page.evaluate(value => localStorage.setItem('user-locale', value), locale);
        await page.reload({ waitUntil: 'networkidle' });
        await page.locator('input#username').waitFor({ state: 'visible' });
        const workerResult = await page.evaluate(async () => {
          const url = self.MonacoEnvironment.getWorkerUrl('', 'editorWorkerService');
          const response = await fetch(url);
          if (!response.ok) throw new Error('Worker asset missing');
          return new Promise((resolve, reject) => {
            const worker = new Worker(url);
            const timer = setTimeout(() => { worker.terminate(); resolve(true); }, 500);
            worker.onerror = e => { clearTimeout(timer); worker.terminate(); reject(new Error(e.message)); };
          });
        });
        assert.equal(workerResult, true);
        assert.deepEqual(errors, []);
        console.log(`PASS ${locale} ${setup ? 'setup' : 'login'}: visible form, strict CSP, worker loaded`);
        await context.close();
      }
    }
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/healthz`);
    const cacheNames = await page.evaluate(async () => {
      await caches.open('fleetdeck-cache-v2');
      await caches.open('unrelated-test-cache');
      await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      if (!navigator.serviceWorker.controller) {
        await new Promise(resolve => navigator.serviceWorker.addEventListener('controllerchange', resolve, { once: true }));
      }
      return caches.keys();
    });
    assert.ok(!cacheNames.includes('fleetdeck-cache-v2'));
    assert.ok(cacheNames.includes('unrelated-test-cache'));
    console.log('PASS service worker: retired stale FleetDeck cache, preserved unrelated cache');
    await context.close();
  } finally { await browser.close(); server.close(); }
})().catch(e => { console.error(e); server.close(); process.exitCode = 1; });

// Real production backend + browser. CI also runs the shipped Nginx config.
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { setTimeout: delay } = require('node:timers/promises');
const repo = path.resolve(__dirname, '..');
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetdeck-auth-test-'));
const config = fs.readFileSync(path.join(repo, 'packages/frontend/nginx.conf'), 'utf8');
const dist = path.join(repo, 'packages/frontend/dist');
const children = [];
const servers = [];
let browser;
let backendLog = '';
const listen = async (server, port = 0) => {
  servers.push(server);
  await new Promise(resolve => server.listen(port, '127.0.0.1', resolve));
  return server.address().port;
};
const freePort = async () => {
  const server = http.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
};
const proxy = (req, res, port, headers) => {
  const request = http.request({ hostname: '127.0.0.1', port, path: req.url, method: req.method, headers }, response => {
    res.writeHead(response.statusCode, response.headers);
    response.pipe(res);
  });
  request.on('error', () => { res.statusCode = 502; res.end(); });
  req.pipe(request);
};
(async () => {
  const backendPort = await freePort();
  const outerPort = await freePort();
  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: path.join(repo, 'packages/backend'),
    env: { ...process.env, DATA_DIR: data, NODE_ENV: 'production', COOKIE_SECURE: 'true',
      PORT: String(backendPort), APP_ORIGIN: `http://localhost:${outerPort}`, ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      SESSION_SECRET: randomBytes(64).toString('hex'), REMOTE_GATEWAY_SHARED_SECRET: randomBytes(48).toString('hex') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  child.stdout.on('data', chunk => { backendLog = (backendLog + chunk).slice(-12000); });
  child.stderr.on('data', chunk => { backendLog = (backendLog + chunk).slice(-12000); });
  let healthy = false;
  for (let i = 0; i < 60; i++) {
    try { healthy = (await fetch(`http://127.0.0.1:${backendPort}/api/v1/status`)).ok; } catch {}
    if (healthy) break;
    if (child.exitCode !== null) throw new Error('Backend exited: ' + backendLog);
    await delay(500);
  }
  assert.ok(healthy, 'Backend must become healthy');
  let frontendPort;
  if (process.env.NGINX_BIN) {
    frontendPort = await freePort();
    const nginxConfig = config.replace('listen 8080;', `listen 127.0.0.1:${frontendPort};`)
      .replace('root /usr/share/nginx/html;', `root "${dist.replaceAll('\\', '/')}";`)
      .replaceAll('http://backend:3001', `http://127.0.0.1:${backendPort}`);
    const configFile = path.join(data, 'nginx.conf');
    fs.writeFileSync(configFile, `pid "${data}/nginx.pid";\nerror_log stderr;\nevents {}\nhttp { include /etc/nginx/mime.types; access_log off; client_body_temp_path "${data}/client"; proxy_temp_path "${data}/proxy"; ${nginxConfig} }`);
    const nginx = spawn(process.env.NGINX_BIN, ['-p', data, '-c', configFile, '-g', 'daemon off;'], { stdio: ['ignore', 'pipe', 'pipe'] });
    children.push(nginx);
    nginx.stderr.on('data', chunk => { backendLog = (backendLog + chunk).slice(-12000); });
    for (let i = 0; i < 30; i++) {
      try { if ((await fetch(`http://127.0.0.1:${frontendPort}/healthz`)).ok) break; } catch {}
      if (nginx.exitCode !== null) throw new Error('Nginx exited: ' + backendLog);
      await delay(200);
    }
  } else {
    // Local Windows fallback; CI uses actual Nginx, not this adapter.
    frontendPort = await listen(http.createServer((req, res) => {
      if (req.url.startsWith('/api/')) {
        const preservesHttps = config.includes('proxy_set_header X-Forwarded-Proto $fleetdeck_forwarded_proto;');
        return proxy(req, res, backendPort, { ...req.headers, 'x-forwarded-proto': preservesHttps ? req.headers['x-forwarded-proto'] : 'http' });
      }
      const pathname = new URL(req.url, 'http://localhost').pathname;
      let file = path.resolve(dist, '.' + pathname);
      if (!file.startsWith(dist + path.sep) && file !== dist) { res.statusCode = 403; return res.end(); }
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
      const types = { '.js': 'application/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.svg': 'image/svg+xml' };
      res.setHeader('Content-Type', types[path.extname(file)] || 'application/octet-stream');
      res.setHeader('Content-Security-Policy', config.match(/add_header Content-Security-Policy "([^"]+)"/)[1]);
      res.end(fs.readFileSync(file));
    }));
  }
  // Emulate the trusted TLS-terminating outer proxy, overwriting client headers.
  await listen(http.createServer((req, res) => proxy(req, res, frontendPort, { ...req.headers, 'x-forwarded-proto': 'https' })), outerPort);
  const origin = `http://localhost:${outerPort}`;
  const password = 'Test-' + randomBytes(20).toString('hex') + '!';
  const setup = await fetch(origin + '/api/v1/auth/setup', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'smoke-admin', password, confirmPassword: password }),
  });
  assert.ok(setup.ok, 'Isolated administrator setup must succeed');
  browser = await chromium.launch({ headless: true, ...(process.env.BROWSER_CHANNEL ? { channel: process.env.BROWSER_CHANNEL } : {}) });
  const context = await browser.newContext({ locale: 'en-US', serviceWorkers: 'block' });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/login');
  await page.locator('#username').fill('smoke-admin');
  await page.locator('#password').fill(password);
  const loginResponse = page.waitForResponse(r => r.url().endsWith('/auth/login') && r.request().method() === 'POST');
  await page.locator('button[type="submit"]').click();
  const response = await loginResponse;
  assert.equal(response.status(), 200);
  assert.match((await response.allHeaders())['set-cookie'] || '', /; Secure/i, 'Login must issue a Secure session cookie behind both proxies');
  await page.waitForURL(origin + '/', { timeout: 15000 });
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(page.url(), origin + '/', 'Login must survive a full reload');
  assert.equal((await context.request.get(origin + '/api/v1/auth/status')).status(), 200);
  console.log('PASS real login: Secure cookie, authenticated dashboard, reload retains session');
  const locales = [ ['zh-CN', '系统'], ['ja-JP', 'システム'], ['en-US', 'System'] ];
  for (const [locale, systemLabel] of locales) {
    await page.goto(origin + '/settings', { waitUntil: 'networkidle' });
    await page.getByRole('button', { name: /^(System|系统|システム)$/ }).click();
    await page.locator('#languageSelect').selectOption(locale);
    const saved = page.waitForResponse(r => r.url().endsWith('/api/v1/settings') && r.request().method() === 'PUT');
    await page.locator('form').filter({ has: page.locator('#languageSelect') }).locator('button[type="submit"]').click();
    assert.equal((await saved).status(), 200);
    await page.getByRole('button', { name: systemLabel, exact: true }).waitFor({ state: 'visible' });
    const settings = await (await context.request.get(origin + '/api/v1/settings')).json();
    assert.equal(settings.language, locale);
    await page.reload({ waitUntil: 'networkidle' });
    assert.ok(page.url().endsWith('/settings'), 'Language update must not log the user out');
    await page.getByRole('button', { name: /^(System|系统|システム)$/ }).click();
    assert.equal(await page.locator('#languageSelect').inputValue(), locale);
    assert.equal(await page.evaluate(() => localStorage.getItem('user-locale')), locale);
    console.log(`PASS real settings: ${locale} saved to database and retained after reload`);
  }
  assert.deepEqual(errors, []);
})().catch(error => { console.error(error); console.error(backendLog); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  for (const server of servers) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  for (const child of children.reverse()) {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(10000)]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
  // Only remove this test's fresh, isolated temporary directory.
  fs.rmSync(data, { recursive: true, force: true });
});

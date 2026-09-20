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
  // Icons must still render when downloadable fonts are unavailable.
  await page.route(/\.(woff2?|ttf|eot)(\?.*)?$/, route => route.abort());
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
  assert.equal(await page.locator('.fd-topbar').getByRole('button', { name: 'Collapse sidebar', exact: true }).count(), 0);
  assert.equal(await page.locator('aside.fd-sidebar').getByRole('button', { name: 'Appearance', exact: true }).count(), 0);
  await page.locator('aside.fd-sidebar').getByRole('button', { name: 'Collapse sidebar', exact: true }).click();
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.locator('aside.fd-sidebar').evaluate(el => Math.round(el.getBoundingClientRect().width)), 64);
  await page.locator('aside.fd-sidebar').getByRole('button', { name: 'Expand sidebar', exact: true }).click();
  assert.equal(await page.locator('aside.fd-sidebar').evaluate(el => Math.round(el.getBoundingClientRect().width)), 192);
  console.log('PASS sidebar: compact width and persistent collapse');
  const ipv6Record = await context.request.post(origin + '/api/v1/connections', { data: {
    name: 'ipv6-save-test', type: 'SSH', host: '2001:0db8:0000:0000:0000:0000:0000:0001',
    port: 22, username: 'root', auth_method: 'password', credential_mode: 'prompt',
  } });
  assert.ok(ipv6Record.ok());
  const { connection: ipv6 } = await ipv6Record.json();
  assert.equal(ipv6.host, '2001:db8::1');
  const edited = await context.request.put(origin + '/api/v1/connections/' + ipv6.id, { data: { host: '2001:0db8:0000:0000:0000:0000:0000:0002' } });
  assert.ok(edited.ok());
  const stored = await (await context.request.get(origin + '/api/v1/connections/' + ipv6.id)).json();
  assert.equal(stored.host, '2001:db8::2');
  assert.equal(stored.port, 22);
  assert.equal(stored.username, 'root');
  assert.ok((await context.request.delete(origin + '/api/v1/connections/' + ipv6.id)).ok());
  console.log('PASS IPv6 create/update persisted canonically; username and port preserved');
  // Real AI config/preview APIs; the model and execution boundaries are mocked for UI only.
  let modelReads = 0;
  await page.route('**/api/v1/ai/models', route => {
    modelReads++;
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ models: ['fixture-model', 'fixture-instruct'], suggestedModel: 'fixture-model' }) });
  });
  await page.goto(origin + '/ai', { waitUntil: 'networkidle' });
  await page.getByLabel('API base URL (include /v1 if required)', { exact: true }).fill('https://example.com/v1');
  await page.getByLabel('API Key', { exact: true }).fill('fixture-ui-key-not-real');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'Saved' }).waitFor();
  assert.ok(modelReads > 0, 'Saving must automatically discover a model without typing an ID');
  assert.equal((await (await context.request.get(origin + '/api/v1/ai/config')).json()).model, 'fixture-model');
  await page.locator('summary').filter({ hasText: /^AI API settings$/ }).click();
  await page.getByLabel('Model', { exact: true }).selectOption('fixture-instruct');
  const modelSaved = page.waitForResponse(r => r.url().endsWith('/ai/config') && r.request().method() === 'PUT');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  assert.equal((await modelSaved).status(), 200);
  await page.getByRole('status').filter({ hasText: 'Saved' }).waitFor();
  assert.equal((await (await context.request.get(origin + '/api/v1/ai/config')).json()).model, 'fixture-instruct');
  await page.getByLabel('What should AI help with?', { exact: true }).fill('Analyze disk usage');
  await page.locator('.ai-composer-shell summary').click();
  await page.getByLabel('Selected terminal text / logs', { exact: true }).fill('password=browser-test-secret\nTOKEN=browser-test-token\nFilesystem full');
  await page.getByRole('button', { name: 'Preview redacted content', exact: true }).click();
  const redactedPreview = page.getByTestId('ai-preview');
  await redactedPreview.waitFor();
  assert.ok(!(await redactedPreview.innerText()).includes('browser-test-secret'));
  assert.ok(!(await redactedPreview.innerText()).includes('browser-test-token'));
  const sendAi = page.getByRole('button', { name: 'Send to AI', exact: true });
  assert.ok(await sendAi.isDisabled());
  await page.route('**/api/v1/ai/analyze', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ analysis: '<img src=x onerror=alert(1)> Diagnose disk usage.', commands: ['df -h'], proposalId: null, targetIds: [] }) }));
  await page.getByLabel('I have reviewed the content and approve sending it to this provider.', { exact: true }).check();
  await sendAi.click();
  await page.locator('.ai-analysis').waitFor();
  assert.equal(await page.locator('.ai-analysis img').count(), 0, 'AI output must render as text, never HTML');
  assert.equal(await page.getByRole('button', { name: 'Execute approved commands', exact: true }).count(), 0, 'Analysis-only must not allow execution');
  await page.getByLabel('What should AI help with?', { exact: true }).fill('Updated task');
  assert.equal(await page.locator('.ai-analysis').count(), 0, 'Editing inputs must invalidate proposals');
  assert.equal(await page.locator('.ai-archived-analysis').count(), 1, 'Previous answer remains visible in the conversation');
  await page.getByRole('button', { name: 'Preview redacted content', exact: true }).click();
  await page.getByTestId('ai-preview').waitFor();
  const conversationPreview = JSON.parse(await page.getByTestId('ai-preview').innerText());
  assert.equal(conversationPreview.history.length, 2);
  assert.ok(conversationPreview.history[1].content.includes('Diagnose disk usage.'));
  assert.ok(!(await page.evaluate(() => JSON.stringify(localStorage))).includes('browser-test-secret'));
  await page.unroute('**/api/v1/ai/analyze');
  const aiFixtureResponse = await context.request.post(origin + '/api/v1/connections', { data: {
    name: 'ai-execution-fixture', type: 'SSH', host: '192.0.2.99', port: 22, username: 'operator', auth_method: 'password', credential_mode: 'prompt',
  } });
  assert.ok(aiFixtureResponse.ok());
  const { connection: aiFixture } = await aiFixtureResponse.json();
  await page.goto(origin + '/ai', { waitUntil: 'networkidle' });
  await page.getByLabel('What should AI help with?', { exact: true }).fill('Check system');
  await page.locator('.ai-server').filter({ hasText: 'ai-execution-fixture' }).getByRole('checkbox').check();
  await page.getByRole('button', { name: 'Preview redacted content', exact: true }).click();
  await page.getByTestId('ai-preview').waitFor();
  await page.route('**/api/v1/ai/analyze', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ analysis: 'Inspect the OS.', commands: ['uname -a'], proposalId: 'ui-only-proposal', targetIds: [aiFixture.id] }) }));
  await page.getByLabel('I have reviewed the content and approve sending it to this provider.', { exact: true }).check();
  await page.getByRole('button', { name: 'Send to AI', exact: true }).click();
  const executeAi = page.getByRole('button', { name: 'Execute approved commands', exact: true });
  await executeAi.waitFor(); assert.ok(await executeAi.isDisabled());
  await page.getByLabel('I approve these exact commands on the targets listed below.', { exact: true }).check();
  await page.getByLabel(/ai-execution-fixture · Temporary password/).fill('ephemeral-fixture-secret');
  let executedAi = false;
  await page.route('**/api/v1/ai/execute', route => {
    const body = route.request().postDataJSON();
    assert.equal(body.proposalId, 'ui-only-proposal'); assert.equal(body.confirm, true);
    assert.equal(body.ephemeralCredentials[aiFixture.id].password, 'ephemeral-fixture-secret');
    assert.equal(body.commands, undefined); assert.equal(body.targetIds, undefined);
    executedAi = true;
    return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ jobId: 'ui-only-job' }) });
  });
  await page.route('**/api/v1/ai/jobs/ui-only-job', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ job: { id: 'ui-only-job', status: 'success', targetCount: 1, completedCount: 1, targets: [{ id: 1, connectionName: 'ai-execution-fixture', status: 'success', exitCode: 0, stdout: 'Linux fixture' }] } }) }));
  await executeAi.click();
  await page.getByRole('heading', { name: '3 · Execution result · success' }).waitFor();
  assert.ok(executedAi); assert.equal(await executeAi.count(), 0, 'Consumed approval must disappear');
  await page.getByRole('button', { name: 'Use result for another analysis' }).click();
  assert.ok((await page.getByLabel('Selected terminal text / logs', { exact: true }).inputValue()).includes('Linux fixture'));
  assert.equal(await page.getByRole('button', { name: 'Send to AI', exact: true }).count(), 0, 'Follow-up must require a new preview');
  for (const pattern of ['**/api/v1/ai/analyze', '**/api/v1/ai/execute', '**/api/v1/ai/jobs/ui-only-job']) await page.unroute(pattern);
  await page.locator('.ai-context-panel summary').filter({hasText:'Saved conversations'}).click();
  await page.getByRole('button',{name:'Save encrypted conversation',exact:true}).click();
  await page.getByRole('button',{name:'Load as history',exact:true}).waitFor();
  const draftBefore=await page.getByLabel('What should AI help with?',{exact:true}).inputValue();
  await page.locator('.fd-nav').getByRole('link',{name:'Monitoring',exact:true}).click();
  await page.getByRole('button',{name:'AI assistant',exact:true}).click();
  await page.locator('.fd-agent-dock').waitFor();
  const dockBounds=await page.locator('.fd-agent-dock').boundingBox();const mainBounds=await page.locator('main.fd-console').boundingBox();
  assert.ok(mainBounds.x+mainBounds.width<=dockBounds.x+2,'Desktop agent must not cover the main workspace');
  assert.equal(await page.getByLabel('What should AI help with?',{exact:true}).inputValue(),draftBefore,'SPA navigation must retain conversation');
  await page.locator('.fd-agent-dock-header button').click();
  const monitorFixture={source:'https://monitor.example',fetchedAt:Date.now(),servers:[{id:7,name:'monitor-node',platform:'linux',lastActive:new Date().toISOString(),cpu:12,memoryUsed:1024,memoryTotal:4096,diskUsed:4096,diskTotal:8192,load1:0.1,load5:0.2,load15:0.3,netIn:1024,netOut:2048}]};
  await page.route('**/api/v1/ai/context/monitor/snapshot',r=>r.fulfill({contentType:'application/json',body:JSON.stringify(monitorFixture)}));
  await page.getByLabel('Public Nezha dashboard URL',{exact:true}).fill('https://monitor.example');
  await page.locator('form').filter({has:page.getByLabel('Public Nezha dashboard URL',{exact:true})}).getByRole('button',{name:'Save',exact:true}).click();
  await page.getByText('monitor-node',{exact:true}).waitFor();
  assert.ok((await page.locator('.monitor-table').innerText()).includes('12.0%'));
  await page.getByLabel('ai-execution-fixture Device aliases',{exact:true}).fill('1号服务器');
  await page.locator('.monitor-alias').filter({hasText:'ai-execution-fixture'}).getByRole('button',{name:'Save',exact:true}).click();
  await page.getByRole('button',{name:'Discuss with agent',exact:true}).click();
  await page.getByLabel('What should AI help with?',{exact:true}).fill('1号服务器执行 uname -a');
  await page.getByRole('button',{name:'Find devices mentioned in message',exact:true}).click();
  await page.getByRole('button',{name:'Use these devices as scope',exact:true}).waitFor();
  await page.getByRole('button',{name:'Use these devices as scope',exact:true}).click();
  assert.ok(await page.getByLabel('Include fresh monitoring snapshot',{exact:true}).isChecked());
  assert.ok(await page.locator('.ai-server').filter({hasText:'ai-execution-fixture'}).getByRole('checkbox').isChecked());
  await page.locator('.fd-agent-dock').evaluate(el=>{el.scrollTop=0;});
  if(process.env.UI_SCREENSHOT_DIR)await page.screenshot({path:path.join(process.env.UI_SCREENSHOT_DIR,'1440-monitor-agent.png'),fullPage:true});
  await page.locator('.fd-agent-dock-header button').click();
  await page.unroute('**/api/v1/ai/context/monitor/snapshot');
  console.log('PASS monitoring UI, aliases, agent dock and conversation retained across SPA navigation');
  await context.request.delete(origin + '/api/v1/connections/' + aiFixture.id);
  console.log('PASS AI browser command review, execution consent, SSH-only temporary password, one-shot UI, result-to-new-preview workflow (mock execution)');
  console.log('PASS AI browser: real config + redacted preview, explicit sending consent, text-only output, analysis-only execution guard, draft invalidation, no log localStorage');
  await page.goto(origin, { waitUntil: 'networkidle' });
  const iconState = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.querySelectorAll('.fd-overview-grid i')].map(icon => {
      const css = getComputedStyle(icon, '::before');
      return { mask: css.maskImage, width: css.width, height: css.height };
    });
  });
  console.log('Checking bundled SVG icons with font downloads blocked');
  assert.equal(iconState.length, 3);
  for (const icon of iconState) {
    assert.ok(icon.mask.includes('data:image/svg+xml'), 'Dashboard icon must use a bundled SVG');
    assert.ok(parseFloat(icon.width) > 0 && parseFloat(icon.height) > 0, 'Icon must have visible dimensions');
  }
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
  if (process.env.UI_SCREENSHOT_DIR) {
    const directory = path.resolve(process.env.UI_SCREENSHOT_DIR);
    fs.mkdirSync(directory, { recursive: true });
    // Documentation-only addresses: create records in the disposable database,
    // never connect to or execute commands on these example targets.
    for (const [index, name] of ['edge-gateway-01', 'production-api-01', 'production-api-02', 'database-primary', 'staging-runner', 'windows-admin'].entries()) {
      const result = await context.request.post(origin + '/api/v1/connections', { data: {
        name, type: index === 5 ? 'RDP' : 'SSH', host: `192.0.2.${index + 10}`,
        port: index === 5 ? 3389 : 22, username: 'operator', auth_method: 'password', credential_mode: 'prompt',
      } });
      assert.ok(result.ok(), 'Create isolated UI test connection');
    }
    for (const width of [1440, 390]) {
      if (width === 390) await page.addInitScript(() => Object.defineProperty(navigator, 'userAgent', {
        get: () => 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148',
      }));
      await page.setViewportSize({ width, height: 960 });
      for (const route of ['/', '/connections', '/orchestration', '/playbooks', '/proxies', '/notifications', '/audit-logs', '/settings', '/monitoring', '/ai', '/workspace']) {
        await page.goto(origin + route, { waitUntil: 'networkidle' });
        assert.equal(page.url(), origin + route);
        const missingIcons = await page.evaluate(() => [...document.querySelectorAll('.fas,.far,.fab,.fa-solid,.fa-regular,.fa-brands')]
          .filter(icon => icon.getBoundingClientRect().width > 0 && getComputedStyle(icon, '::before').maskImage === 'none')
          .map(icon => icon.className));
        assert.deepEqual(missingIcons, [], `All visible icons must render: ${route}`);
        if (route === '/workspace') {
          if (width === 390) {
            await page.getByRole('button', { name: 'Main navigation', exact: true }).click();
            await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Terminal', exact: true }).click();
          }
          await page.locator('.fd-workspace-welcome').waitFor();
          await page.locator('.fd-terminal-tabs button', { has: page.locator('.fa-plus') }).click();
          await page.locator('.popup-connection-list').waitFor();
          await page.locator('.fd-terminal-tabs > .fixed.inset-0').click({ position: { x: 2, y: 2 } });
        }
        await page.screenshot({ path: path.join(directory, `${width}-${route.slice(1) || 'dashboard'}.png`), fullPage: true });
        if (route === '/workspace' && width === 1440) {
          await page.locator('.fd-open-panels').click();
          await page.locator('.fd-pane-heading').first().waitFor();
          await page.waitForLoadState('networkidle');
          await page.screenshot({ path: path.join(directory, '1440-workspace-panels.png'), fullPage: true });
          const missing = await page.evaluate(() => [...document.querySelectorAll('.workspace-view .fas,.workspace-view .far,.workspace-view .fab')]
            .filter(icon => icon.getBoundingClientRect().width > 0 && getComputedStyle(icon, '::before').maskImage === 'none').map(icon => icon.className));
          assert.deepEqual(missing, [], 'Workspace tools must have SVG icons');
        }
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 2);
        console.log(`UI ${width} ${route}: horizontal overflow=${overflow}`);
        assert.ok(!overflow, `Page must fit viewport: ${width} ${route}`);
        if (width === 390 && route === '/') {
          await page.getByRole('button', { name: 'Main navigation', exact: true }).click();
          await page.getByRole('navigation', { name: 'Main navigation' }).getByRole('link', { name: 'Connections', exact: true }).click();
          await page.waitForURL(origin + '/connections');
          console.log('PASS mobile navigation: opens, navigates, and closes');
        }
        await delay(1000); // Avoid testing with an unrealistic burst of navigation requests.
      }
      await page.goto(origin + '/playbooks', { waitUntil: 'networkidle' });
      await page.locator('.hero-actions button').last().click();
      await page.locator('.drawer').waitFor({ state: 'visible' });
      await page.screenshot({ path: path.join(directory, `${width}-playbook-editor.png`), fullPage: true });
    }
    // Inspect RDP controls without reaching any real Windows host.
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.route('**/rdp-session?*', route => route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ message: 'Isolated RDP test: no remote server' }) }));
    page.on('dialog', dialog => dialog.accept('test-only-not-a-real-password'));
    await page.goto(origin + '/', { waitUntil: 'networkidle' });
    await page.locator('li').filter({ hasText: 'windows-admin' }).getByRole('button', { name: 'Connect', exact: true }).click();
    await page.getByText('Isolated RDP test: no remote server', { exact: false }).waitFor();
    assert.equal(await page.locator('#rdp-resolution option').count(), 7);
    const rdpModal = page.locator('#rdp-resolution').locator('xpath=../..');
    await page.locator('#rdp-resolution').selectOption('1024x768');
    await page.waitForTimeout(100);
    const smallModal = await rdpModal.boundingBox();
    await page.locator('#rdp-resolution').selectOption('1920x1080');
    await page.waitForTimeout(100);
    const largeModal = await rdpModal.boundingBox();
    assert.ok(largeModal.width > smallModal.width, 'Preset must resize the browser modal as well as the remote desktop');
    assert.ok(largeModal.width <= 1440 - 32 && largeModal.height <= 960 - 32, 'Modal must stay within the viewport');
    assert.ok(await page.locator('#rdp-shortcut').isDisabled(), 'Keys must not be sent while disconnected');
    const requested = page.waitForRequest(request => request.url().includes('/rdp-session?width=1920&height=1080'));
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await requested;
    await page.screenshot({ path: path.join(directory, '1440-rdp-controls.png'), fullPage: true });
    await page.reload({ waitUntil: 'networkidle' });
    await page.setViewportSize({ width: 1440, height: 960 });
    await page.goto(origin + '/orchestration', { waitUntil: 'networkidle' });
    await page.evaluate(() => {
      for (const [key, value] of Object.entries({ '--app-bg-color': '#111827', '--text-color': '#e2e8f0', '--text-color-secondary': '#94a3b8', '--border-color': '#334155', '--header-bg-color': '#1e293b' })) document.documentElement.style.setProperty(key, value);
    });
    await page.screenshot({ path: path.join(directory, '1440-dark-orchestration.png'), fullPage: true });
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

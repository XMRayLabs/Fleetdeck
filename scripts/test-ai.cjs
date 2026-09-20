// No external API or real SSH connections: provider/SSH boundaries are replaced below.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');
const { randomBytes } = require('node:crypto');
const backendRequire = createRequire(path.resolve(__dirname, '../packages/backend/package.json'));
const root = path.resolve(__dirname, '../packages/backend/dist');
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'fleetdeck-ai-test-'));
process.env.DATA_DIR = temporary;
process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
process.env.SESSION_SECRET = randomBytes(32).toString('hex');
const { redact, redactValue } = require(path.join(root, 'ai/redact'));
const provider = require(path.join(root, 'ai/provider'));
const realAskProvider = provider.askProvider;
for (const [input, secret] of [
  ['password="hello world"', 'hello world'], ['{"api_key":"escaped\\\"value"}', 'escaped'],
  ['Authorization: Bearer abc123', 'abc123'], ['Proxy-Authorization: Basic dXNlcjpwYXNz', 'dXNlcjpwYXNz'],
  ['{"Authorization":"Bearer json-header-secret"}', 'json-header-secret'], ['{"Cookie":"session=json-cookie-secret"}', 'json-cookie-secret'],
  ['ssh://user:secret123@example.com', 'secret123'],
  ['Cookie: sid=abc; other=xyz', 'xyz'], ['Set-Cookie: secret=abc; Path=/', 'abc'],
  ['DATABASE_URL=postgres://user:secret123@db/app', 'secret123'], ['https://user:secret123@example.com', 'secret123'],
  ['curl --token "one two"', 'one two'], ['sshpass -p hunter2 ssh host', 'hunter2'],
  ['-----BEGIN PRIVATE KEY-----\nTOPSECRET\n-----END PRIVATE KEY-----', 'TOPSECRET'],
  ['-----BEGIN CERTIFICATE-----\nTOPSECRET', 'TOPSECRET'], ['sk-abcdefghijklmnop', 'abcdefghijklmnop'],
  ['access_token=hidden&x=1', 'hidden'], ['eyJabc.def.signature', 'eyJabc'],
]) assert.ok(!redact(input).includes(secret), `Must redact ${input.split(/[:= ]/)[0]}`);
const quoted = 'secret"with\\escapes';
assert.equal(redact('a ' + quoted + ' b', [quoted]), 'a [REDACTED] b');
assert.equal(redact('sshd: connection timed out on port 22'), 'sshd: connection timed out on port 22');
assert.equal(JSON.parse(JSON.stringify(redactValue({ message: quoted, password: 'another' }, [quoted]))).password, '[REDACTED]');
for (const ip of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '172.16.0.1', '192.168.1.1', '100.64.1.1', '198.18.0.1', '::1', '::ffff:127.0.0.1', 'fe80::1', 'fc00::1', '2001:db8::1', '2002:7f00:1::']) assert.equal(provider.publicAddress(ip), false, ip);
for (const ip of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111']) assert.equal(provider.publicAddress(ip), true, ip);
for (const base of ['http://example.com', 'https://u:p@example.com', 'https://example.com?q=1', 'https://example.com:8080']) assert.throws(() => provider.endpoint(base));
assert.equal(provider.endpoint('https://example.com/v1/').href, 'https://example.com/v1/chat/completions');
console.log('PASS AI redaction and provider address policy');

const dbApi = require(path.join(root, 'database/connection'));
const { encrypt, decrypt } = require(path.join(root, 'utils/crypto'));
const orchestration = require(path.join(root, 'orchestration/orchestration.service'));
const originalJobs = { list: orchestration.listJobs, detail: orchestration.getJobDetail, cancel: orchestration.cancelJob };
let requestContent = ''; let executed; let cancelled = false;
provider.askProvider = async (_base, _key, _model, content) => {
  requestContent = content;
  return JSON.stringify({ analysis: 'Check disk. password=do-not-display', commands: ['df -h', 'uname -a'] });
};
orchestration.createCommandJob = async (input, user) => { executed = { input, user }; return 'fixture-job'; };
orchestration.getJobDetail = async () => ({ status: 'success', targets: [{ stdout: 'token=never-display', error: null }] });
orchestration.cancelJob = async () => { cancelled = true; };
const express = backendRequire('express');
const app = express(); app.use(express.json());
// Authentication fixture only, not included in production code.
app.use((req, _res, next) => { req.session = { userId: Number(req.get('fixture-user')) || undefined, username: 'fixture', requiresTwoFactor: req.get('fixture-2fa') === 'yes' }; next(); });
app.use('/ai', require(path.join(root, 'ai/ai.routes')).default);
let server; let database;
(async () => {
  const dns = require('node:dns/promises'); const https = require('node:https'); const { EventEmitter } = require('node:events');
  const originalLookup = dns.lookup; const originalRequest = https.request;
  let records = [{ address: '127.0.0.1', family: 4 }]; let calls = 0; let status = 200; let oversized = false;
  dns.lookup = async () => records;
  https.request = (url, options, callback) => {
    calls++;
    assert.equal(url.href, 'https://fixture.example/v1/chat/completions');
    options.lookup('fixture.example', {}, (_error, address) => assert.equal(address, '8.8.8.8', 'DNS must remain pinned'));
    options.lookup('fixture.example', { all: true }, (_error, values) => assert.equal(values[0].address, '8.8.8.8'));
    assert.equal(options.rejectUnauthorized, undefined, 'Must not disable TLS verification');
    const req = new EventEmitter();
    req.destroy = error => { req.emit('error', error); req.emit('close'); };
    req.end = body => {
      assert.equal(JSON.parse(body).messages.length, 2);
      queueMicrotask(() => {
        const response = new EventEmitter(); response.statusCode = status;
        callback(response);
        response.emit('data', Buffer.from(oversized ? 'x'.repeat(256001) : JSON.stringify({ choices: [{ message: { content: 'fixture' } }] })));
        response.emit('end'); req.emit('close');
      });
    };
    return req;
  };
  try {
    await assert.rejects(realAskProvider('https://fixture.example/v1', 'key', 'model', 'logs'));
    assert.equal(calls, 0, 'Private DNS must be rejected before network use');
    records = [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }];
    await assert.rejects(realAskProvider('https://fixture.example/v1', 'key', 'model', 'logs')); assert.equal(calls, 0);
    records = [{ address: '8.8.8.8', family: 4 }];
    assert.equal(await realAskProvider('https://fixture.example/v1', 'key', 'model', 'logs'), 'fixture');
    status = 302; await assert.rejects(realAskProvider('https://fixture.example/v1', 'key', 'model', 'logs'), /HTTP 302/);
    assert.equal(calls, 2, 'Redirect must not issue a follow-up request');
    status = 200; oversized = true; await assert.rejects(realAskProvider('https://fixture.example/v1', 'key', 'model', 'logs'));
    console.log('PASS AI transport: private/mixed DNS blocked, DNS pinned, redirects rejected, oversized response rejected');
  } finally { dns.lookup = originalLookup; https.request = originalRequest; }
  database = await dbApi.getDbInstance();
  await dbApi.runDb(database, 'INSERT INTO users (id,username,hashed_password) VALUES (1,?,?)', ['fixture', 'not-a-login-hash']);
  await dbApi.runDb(database, 'INSERT INTO connections (id,name,type,host,port,username,auth_method,encrypted_password) VALUES (1,?,?,?,?,?,?,?)', ['fixture', 'SSH', '192.0.2.1', 22, 'root', 'password', encrypt(quoted)]);
  server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const url = `http://127.0.0.1:${server.address().port}/ai`;
  const call = async (method, route, data, user = 1, headers = {}) => {
    const r = await fetch(url + route, { method, headers: { 'Content-Type': 'application/json', 'fixture-user': String(user), ...headers }, body: data ? JSON.stringify(data) : undefined });
    assert.notEqual(r.status, 429, 'Test must remain under rate limit');
    return { status: r.status, body: await r.json() };
  };
  assert.equal((await call('GET', '/config', null, 0)).status, 401);
  assert.equal((await call('GET', '/config', null, 1, { 'fixture-2fa': 'yes' })).status, 401);
  const config = { base: 'https://example.com/v1', model: 'fixture-model', apiKey: 'fixture-api-key-12345' };
  assert.equal((await call('PUT', '/config', config)).status, 200);
  const stored = await dbApi.getDb(database, 'SELECT encrypted_config FROM ai_user_config WHERE user_id=1');
  assert.ok(!stored.encrypted_config.includes(config.apiKey));
  assert.equal(JSON.parse(decrypt(stored.encrypted_config)).key, config.apiKey);
  const publicConfig = await call('GET', '/config');
  assert.equal(publicConfig.body.hasKey, true); assert.ok(!JSON.stringify(publicConfig).includes(config.apiKey));
  assert.equal((await call('GET', '/config', null, 2)).body.hasKey, false);
  assert.equal((await call('PUT', '/config', { ...config, base: 'https://new.example.com/v1', apiKey: '' })).status, 400);
  assert.equal((await call('POST', '/preview', { task: 'x', context: 'x'.repeat(64001), targetIds: [] })).status, 400);
  const previewData = { task: 'diagnose', context: quoted + '\nTOKEN=secret-log-value\n' + config.apiKey, targetIds: [1] };
  const preview = (await call('POST', '/preview', previewData)).body;
  assert.ok(preview.previewId);
  assert.ok(!preview.content.includes('secret-log-value')); assert.ok(!preview.content.includes(config.apiKey));
  assert.ok(!JSON.parse(preview.content).logs.includes(quoted));
  assert.equal(requestContent, '', 'Preview must not contact provider');
  assert.equal((await call('POST', '/execute', { proposalId: preview.previewId, confirm: true })).status, 400);
  assert.equal((await call('POST', '/analyze', { previewId: preview.previewId })).status, 400);
  assert.equal((await call('POST', '/analyze', { previewId: preview.previewId, confirm: true }, 2)).status, 400);
  const answer = (await call('POST', '/analyze', { previewId: preview.previewId, confirm: true })).body;
  assert.equal(requestContent, preview.content); assert.ok(!answer.analysis.includes('do-not-display'));
  assert.ok(answer.proposalId);
  assert.equal((await call('POST', '/execute', { proposalId: answer.proposalId })).status, 400);
  assert.equal((await call('POST', '/execute', { proposalId: answer.proposalId, confirm: true }, 2)).status, 400);
  assert.equal((await call('POST', '/execute', { proposalId: answer.proposalId, confirm: true, targetIds: [99], commands: ['malicious substitution'], ephemeralCredentials: { 1: { password: 'transient-value' } } })).status, 202);
  assert.deepEqual(executed.input.targetIds, [1]); assert.deepEqual(executed.input.commands, ['df -h', 'uname -a']);
  assert.ok(executed.input.redactOutput); assert.ok(executed.input.redactedValues.includes('transient-value')); assert.equal(executed.user, 1);
  assert.equal((await call('POST', '/execute', { proposalId: answer.proposalId, confirm: true })).status, 400);
  const job = await call('GET', '/jobs/fixture-job');
  assert.equal(job.status, 200); assert.ok(!JSON.stringify(job).includes('never-display'));
  assert.equal((await call('GET', '/jobs/fixture-job', null, 2)).status, 400);
  assert.equal((await call('POST', '/jobs/fixture-job/cancel', {})).status, 200); assert.ok(cancelled);
  const preview2 = (await call('POST', '/preview', previewData)).body;
  const answer2 = (await call('POST', '/analyze', { previewId: preview2.previewId, confirm: true })).body;
  await dbApi.runDb(database, 'UPDATE connections SET host=? WHERE id=1', ['192.0.2.2']);
  assert.equal((await call('POST', '/execute', { proposalId: answer2.proposalId, confirm: true })).status, 400);
  const events = await call('GET', '/events');
  assert.ok(!JSON.stringify(events).includes('diagnose')); assert.ok(!JSON.stringify(events).includes(quoted));
  assert.equal((await call('DELETE', '/config')).status, 200);
  assert.equal((await call('GET', '/config')).body.hasKey, false);
  // AI job ownership must hold through the general orchestration API as well.
  await dbApi.runDb(database, `INSERT INTO orchestration_jobs (id,name,type,status,target_count,concurrency,timeout_seconds,stop_on_error,encrypted_payload,payload_summary,created_by,created_at,updated_at)
    VALUES ('private-ai-job','fixture','command','queued',1,2,120,1,?,?,1,0,0)`, [encrypt(JSON.stringify({ kind: 'command', commands: ['df -h'], recordOutput: true, redactOutput: true })), JSON.stringify({ aiRestricted: true })]);
  assert.equal(await originalJobs.detail('private-ai-job', 2), null);
  assert.ok(await originalJobs.detail('private-ai-job', 1));
  assert.equal((await originalJobs.list(50, 2)).length, 0);
  assert.equal((await originalJobs.list(50, 1)).length, 1);
  assert.equal(await originalJobs.cancel('private-ai-job', 2), false);
  console.log('PASS AI ownership also enforced on shared orchestration job services');
  console.log('PASS AI routes: encrypted config, authentication/2FA, redacted preview, dual confirmations, ownership, immutable targets/commands, replay denial, configuration invalidation, output redaction, cancellation and metadata-only history');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  if (database) await new Promise(resolve => database.close(resolve));
  if (path.dirname(temporary) === os.tmpdir() && path.basename(temporary).startsWith('fleetdeck-ai-test-')) fs.rmSync(temporary, { recursive: true, force: true });
});

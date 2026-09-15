const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require(require.resolve('typescript', { paths: [path.join(__dirname, '../packages/frontend')] }));
const vm = require('node:vm');
const source = fs.readFileSync(path.join(__dirname, '../packages/frontend/src/utils/connectionError.ts'), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
const context = { exports: {} };
vm.runInNewContext(output, context);
const { connectionError } = context.exports;
for (const raw of ['All configured authentication methods failed', 'Timed out while waiting for handshake', 'connect ECONNREFUSED 192.0.2.1:22', 'connect ENETUNREACH 2001:db8::1:22']) {
  assert.equal(connectionError(raw, 'unknown'), raw);
  assert.equal(connectionError({ error: raw }, 'unknown'), raw);
  assert.equal(connectionError({ message: raw }, 'unknown'), raw);
}
assert.equal(connectionError({ code: 'ETIMEDOUT', message: 'Connection timeout' }, 'unknown'), 'ETIMEDOUT: Connection timeout');
assert.equal(connectionError({ password: 'must-not-render' }, 'unknown'), 'unknown');
console.log('PASS SSH error strings, object payloads, codes and credential exclusion');

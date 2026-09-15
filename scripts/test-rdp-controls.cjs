const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require(require.resolve('typescript', { paths: [path.join(__dirname, '../packages/frontend')] }));
const source = fs.readFileSync(path.join(__dirname, '../packages/frontend/src/utils/rdpControls.ts'), 'utf8');
const context = { exports: {} };
vm.runInNewContext(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText, context);
const { rdpShortcuts, rdpResolutions, sendRdpShortcut } = context.exports;
assert.equal(rdpResolutions.length, 6);
for (const preset of rdpResolutions) assert.match(preset, /^\d+x\d+$/);
for (const shortcut of rdpShortcuts) {
  const events = [];
  sendRdpShortcut((pressed, key) => events.push([pressed, key]), shortcut.keys);
  const keys = Array.from(shortcut.keys);
  assert.deepEqual(events, [...keys.map(key => [1, key]), ...keys.reverse().map(key => [0, key])]);
}
const cad = rdpShortcuts.find(item => item.label === 'Ctrl+Alt+Delete');
assert.deepEqual(Array.from(cad.keys), [65507, 65513, 65535]);
const events = [];
assert.throws(() => sendRdpShortcut((pressed, key) => {
  events.push([pressed, key]);
  if (pressed && key === 2) throw new Error('send failed');
}, [1, 2]));
assert.deepEqual(events.slice(-2), [[0, 2], [0, 1]]);
console.log('PASS RDP presets, X11 keysyms, reverse release and failure cleanup');

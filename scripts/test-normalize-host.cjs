const assert = require('node:assert/strict');
const { normalizeHost } = require('../packages/backend/dist/utils/normalizeHost.js');
for (const [input, expected] of [
  ['2001:df6:11c0:ec44:0000:0000:0000:0001', '2001:df6:11c0:ec44::1'],
  ['2001:0DB8:0000:0000:0001:0000:0000:0001', '2001:db8::1:0:0:1'],
  ['0:0:0:0:0:0:0:0', '::'], ['0:0:0:0:0:0:0:1', '::1'],
  ['2001:db8:0:1:2:3:4:5', '2001:db8:0:1:2:3:4:5'],
  ['[2001:0DB8::0001]', '2001:db8::1'],
  ['fe80:0:0:0:0:0:0:1%eth0', 'fe80::1%eth0'],
  ['192.0.2.1', '192.0.2.1'], ['Server.Example', 'Server.Example'],
  ['root@2001:db8::1:22', 'root@2001:db8::1:22'],
  ['[2001:db8::1]:22', '[2001:db8::1]:22'], ['bad::ipv6', 'bad::ipv6'],
]) assert.equal(normalizeHost(input), expected, input);
console.log('PASS IPv6 canonicalization, zero-run ties, scoped addresses, IPv4/DNS preservation');

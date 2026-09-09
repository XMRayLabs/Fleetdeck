import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// Run in the final image, as its non-root user, with an isolated data directory.
const data = mkdtempSync(join(tmpdir(), 'fleetdeck-smoke-'));
const child = spawn(process.execPath, ['dist/index.js'], {
  stdio: 'inherit',
  env: {
    ...process.env,
    DATA_DIR: data,
    PORT: '19381',
    NODE_ENV: 'production',
    ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    SESSION_SECRET: randomBytes(64).toString('hex'),
    REMOTE_GATEWAY_SHARED_SECRET: randomBytes(48).toString('hex'),
  },
});
let exited = false;
const stopped = new Promise(resolve => child.once('exit', () => { exited = true; resolve(); }));
try {
  let healthy = false;
  for (let i = 0; i < 60; i++) {
    if (exited) throw new Error('Backend exited before becoming healthy');
    try {
      const response = await fetch('http://127.0.0.1:19381/api/v1/status', { signal: AbortSignal.timeout(1000) });
      healthy = response.ok && (await response.json()).service === 'fleetdeck-backend';
    } catch {}
    if (healthy) break;
    await delay(500);
  }
  if (!healthy) throw new Error('Backend health check timed out');
  if (!existsSync(join(data, 'fleetdeck.db'))) throw new Error('Database did not use DATA_DIR');
  if (!existsSync(join(data, 'sessions'))) throw new Error('Sessions did not use DATA_DIR');
  console.log('Backend startup, database initialization and DATA_DIR checks passed');
} finally {
  child.kill('SIGTERM');
  await Promise.race([stopped, delay(12000)]);
  if (!exited) { child.kill('SIGKILL'); await stopped; }
  rmSync(data, { recursive: true, force: true });
}

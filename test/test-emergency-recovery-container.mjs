import assert from 'node:assert/strict';
import { access, mkdir, writeFile, readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { uptime } from 'node:os';
const exec = promisify(execFile);
await access('/.dockerenv'); assert.equal(process.getuid(), 0, 'Disposable container only');
const root = '/var/lib/naiskos/recovery';
await mkdir(root, { recursive: true });
await writeFile('/run/naiskos-kiosk-context.json', '{}', { mode: 0o600 });
await writeFile('/usr/bin/systemctl', '#!/bin/sh\necho "$*" >> /tmp/systemctl-actions\n[ "$1" != is-system-running ] || echo running\nexit 0\n', { mode: 0o755 });
const bootId = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
const file = `${root}/state.json`;
await writeFile(file, JSON.stringify({ schemaVersion: 1, events: [], bootId, uptimeMs: uptime() * 1000,
  cooldownMs: 0, unhealthySince: 0, attempts: 3, agentAttempts: 1 }));
const server = createServer((req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ ready: false, intentionalExit: false, quiesceId: 'abandoned', viewer: {} }));
});
await new Promise(resolve => server.listen(8080, '127.0.0.1', resolve));
const run = () => exec('/usr/bin/flock', ['-n', '/run/naiskos-system-maintenance.lock',
  '/usr/bin/flock', '-n', '/run/naiskos-release-activate.lock', process.execPath,
  '/workspace-agent/deploy/naiskos-kiosk-control.mjs', 'recover'], { timeout: 20_000,
  env: { PATH: process.env.PATH } });
try {
  await run();
  let state = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(state.incident.status, 'reboot-requested');
  assert.equal(state.rebootRequestAttempts, 1);
  assert.equal(state.events.at(-1).status, 'reboot-requested');
  assert.match(await readFile('/run/systemd/system/shutdown.target.d/90-naiskos-emergency.conf', 'utf8'), /JobTimeoutSec=180s/);
  await access('/run/naiskos-emergency-reboot.pending');
  await run();
  assert.equal((await readFile('/tmp/systemctl-actions', 'utf8')).split('\n').filter(x => x === 'reboot').length, 1);
  // Resume intent after a supervisor crash, but never loop unboundedly.
  state.rebootRequestAt = 0; await writeFile(file, JSON.stringify(state));
  await run(); state = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(state.rebootRequestAttempts, 2);
  state.rebootRequestAt = 0; await writeFile(file, JSON.stringify(state));
  await run(); state = JSON.parse(await readFile(file, 'utf8'));
  assert.equal(state.incident.status, 'failed');
  await assert.rejects(access('/run/naiskos-emergency-reboot.pending'));
  assert.equal((await readFile('/tmp/systemctl-actions', 'utf8')).split('\n').filter(x => x === 'reboot').length, 2);
  console.log('ok: emergencia root, locks, persistencia offline, deadline efímero y límite de reentrega; reboot simulado');
} finally { await new Promise(resolve => server.close(resolve)); }

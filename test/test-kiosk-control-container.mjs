import assert from 'node:assert/strict';
import { access, mkdir, readFile, writeFile, readlink } from 'node:fs/promises';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createServer } from 'node:http';
const exec = promisify(execFile);
await access('/.dockerenv');
assert.equal(process.getuid(), 0, 'Sólo en contenedor desechable root');
const source = '/workspace-agent/deploy/naiskos-kiosk-control.mjs';
const launcher = '/opt/naiskos/bin/start-naiskos-kiosk';
await mkdir('/opt/naiskos/bin', { recursive: true });
await exec('useradd', ['-m', '-u', '1234', 'kiosk']);
await writeFile('/tmp/browser-fixture.mjs', 'setInterval(() => {}, 1000);');
await writeFile(launcher, `#!/bin/bash
/usr/bin/setsid /bin/bash -c 'exec -a /usr/lib/chromium/chromium /usr/local/bin/node /tmp/browser-fixture.mjs --kiosk --user-data-dir=/home/kiosk/.local/state/naiskos/chromium' &
wait
`, { mode: 0o755 });
let commands = 0;
const reports = [];
const api = createServer(async (req, res) => {
  res.setHeader('content-type', 'application/json');
  if (req.url.endsWith('release-events')) {
    let body = ''; for await (const chunk of req) body += chunk;
    reports.push(JSON.parse(body)); res.statusCode = 202; res.end(JSON.stringify({ accepted: true }));
  } else if (req.method === 'POST') { commands++; res.end(JSON.stringify({ quiesceId: 'stop-nonce' })); }
  else res.end(JSON.stringify({ schemaVersion: 1, ready: true, agentBuildId: '20260915-previous',
    viewer: { connected: true, playback: { buildId: '20260915-previous', uiReady: true, quiescedFor: 'stop-nonce' } } }));
});
await new Promise(resolve => api.listen(8080, '127.0.0.1', resolve));
const child = spawn(launcher, [], { uid: 1234, gid: 1234, env: {
  HOME: '/home/kiosk', USER: 'kiosk', WAYLAND_DISPLAY: 'wayland-0', XDG_RUNTIME_DIR: '/run/user/1234',
}, stdio: 'ignore' });
const unrelated = spawn('/bin/sleep', ['120'], { stdio: 'ignore' });
const run = async command => exec(process.execPath, [source, command], { timeout: 30_000 });
try {
  let current;
  for (let n = 0; n < 40; n++) {
    current = JSON.parse((await run('status')).stdout);
    if (current.browserLive) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(current.browserLive, true);
  assert.equal(current.launcherPresent, true);
  process.kill(child.pid, 'SIGSTOP');
  assert.equal(JSON.parse((await run('status')).stdout).launcherPresent, true);
  await assert.rejects(run('start'), /anterior sigue|anterior siguen/);
  process.kill(child.pid, 'SIGCONT');
  await run('stop');
  assert.equal(commands, 1, 'libera antes de terminar procesos');
  assert.equal(JSON.parse((await run('status')).stdout).launcherPresent, false);
  process.kill(unrelated.pid, 0);
  const context = JSON.parse(await readFile('/run/naiskos-kiosk-context.json', 'utf8'));
  assert.equal(context.uid, 1234);
  assert.ok(context.env.includes('WAYLAND_DISPLAY=wayland-0'));
  // Simulate systemd only: check the new launcher receives its original desktop context.
  await writeFile('/usr/bin/systemctl', '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await writeFile('/usr/bin/systemd-run', '#!/bin/sh\nprintf "%s\\n" "$@" > /tmp/unit-args\n', { mode: 0o755 });
  await run('start');
  const args = await readFile('/tmp/unit-args', 'utf8');
  assert.match(args, /--uid=kiosk/);
  assert.match(args, /--setenv=WAYLAND_DISPLAY=wayland-0/);
  assert.match(args, /KillMode=control-group/);
  // Exercise rollback orchestration: swapping the link alone is not success.
  // The old build must have a live owned browser and two functional samples.
  await writeFile('/usr/bin/systemd-run', `#!/bin/sh
/usr/bin/setsid /usr/sbin/runuser -u kiosk -- ${launcher} >/dev/null 2>&1 &
exit 0
`, { mode: 0o755 });
  await mkdir('/var/lib/naiskos/updates', { recursive: true });
  await mkdir('/opt/naiskos/releases/20260915-previous', { recursive: true });
  await writeFile('/var/lib/naiskos/updates/observation.json', JSON.stringify({
    phase: 'rollback', releaseId: '20260916-broken', previous: '20260915-previous',
    campaignId: '11111111-1111-4111-8111-111111111111', migrations: [],
  }));
  await exec(process.execPath, ['/workspace-agent/deploy/naiskos-release-runtime.mjs', 'tick'], { timeout: 30_000 });
  assert.equal(await readlink('/opt/naiskos/current'), '/opt/naiskos/releases/20260915-previous');
  assert.equal(JSON.parse((await run('status')).stdout).browserLive, true);
  assert.deepEqual(reports.map(report => report.status), ['rolled_back']);
  await assert.rejects(access('/var/lib/naiskos/updates/observation.json'));
  await run('stop');
  console.log('ok: procesos reales, quiesce, cierre acotado, dueño detenido y contexto gráfico; systemd simulado');
  console.log('ok: rollback sólo confirmado después de comprobar la versión anterior y un navegador vivo');
} finally {
  try { child.kill('SIGKILL'); } catch {}
  unrelated.kill('SIGKILL');
  await new Promise(resolve => api.close(resolve));
}

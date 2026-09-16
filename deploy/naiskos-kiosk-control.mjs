#!/opt/node24/bin/node
import { readdir, readFile, readlink, writeFile, rename, stat } from 'node:fs/promises';
import { execFile as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';

const exec = promisify(execCallback);
const launcher = '/opt/naiskos/bin/start-naiskos-kiosk';
const contextFile = '/run/naiskos-kiosk-context.json';
const unit = 'naiskos-kiosk-session.service';
const base = 'http://127.0.0.1:8080';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function parseProcess(pid, raw, argv, uid, exe = null) {
  const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
  return { pid, uid, exe, state: fields[0], parent: Number(fields[1]), group: Number(fields[2]),
    start: fields[19], threads: Number(fields[17]), argv: argv.split('\0').filter(Boolean) };
}
export function live(p) { return !!p && !['Z', 'X', 'D', 'T', 't'].includes(p.state); }
export function isLauncher(p) {
  return p.argv[0] === launcher || (p.argv[1] === launcher && /\/(?:ba|da|a)?sh$/.test(p.argv[0] ?? ''));
}
export function chromiumArguments(p) {
  // Chromium on Raspberry Pi rewrites /proc/cmdline into a single argument.
  // Verify the executable independently, then handle both representations.
  if (!p.exe?.replace(/ \(deleted\)$/, '').endsWith('/chromium')) return null;
  return p.argv.length === 1 ? p.argv[0].trim().split(/\s+/) : p.argv;
}
export function isKioskBrowser(p) {
  const args = chromiumArguments(p);
  return !!args && args.includes('--kiosk') && !args.some(a => a.startsWith('--type='));
}
export function descendants(processes, roots) {
  const ids = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const p of processes) if (ids.has(p.parent) && !ids.has(p.pid)) { ids.add(p.pid); changed = true; }
  }
  return processes.filter(p => ids.has(p.pid));
}
export function ownedTree(all, owner) {
  const tree = descendants(all, [owner.pid]);
  const groups = new Set(tree.filter(p => p.group !== owner.group && p.group > 1 &&
    (p.argv.some(a => a.endsWith('/systemd-inhibit')) || chromiumArguments(p))).map(p => p.group));
  return all.filter(p => p.uid === owner.uid && (tree.some(t => t.pid === p.pid) || groups.has(p.group)));
}
export function stillRunning(p) { return p.state !== 'X' && (p.state !== 'Z' || p.threads > 1); }
async function processes() {
  const entries = await readdir('/proc');
  const all = await Promise.all(entries.filter(x => /^\d+$/.test(x)).map(async id => {
    try {
      const [raw, argv, details, exe] = await Promise.all([
        readFile(`/proc/${id}/stat`, 'utf8'), readFile(`/proc/${id}/cmdline`, 'utf8'), stat(`/proc/${id}`),
        readlink(`/proc/${id}/exe`).catch(() => null),
      ]);
      return parseProcess(Number(id), raw, argv, details.uid, exe);
    } catch { return null; }
  }));
  return all.filter(Boolean);
}
async function api(route, method = 'GET') {
  const response = await fetch(`${base}${route}`, { method,
    headers: { 'x-naiskos-request': 'release-activator' }, signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${route}`);
  if (response.status === 204) return null;
  return response.json(); // An SPA fallback must never be interpreted as healthy.
}
async function remember(owner) {
  const environment = (await readFile(`/proc/${owner.pid}/environ`, 'utf8')).split('\0');
  const allowed = new Set(['HOME', 'USER', 'LOGNAME', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR',
    'DBUS_SESSION_BUS_ADDRESS', 'XAUTHORITY', 'XDG_STATE_HOME', 'LANG', 'NAISKOS_KIOSK_URL', 'NAISKOS_USE_INHIBIT']);
  const env = environment.filter(entry => allowed.has(entry.split('=')[0]));
  const passwd = (await readFile('/etc/passwd', 'utf8')).split('\n').map(x => x.split(':'))
    .find(x => Number(x[2]) === owner.uid);
  if (!passwd || owner.uid === 0) throw new Error('Usuario gráfico inválido');
  const context = { uid: owner.uid, user: passwd[0], env };
  const temporary = `${contextFile}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(context), { mode: 0o600 });
  await rename(temporary, contextFile);
  return context;
}
async function context() {
  const details = await stat(contextFile);
  if (details.uid !== 0 || (details.mode & 0o077)) throw new Error('Contexto del kiosco inseguro');
  return JSON.parse(await readFile(contextFile, 'utf8'));
}
export async function status({ captureContext = true } = {}) {
  const all = await processes();
  // A stopped or uninterruptible owner still owns the browser. Never mistake
  // it for an absent launcher and start a second instance over its children.
  const owners = all.filter(p => isLauncher(p) && stillRunning(p));
  if (owners.length > 1) throw new Error('Más de un lanzador Naiskos');
  if (captureContext && owners[0] && process.getuid() === 0) await remember(owners[0]);
  const tree = owners[0] ? ownedTree(all, owners[0]) : [];
  const browsers = tree.filter(isKioskBrowser);
  const orphans = owners.length ? [] : all.filter(p => stillRunning(p) &&
    chromiumArguments(p)?.some(a => a.startsWith('--user-data-dir=') && a.endsWith('/naiskos/chromium')));
  return { launcherPresent: owners.length === 1, browserLive: browsers.length === 1 && browsers.some(live),
    orphanedProcesses: orphans.map(p => p.pid),
    browserSuspended: browsers.some(p => ['T', 't'].includes(p.state)),
    browserPid: browsers.find(live)?.pid ?? null, processes: tree };
}
async function signalTracked(targets, signal) {
  const all = await processes();
  for (const target of targets) {
    const current = all.find(p => p.pid === target.pid && p.start === target.start && p.uid === target.uid);
    if (current) { try { process.kill(current.pid, signal); } catch (e) { if (e.code !== 'ESRCH') throw e; } }
  }
}
async function survivors(targets) {
  const all = await processes();
  return all.filter(p => targets.some(t => t.pid === p.pid && t.start === p.start) && stillRunning(p));
}
async function waitStopped(targets, milliseconds) {
  const deadline = performance.now() + milliseconds;
  while (performance.now() < deadline) {
    if (!(await survivors(targets)).length) return true;
    await sleep(200);
  }
  return !(await survivors(targets)).length;
}
async function quiesce() {
  try {
    const command = await api('/api/v1/system/quiesce', 'POST');
    const deadline = performance.now() + 7_000;
    while (performance.now() < deadline) {
      const runtime = await api('/api/v1/viewer/runtime');
      if (runtime.viewer?.connected && runtime.viewer.playback?.quiescedFor === command.quiesceId) return;
      await sleep(250);
    }
    console.error('Kiosco: agotado el plazo de liberación de video; cierre acotado');
  } catch (e) { console.error(`Kiosco: liberación no disponible (${e.message})`); }
}
async function stop() {
  const current = await status();
  if (!current.launcherPresent) return;
  await quiesce();
  // Freeze only the launcher so its restart loop cannot race the controlled stop.
  const owner = current.processes.find(isLauncher);
  await signalTracked([owner], 'SIGSTOP');
  // Snapshot again after quiescing; include GPU/renderer descendants created meanwhile.
  const tree = ownedTree(await processes(), owner);
  const children = tree.filter(p => p.pid !== owner.pid);
  await signalTracked(children, 'SIGTERM');
  if (!await waitStopped(children, 8_000)) {
    await signalTracked(children, 'SIGKILL');
    if (!await waitStopped(children, 5_000)) {
      throw new Error('Procesos del kiosco bloqueados en kernel; no se abrirá otra instancia');
    }
  }
  await signalTracked([owner], 'SIGTERM');
  await signalTracked([owner], 'SIGCONT');
  if (!await waitStopped([owner], 2_000)) {
    await signalTracked([owner], 'SIGKILL');
    if (!await waitStopped([owner], 2_000)) throw new Error('El lanzador no terminó');
  }
}
async function start() {
  const current = await status();
  if (current.launcherPresent || current.orphanedProcesses.length) {
    throw new Error('El lanzador o procesos huérfanos del kiosco anterior siguen presentes');
  }
  const saved = await context();
  await api('/api/v1/system/quiesce', 'DELETE').catch(() => undefined);
  // A transient unit owns the same existing launcher, with the captured graphical context.
  await exec('/usr/bin/systemctl', ['stop', unit], { timeout: 20_000 }).catch(() => undefined);
  await exec('/usr/bin/systemctl', ['reset-failed', unit], { timeout: 5_000 }).catch(() => undefined);
  await exec('/usr/bin/systemd-run', ['--quiet', '--collect', '--unit=naiskos-kiosk-session',
    `--uid=${saved.user}`, '--property=KillMode=control-group', '--property=TimeoutStopSec=15s',
    ...saved.env.map(value => `--setenv=${value}`), launcher], { timeout: 10_000 });
}
export async function main(command) {
  if (command === 'status') return status();
  if (process.getuid() !== 0) throw new Error('El control del kiosco requiere root');
  if (command === 'watchdog') {
    let lastGood = performance.now();
    let attempts = 0;
    let healthySince = null;
    while (true) {
      await sleep(15_000);
      try {
        const current = await status();
        const runtime = await api('/api/v1/viewer/runtime');
        if (runtime.intentionalExit || current.browserSuspended) {
          lastGood = performance.now(); healthySince = null; continue;
        }
        if (runtime.ready && current.browserLive) {
          healthySince ??= performance.now();
          if (performance.now() - healthySince >= 120_000) attempts = 0;
          lastGood = performance.now(); continue;
        }
        healthySince = null;
        if (!current.launcherPresent && !await context().catch(() => null)) continue;
        if (performance.now() - lastGood < 120_000 || attempts >= 3 || runtime.quiesceId) continue;
        attempts += 1;
        lastGood = performance.now();
        await exec('/usr/bin/flock', ['-n', '/run/naiskos-release-activate.lock',
          '/opt/node24/bin/node', '/opt/naiskos/bin/naiskos-kiosk-control.mjs', 'restart'], { timeout: 60_000 });
        console.log(JSON.stringify({ event: 'kiosk.restart', attempt: attempts }));
      } catch (error) { console.error(JSON.stringify({ event: 'kiosk.watchdog', error: error.message })); }
    }
  }
  if (command === 'stop') { await stop(); return { stopped: true }; }
  if (command === 'start') { await start(); return { started: true }; }
  if (command === 'restart') { await stop(); await start(); return { restarted: true }; }
  throw new Error('Uso: naiskos-kiosk-control.mjs status|stop|start|restart');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2]).then(value => console.log(JSON.stringify(value)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}

import { describe, expect, it } from 'vitest';
// Runtime modules are shipped as plain ESM for use before/after agent replacement.
import { observe, runtimeHealthy } from '../deploy/naiskos-runtime-policy.mjs';
import { descendants, live, parseProcess, stillRunning, ownedTree, isLauncher, isKioskBrowser, chromiumArguments } from '../deploy/naiskos-kiosk-control.mjs';

const runtime = { schemaVersion: 1, ready: true, agentBuildId: 'new',
  viewer: { connected: true, playback: { buildId: 'new', uiReady: true, view: 'repose' } } };
const running = { launcherPresent: true, browserLive: true };
const initial = { observeMinutes: 60, bootId: 'boot1', lastUptime: 1000,
  observedSeconds: 0, failures: 0, lastHealthy: true };
const good = { bootId: 'boot1', uptime: 1300, healthy: true, paused: false };

describe('salud y observación funcional', () => {
  it('acepta el reposo operativo y rechaza HTTP sano sin visor o con otro build', () => {
    expect(runtimeHealthy(runtime, running, 'new')).toBe(true);
    expect(runtimeHealthy({ ok: true, state: 'ready' }, running, 'new')).toBe(false);
    expect(runtimeHealthy(runtime, { ...running, browserLive: false }, 'new')).toBe(false);
    expect(runtimeHealthy(runtime, running, 'old')).toBe(false);
    expect(runtimeHealthy({ ...runtime, viewer: { ...runtime.viewer, connected: false } }, running, 'new')).toBe(false);
  });
  it('no convierte una pérdida de red en fallo local del visor', () => {
    expect(runtimeHealthy({ ...runtime, syncState: 'offline' }, running, 'new')).toBe(true);
  });
  it('cuenta tres fallos consecutivos, no tres fallos intercalados', () => {
    let result = observe(initial, { ...good, healthy: false });
    expect(result.state.failures).toBe(1);
    result = observe(result.state, { ...good, uptime: 1600 });
    expect(result.state.failures).toBe(0);
    for (const uptime of [1900, 2200]) result = observe(result.state, { ...good, uptime, healthy: false });
    expect(result.decision).toBe('wait');
    expect(observe(result.state, { ...good, uptime: 2500, healthy: false }).decision).toBe('rollback');
  });
  it('no acredita tiempo apagado ni saltos de reloj, y concede gracia por boot', () => {
    const result = observe(initial, { ...good, bootId: 'boot2', uptime: 60 });
    expect(result.state.observedSeconds).toBe(0);
    expect(result.decision).toBe('wait');
    expect(observe(initial, { ...good, uptime: 9000 }).state.observedSeconds).toBe(0);
    expect(observe(initial, { ...good, uptime: 900 }).state.observedSeconds).toBe(0);
  });
  it('pausa la observación por salida voluntaria y exige tiempo efectivo sano', () => {
    const paused = observe(initial, { ...good, paused: true, healthy: false });
    expect(paused.state.observedSeconds).toBe(0);
    expect(paused.state.failures).toBe(0);
    expect(observe({ ...initial, observedSeconds: 3300 }, good).decision).toBe('installed');
  });
  it('no acredita el intervalo entre sesiones distintas de agente o navegador', () => {
    expect(observe({ ...initial, agentInstanceId: 'old', viewerSessionId: 'one' },
      { ...good, agentInstanceId: 'new', viewerSessionId: 'one' }).state.observedSeconds).toBe(0);
    expect(observe({ ...initial, agentInstanceId: 'one', viewerSessionId: 'old' },
      { ...good, agentInstanceId: 'one', viewerSessionId: 'new' }).state.observedSeconds).toBe(0);
  });
});

describe('selección de procesos del kiosco', () => {
  it('reconoce cmdline normal y reescrito por Chromium con executable verificado', () => {
    const exe = '/usr/lib/chromium/chromium';
    const flags = '--kiosk --user-data-dir=/home/kiosk/.local/state/naiskos/chromium http://127.0.0.1:8080/';
    expect(isKioskBrowser({ exe, argv: [exe, ...flags.split(' ')] })).toBe(true);
    expect(isKioskBrowser({ exe, argv: [`${exe} ${flags}`] })).toBe(true);
    expect(isKioskBrowser({ exe: `${exe} (deleted)`, argv: [`${exe} ${flags}`] })).toBe(true);
    expect(isKioskBrowser({ exe, argv: [`${exe} ${flags} --type=renderer`] })).toBe(false);
    expect(isKioskBrowser({ exe: '/usr/bin/node', argv: [`${exe} ${flags}`] })).toBe(false);
    expect(isKioskBrowser({ exe: null, argv: [] })).toBe(false);
    expect(chromiumArguments({ exe, argv: [`${exe} ${flags}`] })).toContain('--user-data-dir=/home/kiosk/.local/state/naiskos/chromium');
  });
  it('no confunde runuser o systemd-run con el script lanzador', () => {
    const file = '/opt/naiskos/bin/start-naiskos-kiosk';
    expect(isLauncher({ argv: ['/bin/sh', file] })).toBe(true);
    expect(isLauncher({ argv: ['/bin/bash', file] })).toBe(true);
    expect(isLauncher({ argv: ['runuser', '-u', 'kiosk', '--', file] })).toBe(false);
    expect(isLauncher({ argv: ['systemd-run', file] })).toBe(false);
  });
  it('descarta zombis, suspendidos y bloqueados, sin seleccionar otro Chromium', () => {
    expect(live({ state: 'Z' })).toBe(false);
    expect(live({ state: 'T' })).toBe(false);
    expect(live({ state: 'D' })).toBe(false);
    expect(live({ state: 'S' })).toBe(true);
    const tree = [{ pid: 1, parent: 0 }, { pid: 2, parent: 1 }, { pid: 3, parent: 2 }, { pid: 4, parent: 0 }];
    expect(descendants(tree, [1]).map((p: {pid:number}) => p.pid)).toEqual([1,2,3]);
  });
  it('lee la identidad de proceso aunque su nombre tenga espacios/paréntesis', () => {
    const fields = ['S', '10', '20', ...Array(16).fill('0'), '98765'];
    const value = parseProcess(42, `42 (nombre (hilo)) ${fields.join(' ')}`, '/bin/sh\0launcher\0', 1000);
    expect(value).toMatchObject({ pid: 42, parent: 10, group: 20, start: '98765', uid: 1000 });
  });
  it('un zombi con hilos vivos o un proceso detenido aún impiden abrir otro kiosco', () => {
    expect(stillRunning({ state: 'Z', threads: 3 })).toBe(true);
    expect(stillRunning({ state: 'Z', threads: 1 })).toBe(false);
    expect(stillRunning({ state: 'D', threads: 1 })).toBe(true);
    expect(stillRunning({ state: 'T', threads: 1 })).toBe(true);
  });
  it('incluye huérfanos del grupo Chromium pero no procesos ajenos al kiosco', () => {
    const owner = { pid: 10, parent: 1, group: 5, uid: 1000, argv: ['launcher'] };
    const all = [owner,
      { pid: 11, parent: 10, group: 11, uid: 1000, argv: ['/usr/bin/systemd-inhibit'] },
      { pid: 12, parent: 1, group: 11, uid: 1000, argv: ['/usr/lib/chromium/chromium'] },
      { pid: 13, parent: 1, group: 5, uid: 1000, argv: ['/bin/desktop'] },
      { pid: 14, parent: 1, group: 14, uid: 1000, argv: ['/usr/lib/chromium/chromium'] }];
    expect(ownedTree(all, owner).map((p: {pid:number}) => p.pid)).toEqual([10, 11, 12]);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { advanceClock, DAY, functionalProgress } from '../deploy/naiskos-recovery-policy.mjs';
import { recoveryTick, notice, flush } from '../deploy/naiskos-recovery.mjs';

function fixture() {
  let disk: any = null;
  let now = 0, boot = 'boot-a';
  let runtime: any = { ready: false, intentionalExit: false, quiesceId: 'abandoned', viewer: {} };
  let current: any = { browserLive: false, blocked: false, processes: [] };
  const io = {
    file: 'state', diagnosticFile: 'diagnostic', read: vi.fn(async () => structuredClone(disk)),
    write: vi.fn(async (file: string, value: any) => { if (file === 'state') disk = structuredClone(value); }),
    bootId: async () => boot, uptimeMs: () => now,
    runtime: vi.fn(async () => runtime), status: vi.fn(async () => current), intent: vi.fn(async () => null),
    maintenance: vi.fn(async () => false), restartAgent: vi.fn(async () => {}),
    restartViewer: vi.fn(async () => {}), reboot: vi.fn(async () => {}),
    diagnostics: vi.fn(async () => ({})), send: vi.fn(async () => [] as string[]),
  };
  return { io, tick: () => recoveryTick(io), state: () => disk,
    clock: (time: number) => { now = time; }, boot: (id: string) => { boot = id; },
    runtime: (value: any) => { runtime = value; }, current: (value: any) => { current = value; } };
}
describe('emergencia con persistencia y dependencias simuladas (nunca reinicia el host)', () => {
  it('marca abandonada no bloquea; cierre fallido persistente escala una sola vez', async () => {
    const f = fixture();
    f.io.restartViewer.mockImplementation(async () => { f.current({ blocked: true }); throw Error('D'); });
    await f.tick(); f.clock(120_000); await f.tick();
    expect(f.io.reboot).not.toHaveBeenCalled();
    f.clock(135_000); await f.tick(); expect(f.io.reboot).toHaveBeenCalledTimes(1);
    expect(f.state().cooldownMs).toBe(DAY);
    f.clock(150_000); await f.tick(); expect(f.io.reboot).toHaveBeenCalledTimes(1);
    expect(f.state().events.map((e: any) => e.status)).toEqual(['recovering', 'reboot-requested']);
  });
  it('reinicia agente antes de atribuir un fallo HTTP a Chromium', async () => {
    const f = fixture(); f.runtime(null);
    await f.tick(); f.clock(120_000); await f.tick();
    expect(f.io.restartAgent).toHaveBeenCalledTimes(1); expect(f.io.restartViewer).not.toHaveBeenCalled();
  });
  it('salida voluntaria persistida protege incluso si el agente cae', async () => {
    const f = fixture(); f.runtime(null);
    f.io.intent.mockResolvedValue({ bootId: 'boot-a', intentionalExit: true } as any);
    await f.tick(); f.clock(500_000); await f.tick();
    expect(f.io.restartAgent).not.toHaveBeenCalled(); expect(f.io.reboot).not.toHaveBeenCalled();
  });
  it('actualización excluye recuperaciones, pero permite entregar avisos', async () => {
    const f = fixture(); f.io.maintenance.mockResolvedValue(true);
    await f.tick(); f.clock(500_000); await f.tick();
    expect(f.io.restartViewer).not.toHaveBeenCalled(); expect(f.io.reboot).not.toHaveBeenCalled();
  });
  it('intentos sobreviven entre procesos y escalan tras tres recuperaciones', async () => {
    const f = fixture(); await f.tick();
    for (const time of [120_000, 240_000, 360_000, 480_000]) { f.clock(time); await f.tick(); }
    expect(f.io.restartViewer).toHaveBeenCalledTimes(3); expect(f.io.reboot).toHaveBeenCalledTimes(1);
  });
  it('sin red guarda antes de reiniciar; acuse parcial conserva el resto', async () => {
    const state: any = { events: [], bootId: 'boot-a' }; notice(state, 'recovering', 'test'); notice(state, 'failed', 'test');
    const first = state.events[0].id; const save = vi.fn();
    await flush(state, save, async () => { throw Error('offline'); }); expect(state.events).toHaveLength(2);
    await flush(state, save, async () => [first]); expect(state.events).toHaveLength(1);
    expect(state.events[0].sequence).toBe(2);
  });
  it('estado no durable impide ejecutar reinicio', async () => {
    const f = fixture(); f.io.write.mockRejectedValue(Error('ENOSPC'));
    await expect(f.tick()).rejects.toThrow('ENOSPC'); expect(f.io.reboot).not.toHaveBeenCalled();
  });
  it('preserva límite tras arranque, confirma progreso y notifica reincidencia sin bucle', async () => {
    const f = fixture(); await f.tick();
    for (const time of [120_000, 240_000, 360_000, 480_000]) { f.clock(time); await f.tick(); }
    f.boot('boot-b'); f.clock(0); await f.tick();
    expect(f.state().incident.status).toBe('verifying'); expect(f.state().cooldownMs).toBe(DAY);
    f.current({ browserLive: true });
    f.runtime({ ready: true, viewer: { playback: { sessionId: 'new', lease: { id: 'a' }, currentTime: 0, view: 'viewer' } } });
    f.clock(15_000); await f.tick(); f.clock(135_000);
    f.runtime({ ready: true, viewer: { playback: { sessionId: 'new', lease: { id: 'b' }, currentTime: 0, view: 'viewer' } } });
    await f.tick(); expect(f.state().incident.status).toBe('recovered');
    f.runtime({ ready: false }); f.clock(150_000); await f.tick();
    for (const time of [270_000, 390_000, 510_000, 630_000]) { f.clock(time); await f.tick(); }
    expect(f.state().incident.status).toBe('limited'); expect(f.io.reboot).toHaveBeenCalledTimes(1);
  });
  it('reboot rechazado produce fallo y no reintento irreversible', async () => {
    const f = fixture(); f.io.reboot.mockRejectedValue(Error('denied')); await f.tick();
    for (const time of [120_000, 240_000, 360_000, 480_000, 600_000]) { f.clock(time); await f.tick(); }
    expect(f.io.reboot).toHaveBeenCalledTimes(1); expect(f.state().events.some((e: any) => e.status === 'failed')).toBe(true);
  });
  it('salud instantánea no equivale a reproducción recuperada; reposo válido sí', () => {
    const state: any = { progress: null, healthySince: null };
    const runtime = { ready: true, viewer: { playback: { view: 'viewer', currentTime: 0 } } };
    expect(functionalProgress(state, runtime, { browserLive: true }, 0)).toBe(false);
    expect(functionalProgress(state, runtime, { browserLive: true }, 120_000)).toBe(false);
    runtime.viewer.playback.view = 'repose';
    expect(functionalProgress(state, runtime, { browserLive: true }, 120_000)).toBe(true);
  });
  it('NTP, boot distinto o contador atrás nunca restauran el permiso', () => {
    const s: any = { bootId: 'a', uptimeMs: 1000, cooldownMs: DAY };
    advanceClock(s, 'a', 500); expect(s.cooldownMs).toBe(DAY);
    advanceClock(s, 'b', 5_000_000); expect(s.cooldownMs).toBe(DAY);
    advanceClock(s, 'b', 5_001_000); expect(s.cooldownMs).toBe(DAY - 1000);
  });
  it('recomprueba salud antes del reinicio y no toca un equipo sin contexto gráfico', async () => {
    const f = fixture(); await f.tick();
    for (const time of [120_000, 240_000, 360_000]) { f.clock(time); await f.tick(); }
    f.clock(480_000);
    f.io.runtime.mockResolvedValueOnce({ ready: false }).mockResolvedValueOnce({ ready: true });
    await f.tick(); expect(f.io.reboot).not.toHaveBeenCalled();
    const g = fixture(); (g.io as any).canRecover = async () => false;
    await g.tick(); g.clock(600_000); await g.tick();
    expect(g.io.restartViewer).not.toHaveBeenCalled();
  });
  it('menú y fotos largas se verifican sin forzar transiciones; cola llena no pierde eventos', () => {
    const state: any = { progress: null, healthySince: null };
    const runtime = { ready: true, viewer: { playback: { view: 'overlay', currentTime: 0 } } };
    functionalProgress(state, runtime, { browserLive: true }, 0);
    expect(functionalProgress(state, runtime, { browserLive: true }, 120_000)).toBe(true);
    const photo: any = { ready: true, viewer: { playback: { view: 'viewer', mediaKind: 'photo', lease: { id: 'long', elapsedMs: 0 } } } };
    const s: any = { progress: null, healthySince: null };
    functionalProgress(s, photo, { browserLive: true }, 0);
    photo.viewer.playback.lease.elapsedMs = 120_000;
    expect(functionalProgress(s, photo, { browserLive: true }, 120_000)).toBe(true);
    const full: any = { events: Array.from({ length: 128 }, (_, id) => ({ id })) };
    expect(() => notice(full, 'failed', 'test')).toThrow('llena');
    expect(full.events).toHaveLength(128);
  });
});

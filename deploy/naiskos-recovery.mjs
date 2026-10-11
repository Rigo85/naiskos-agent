import { mkdir, open, rename, readFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { uptime } from 'node:os';
import path from 'node:path';
import { DAY, advanceClock, functionalProgress, recoveryDecision } from './naiskos-recovery-policy.mjs';

const exec = promisify(execCallback);
const root = '/var/lib/naiskos/recovery';
const pending = '/run/naiskos-emergency-reboot.pending';
const deadline = '/run/systemd/system/shutdown.target.d/90-naiskos-emergency.conf';
export async function durable(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.tmp`;
  const handle = await open(temporary, 'w', 0o600);
  try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  await rename(temporary, file);
  const dir = await open(path.dirname(file), 'r');
  try { await dir.sync(); } finally { await dir.close(); }
}
async function json(file) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
export function notice(state, status, reason) {
  if (state.incident?.status === status) return;
  // Never silently discard an unacknowledged emergency. Fail closed instead.
  if (state.events.length >= 128) throw new Error('Cola de emergencias llena; intervención requerida');
  state.incident ??= { id: randomUUID(), bootId: state.bootId };
  state.incident.status = status;
  state.sequence = (state.sequence ?? 0) + 1;
  state.events.push({ id: randomUUID(), type: 'system.recovery.status',
    sequence: state.sequence,
    incidentId: state.incident.id, bootId: state.bootId, status, reason,
    at: new Date().toISOString() });
}
export async function flush(state, save, send) {
  if (!state.events.length) return;
  try {
    const batch = state.events.slice(0, 32);
    const accepted = new Set(await send(batch));
    state.events = state.events.filter(e => !accepted.has(e.id));
    await save();
  } catch { console.error(JSON.stringify({ event: 'kiosk.recovery.delivery-pending' })); }
}
async function requestReboot(state, save, io) {
  state.rebootRequestAttempts = (state.rebootRequestAttempts ?? 0) + 1;
  state.rebootRequestAt = state.uptimeMs;
  await save();
  try { await io.reboot(); }
  catch {
    notice(state, 'failed', 'El sistema no aceptó la solicitud de reinicio; requiere intervención');
    await save(); await flush(state, save, io.send ?? send);
  }
}
async function send(events) {
  const stored = await json('/var/lib/naiskos/device-credentials.json');
  const url = process.env.NAISKOS_CENTRAL_URL?.replace(/\/$/, '');
  if (!url?.startsWith('https://') || !stored?.frameId || !stored?.agentToken) throw new Error('Central no configurada');
  const response = await fetch(`${url}/api/v1/frames/${encodeURIComponent(stored.frameId)}/events`, {
    method: 'POST', headers: { authorization: `Bearer ${stored.agentToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ events }), signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) throw new Error('Entrega pendiente');
  const result = await response.json();
  if (!Array.isArray(result.accepted)) throw new Error('Acuse inválido');
  return result.accepted;
}
// Called ONLY while holding maintenance, release and software locks, in that order.
export async function recoveryTick(io) {
  const file = io.file ?? `${root}/state.json`;
  const state = await (io.read ?? json)(file) ?? { schemaVersion: 1, events: [], cooldownMs: 0 };
  if (state.schemaVersion !== 1 || !Array.isArray(state.events) ||
      !Number.isFinite(state.cooldownMs) || state.cooldownMs < 0) throw new Error('Estado de recuperación inválido');
  const save = () => (io.write ?? durable)(file, state);
  const bootId = await io.bootId();
  const now = io.uptimeMs();
  const sameBoot = advanceClock(state, bootId, now);
  if (!sameBoot && state.incident?.status === 'reboot-requested') {
    notice(state, 'verifying', 'Se confirmó un nuevo arranque; falta verificar el visor');
    state.verifySince = now;
  }
  let runtime = await io.runtime().catch(() => null);
  const current = await io.status();
  const intent = await io.intent();
  const intentionalExit = runtime?.intentionalExit ||
    (intent?.bootId === bootId && intent?.intentionalExit);
  const healthy = functionalProgress(state, runtime, current, now);
  if (healthy) {
    state.attempts = 0; state.agentAttempts = 0; state.blocked = false;
    if (state.incident && state.incident.status !== 'recovered')
      notice(state, 'recovered', 'Visor funcional durante al menos 120 segundos');
  }
  if (state.incident?.status === 'verifying' && now - state.verifySince >= 300_000 && !healthy)
    notice(state, 'failed', intentionalExit ? 'Verificación pendiente por salida voluntaria' : 'No se confirmó recuperación funcional tras el arranque');
  await save();
  await flush(state, save, io.send ?? send);
  // A release handoff is owned by its coordinator even between invocations.
  if (await io.maintenance()) return { deferred: true };
  if (io.canRecover && !await io.canRecover(current)) return { deferred: true };
  if (state.incident?.status === 'reboot-requested' && sameBoot) {
    // Resume a crash between durable intent and systemctl, without spending another reboot.
    if (now - (state.rebootRequestAt ?? 0) >= 30_000 && !await io.rebootInProgress?.()) {
      if ((state.rebootRequestAttempts ?? 0) < 2) await requestReboot(state, save, io);
      else {
        notice(state, 'failed', 'No se confirmó el inicio del reinicio; requiere intervención');
        await io.cancelPending?.(); await save();
      }
    }
    return { rebootPending: true };
  }
  const action = recoveryDecision(state, { now, intentionalExit,
    ready: runtime?.ready && current.browserLive, apiAvailable: !!runtime,
    blocked: state.blocked === true && current.blocked === true });
  if (action === 'wait' || action === 'idle') { await save(); return { action }; }
  if (!state.incident || state.incident.status === 'recovered') state.incident = null;
  if (action === 'limited') {
    notice(state, 'limited', 'Límite de un reinicio de emergencia por 24 horas de funcionamiento; requiere intervención');
    await save(); await flush(state, save, io.send ?? send); return { action };
  }
  if (action === 'restart-agent' || action === 'restart-viewer') {
    notice(state, 'recovering', action === 'restart-agent' ? 'Agente no responde; recuperación acotada' : 'Visor no responde; recuperación acotada');
    if (action === 'restart-agent') state.agentAttempts += 1; else state.attempts += 1;
    state.unhealthySince = now;
    await save(); // A crash here must not reset the attempt budget.
    try {
      if (action === 'restart-agent') await io.restartAgent(); else await io.restartViewer();
    } catch (error) {
      const after = await io.status();
      state.blocked = after.blocked === true;
      // Only escalate next tick, after a second independent process observation.
      if (state.blocked) state.unhealthySince = now - 120_000;
      state.lastError = String(error.message).slice(0, 500);
    }
    await save(); await flush(state, save, io.send ?? send); return { action };
  }
  // Recheck exit/health immediately before irreversible action, under all locks.
  runtime = await io.runtime().catch(() => null);
  if (runtime?.intentionalExit || runtime?.ready || await io.maintenance()) { await save(); return { deferred: true }; }
  const diagnostics = await io.diagnostics().catch(() => ({ unavailable: true }));
  await (io.write ?? durable)(io.diagnosticFile ?? `${root}/last-incident.json`, diagnostics);
  state.cooldownMs = DAY;
  state.rebootRequestAttempts = 0;
  notice(state, 'reboot-requested', state.blocked ? 'Procesos del visor bloqueados tras cierre acotado' : 'Recuperaciones acotadas agotadas');
  await save();
  await flush(state, save, io.send ?? send);
  await requestReboot(state, save, io);
  return { action };
}

export async function runRecovery(kiosk) {
  const cancelPending = async () => {
    await rm(deadline, { force: true }); await rm(pending, { force: true });
    await exec('/usr/bin/systemctl', ['daemon-reload'], { timeout: 10_000 });
  };
  return recoveryTick({
    bootId: () => readFile('/proc/sys/kernel/random/boot_id', 'utf8').then(x => x.trim()),
    uptimeMs: () => uptime() * 1000,
    runtime: kiosk.runtime, status: kiosk.status,
    intent: () => json('/var/lib/naiskos/viewer-intent.json'),
    canRecover: async current => current.launcherPresent || !!await json('/run/naiskos-kiosk-context.json'),
    maintenance: async () => {
      const observation = await json('/var/lib/naiskos/updates/observation.json');
      if (observation && ['preparing', 'activating', 'rollback'].includes(observation.phase)) return true;
      const locks = JSON.parse((await exec('/usr/bin/lslocks', ['--json', '--output', 'PATH'], { timeout: 3_000 })).stdout);
      return (locks.locks ?? []).some(l => /\/(?:dpkg|apt)\//.test(l.path ?? ''));
    },
    restartViewer: () => kiosk.restart(),
    rebootInProgress: async () => {
      const result = await exec('/usr/bin/systemctl', ['is-system-running'], { timeout: 3_000 })
        .catch(error => { if (typeof error.stdout === 'string' && error.stdout.trim()) return error; throw error; });
      return ['stopping', 'offline'].includes(result.stdout.trim());
    },
    cancelPending,
    restartAgent: () => exec('/usr/bin/systemctl', ['restart', 'naiskos-agent.service'], { timeout: 25_000 }),
    diagnostics: async () => {
      const [kernel, current, runtime] = await Promise.all([
        exec('/usr/bin/journalctl', ['-k', '-b', '-n', '160', '--no-pager', '-o', 'short-iso'], { timeout: 3_000, maxBuffer: 128 * 1024 }),
        kiosk.status(), kiosk.runtime().catch(() => null),
      ]);
      return { at: new Date().toISOString(), kernel: kernel.stdout,
        runtime, processes: current.processes.map(({ pid, start, state, threads }) => ({ pid, start, state, threads })) };
    },
    reboot: async () => {
      // Only this emergency gets a phase-one shutdown deadline; /run clears on boot.
      await durable(pending, { requestedAt: new Date().toISOString() });
      try {
        await mkdir(path.dirname(deadline), { recursive: true });
        const handle = await open(deadline, 'w', 0o644);
        try { await handle.writeFile('[Unit]\nJobTimeoutSec=180s\nJobTimeoutAction=reboot-force\n'); }
        finally { await handle.close(); }
        await exec('/usr/bin/systemctl', ['daemon-reload'], { timeout: 10_000 });
        await exec('/usr/bin/systemctl', ['reboot'], { timeout: 10_000 });
      } catch (error) {
        await cancelPending().catch(() => {});
        throw error;
      }
    },
  });
}

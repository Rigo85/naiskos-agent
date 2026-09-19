#!/opt/node24/bin/node
import { readFile, open, rename, readdir, mkdir, rm, realpath } from 'node:fs/promises';
import path from 'node:path';
import { execFile as execCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { uptime } from 'node:os';
import { pathToFileURL } from 'node:url';
import { main as kiosk, status as kioskStatus } from './naiskos-kiosk-control.mjs';
import { observe, runtimeHealthy } from './naiskos-runtime-policy.mjs';

const exec = promisify(execCallback);
const root = `${process.env.NAISKOS_DATA_ROOT ?? '/var/lib/naiskos'}/updates`;
const observation = `${root}/observation.json`;
const outbox = `${root}/release-reports`;
const helper = '/opt/naiskos/bin/naiskos-release-helper.mjs';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function atomic(file, value) {
  const handle = await open(`${file}.tmp`, 'w', 0o600);
  try { await handle.writeFile(JSON.stringify(value) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
  await rename(`${file}.tmp`, file);
  const directory = await open(path.dirname(file), 'r');
  try { await directory.sync(); } finally { await directory.close(); }
}
async function json(file) { return JSON.parse(await readFile(file, 'utf8')); }
async function runtime() {
  const response = await fetch('http://127.0.0.1:8080/api/v1/viewer/runtime', { signal: AbortSignal.timeout(3_000) });
  if (!response.ok) throw new Error(`Runtime HTTP ${response.status}`);
  return response.json();
}
async function healthy(release) {
  try { return runtimeHealthy(await runtime(), await kioskStatus(), release); } catch { return false; }
}
async function waitHealthy(release) {
  const deadline = performance.now() + 120_000;
  let successes = 0;
  while (performance.now() < deadline) {
    successes = await healthy(release) ? successes + 1 : 0;
    if (successes >= 2) return true;
    await sleep(5_000);
  }
  return false;
}
export async function queueReport(campaignId, releaseId, status, error = '', healthConfirmed = false) {
  await mkdir(outbox, { recursive: true, mode: 0o700 });
  const digest = createHash('sha256').update(`${campaignId}:${releaseId}:${status}${healthConfirmed ? ':healthy' : ''}`).digest('hex');
  const reportId = `${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-a${digest.slice(17,20)}-${digest.slice(20,32)}`;
  const event = { campaignId, releaseId, status, reportId, createdAt: new Date().toISOString(), ...(error ? { error } : {}), ...(healthConfirmed ? { healthConfirmed: true } : {}) };
  const file = `${outbox}/${reportId}.json`;
  try { await json(file); } catch (e) { if (e.code !== 'ENOENT') throw e; await atomic(file, event); }
  await flushReports();
}
export async function flushReports() {
  let files;
  try { files = await readdir(outbox); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  const events = await Promise.all(files.filter(f => f.endsWith('.json')).map(async f => ({ file: `${outbox}/${f}`, value: await json(`${outbox}/${f}`) })));
  const order = { activating: 0, observing: 1, installed: 2, failed: 2, rolled_back: 2 };
  events.sort((a,b) => a.value.createdAt.localeCompare(b.value.createdAt) || order[a.value.status] - order[b.value.status]);
  for (const event of events) {
    try {
      const response = await fetch('http://127.0.0.1:8080/api/v1/system/release-events', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-naiskos-request': 'release-activator' },
        body: JSON.stringify(event.value), signal: AbortSignal.timeout(10_000),
      });
      if (response.status !== 202) return;
      const acknowledgement = await response.json();
      if (acknowledgement.accepted !== true) return;
      await rm(event.file);
    } catch { return; }
  }
}
async function restart() {
  await kiosk('stop');
  await exec('/usr/bin/systemctl', ['restart', 'naiskos-agent.service'], { timeout: 45_000 });
  await kiosk('start');
}
async function quarantinePending(state) {
  const request = `${root}/activation-request.json`;
  let pending;
  try { pending = await json(request); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  if (pending.campaignId !== state.campaignId || pending.releaseId !== state.releaseId)
    throw new Error('La solicitud pendiente pertenece a otra operación');
  await mkdir(`${root}/failed`, { recursive: true, mode: 0o700 });
  await rename(request, `${root}/failed/${state.releaseId}-interrupted-request.json`);
}
async function rollback(state) {
  if (!/^[0-9]{8}[A-Za-z0-9._-]{1,80}$/.test(state.previous)) throw new Error('Release anterior inválida');
  const wasActivated = state.wasActivated ??
    (await realpath('/opt/naiskos/current')) === `/opt/naiskos/releases/${state.releaseId}`;
  if (state.phase === 'preparing' && !wasActivated && !(state.migrations ?? []).length) {
    await quarantinePending(state);
    await queueReport(state.campaignId, state.releaseId, 'failed', state.error || 'Preparación interrumpida');
    await rm(observation);
    return;
  }
  state = { ...state, wasActivated };
  // Save the phase before touching links: a power interruption resumes this rollback.
  await atomic(observation, { ...state, phase: 'rollback' });
  try {
    await quarantinePending(state);
    await kiosk('stop');
    const errors = [];
    for (const migration of state.migrations ?? []) {
      try {
        await exec('/opt/node24/bin/node', [helper, 'rollback-migration', migration,
          '/etc/naiskos/baseline.json', '/var/lib/naiskos/migrations'], { timeout: 120_000 });
      } catch { errors.push(`No se pudo revertir ${migration}`); }
    }
    await exec('/usr/bin/ln', ['-sfn', `/opt/naiskos/releases/${state.previous}`, '/opt/naiskos/current.rollback']);
    await exec('/usr/bin/mv', ['-Tf', '/opt/naiskos/current.rollback', '/opt/naiskos/current']);
    await restart();
    if (!await waitHealthy(state.previous)) throw new Error('La versión anterior no confirmó salud funcional; requiere revisión');
    if (errors.length) throw new Error(errors.join('; '));
    await queueReport(state.campaignId, state.releaseId, wasActivated ? 'rolled_back' : 'failed',
      state.error || 'La nueva release no recuperó el kiosco');
    await rm(observation);
  } catch (error) {
    // Best effort even when rollback itself fails. Do not certify recovery from
    // merely starting the launcher; the failure remains durable for diagnosis.
    await restart().catch(() => undefined);
    await mkdir(`${root}/failed`, { recursive: true, mode: 0o700 });
    await atomic(`${root}/failed/${state.releaseId}-runtime.json`, { ...state, phase: 'failed', error: error.message });
    await queueReport(state.campaignId, state.releaseId, 'failed', error.message);
    // An older restored activator does not understand the new phases. Do not
    // let it turn this unresolved rollback into a later false installed result.
    await rm(observation);
    throw error;
  }
}
async function tick(handoff = false) {
  await flushReports();
  let state;
  try { state = await json(observation); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
  if (state.phase === 'failed') return;
  if (state.phase === 'preparing' || state.phase === 'activating')
    return rollback({ ...state, error: 'Activación interrumpida antes de iniciar observación' });
  if (state.phase === 'rollback') return rollback(state);
  if (handoff) {
    // The baseline-12 activator already loaded its old restart function. Complete
    // that first activation with the new controller once its exclusive lock ends.
    if (!await healthy(state.releaseId)) {
      try { await restart(); } catch (e) {
        await atomic(observation, { ...state, phase: 'failed', error: e.message });
        await queueReport(state.campaignId, state.releaseId, 'failed', e.message);
        throw e;
      }
      if (!await waitHealthy(state.releaseId)) {
        await atomic(observation, { ...state, failures: 2 });
        return; // The timer owns rollback; never stop the migration's own handoff unit.
      }
    }
  }
  const current = await runtime().catch(() => null);
  const sample = { bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
    agentInstanceId: current?.agentInstanceId, viewerSessionId: current?.viewer?.playback?.sessionId,
    uptime: uptime(), healthy: await healthy(state.releaseId), paused: current?.intentionalExit === true };
  const result = observe(state, sample);
  if (sample.healthy && !sample.paused && !state.healthReported && result.decision === 'wait') {
    await queueReport(state.campaignId,state.releaseId,'observing','',true);
    result.state.healthReported = true;
  }
  await atomic(observation, result.state);
  if (result.decision === 'rollback') return rollback(result.state);
  if (result.decision === 'installed') {
    await queueReport(state.campaignId, state.releaseId, 'installed');
    await rm(observation);
  }
}
export async function main(command, args = []) {
  if (command === 'prepare-activation') {
    const [campaignId, releaseId, previous, minutes] = args;
    const pattern = /^[0-9]{8}[A-Za-z0-9._-]{1,80}$/;
    if (!/^[a-f0-9-]{36}$/.test(campaignId) || !pattern.test(releaseId) || !pattern.test(previous) ||
      !Number.isInteger(Number(minutes)) || Number(minutes) < 1 || Number(minutes) > 10080)
      throw new Error('Estado de activación inválido');
    if (await json(observation).catch(e => { if (e.code === 'ENOENT') return null; throw e; }))
      throw new Error('Existe una operación sin terminar');
    if (await realpath('/opt/naiskos/current') !== `/opt/naiskos/releases/${previous}`)
      throw new Error('La release anterior cambió durante la preparación');
    await atomic(observation, { campaignId, releaseId, previous, observeMinutes: Number(minutes),
      phase: 'preparing', preparedAt: new Date().toISOString(), failures: 0, migrations: [] });
    return;
  }
  if (command === 'begin-activation') {
    const state = await json(observation);
    if (state.phase !== 'preparing') throw new Error('La operación no está preparada');
    await atomic(observation, { ...state, phase: 'activating' });
    return;
  }
  if (command === 'migration-intent') {
    const [migrationId, descriptorFile] = args;
    const state = await json(observation);
    const descriptor = await json(descriptorFile);
    const baseline = await json('/etc/naiskos/baseline.json');
    if (state.phase !== 'activating' || descriptor.migrationId !== migrationId)
      throw new Error('Intento de migración fuera de la activación');
    // Already-current migrations are never rolled back with a later release.
    if (String(baseline.baselineVersion) === String(descriptor.fromVersion)) {
      state.migrations = [migrationId, ...state.migrations.filter(id => id !== migrationId)];
      await atomic(observation, state);
    }
    return;
  }
  if (command === 'begin-observation') {
    const state = await json(observation);
    if (state.phase !== 'activating' || await realpath('/opt/naiskos/current') !== `/opt/naiskos/releases/${state.releaseId}`)
      throw new Error('La release preparada no es la activa');
    await atomic(observation, { ...state, phase: 'observing', activatedAt: new Date().toISOString() });
    return;
  }
  if (command === 'abort-activation') {
    return rollback({ ...await json(observation), error: args[0] || 'Activación abortada' });
  }
  if (command === 'can-activate') {
    const current = await runtime();
    if (current.intentionalExit) throw new Error('Activación aplazada: cierre voluntario del visor');
    return;
  }
  if (command === 'report') return queueReport(...args);
  if (command === 'tick' || command === 'handoff') return tick(command === 'handoff');
  if (command === 'restart') return restart();
  if (command === 'health') {
    if (!await healthy(args[0])) throw new Error('El kiosco no confirmó salud funcional');
    return;
  }
  throw new Error('Comando runtime inválido');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv[2], process.argv.slice(3)).catch(e => { console.error(e.message); process.exitCode = 1; });
}

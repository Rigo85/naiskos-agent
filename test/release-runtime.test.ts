import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

let root: string;
afterEach(async () => {
  vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.resetModules();
  if (root) await rm(root, { recursive: true, force: true });
});
it('persiste resultados sin agente, reintenta con el mismo ID y conserva el orden', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'naiskos-runtime-report-'));
  vi.stubEnv('NAISKOS_DATA_ROOT', root);
  const fetcher = vi.fn().mockRejectedValue(new Error('agente reiniciando'));
  vi.stubGlobal('fetch', fetcher);
  const { queueReport, flushReports } = await import('../deploy/naiskos-release-runtime.mjs');
  const campaign = '11111111-1111-4111-8111-111111111111';
  await queueReport(campaign, '20260916-test', 'observing');
  await queueReport(campaign, '20260916-test', 'installed');
  await queueReport(campaign, '20260916-test', 'installed');
  const directory = path.join(root, 'updates/release-reports');
  expect(await readdir(directory)).toHaveLength(2);
  const saved = await Promise.all((await readdir(directory)).map(async file =>
    JSON.parse(await readFile(path.join(directory, file), 'utf8'))));
  const installed = saved.find(event => event.status === 'installed');
  fetcher.mockReset().mockResolvedValue({ ok: true, status: 200 });
  await flushReports();
  expect(await readdir(directory)).toHaveLength(2);
  fetcher.mockReset().mockResolvedValue({ ok: true, status: 202, json: async () => ({ accepted: true }) });
  await flushReports();
  expect(await readdir(directory)).toEqual([]);
  const sent = fetcher.mock.calls.map(call => JSON.parse(call[1].body));
  expect(sent.map(event => event.status)).toEqual(['observing', 'installed']);
  expect(sent[1].reportId).toBe(installed.reportId);
});
it('confirma salud con ID propio estable sin confundirla con el aviso inicial',async()=>{
  root=await mkdtemp(path.join(os.tmpdir(),'naiskos-runtime-health-'));
  vi.stubEnv('NAISKOS_DATA_ROOT',root);
  vi.stubGlobal('fetch',vi.fn().mockRejectedValue(new Error('offline')));
  const {queueReport}=await import('../deploy/naiskos-release-runtime.mjs');
  const campaign='11111111-1111-4111-8111-111111111111';
  await queueReport(campaign,'20260916-test','observing','Salud pendiente');
  await queueReport(campaign,'20260916-test','observing','',true);
  await queueReport(campaign,'20260916-test','observing','',true);
  const dir=path.join(root,'updates/release-reports');
  const files=await readdir(dir);expect(files).toHaveLength(2);
  const events=await Promise.all(files.map(async f=>JSON.parse(await readFile(path.join(dir,f),'utf8'))));
  expect(events.filter(e=>e.healthConfirmed)).toHaveLength(1);
  expect(events.find(e=>e.healthConfirmed).error).toBeUndefined();
});

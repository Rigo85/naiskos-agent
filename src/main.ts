import path from "node:path";

import { readJson, writeJsonAtomic } from "./atomic-store.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import {
  loadProvisionedCredentials,
  ProvisioningManager,
} from "./provisioning.js";
import { SyncEngine } from "./sync-engine.js";
import { EMPTY_WEATHER, LocalManifest, WeatherSnapshot } from "./types.js";
import { emptyManifest } from "./validation.js";

const config = loadConfig();
await loadProvisionedCredentials(config);
const manifestFile = path.join(config.dataRoot, "manifest.json");
const manifest =
  (await readJson<LocalManifest>(manifestFile)) ??
  emptyManifest(config.frameId ?? undefined);
await writeJsonAtomic(manifestFile, manifest);
const weatherFile = path.join(config.dataRoot, "weather.json");
const weather =
  (await readJson<WeatherSnapshot>(weatherFile)) ?? { ...EMPTY_WEATHER };
await writeJsonAtomic(weatherFile, weather);

const engine = new SyncEngine(config, manifest, weather);
const provisioning = new ProvisioningManager(config, (frameId) =>
  engine.configure(frameId),
);
const app = await buildApp(config, engine, provisioning);
await app.listen({ host: config.host, port: config.port });

void provisioning
  .initialize()
  .catch((error) => app.log.warn({ error }, "Alta del dispositivo pendiente"));

const syncTimer = setInterval(() => {
  void engine
    .sync()
    .catch((error) => app.log.warn({ error }, "Sincronización fallida"));
}, config.syncIntervalMs);
syncTimer.unref();
const provisioningTimer = setInterval(() => {
  void provisioning
    .refresh()
    .catch((error) => app.log.warn({ error }, "Consulta de alta fallida"));
}, config.syncIntervalMs);
provisioningTimer.unref();
void engine
  .sync()
  .catch((error) => app.log.warn({ error }, "Sincronización inicial fallida"));

async function shutdown(signal: string): Promise<void> {
  clearInterval(syncTimer);
  clearInterval(provisioningTimer);
  app.log.info({ signal }, "Deteniendo agente local");
  await app.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

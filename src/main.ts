import path from "node:path";

import { readJson, writeJsonAtomic } from "./atomic-store.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
import {
  loadProvisionedCredentials,
  ProvisioningManager,
} from "./provisioning.js";
import { SyncEngine } from "./sync-engine.js";
import {
  EMPTY_WEATHER,
  FrameNotification,
  LocalManifest,
  WeatherSnapshot,
} from "./types.js";
import { emptyManifest } from "./validation.js";
import { errorForLog } from "./logging.js";
import { SoftwareUpdateManager } from "./software-update.js";

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
const notificationsFile = path.join(config.dataRoot, "notifications.json");
const notifications =
  (await readJson<FrameNotification[]>(notificationsFile)) ?? [];
await writeJsonAtomic(notificationsFile, notifications);

const engine = new SyncEngine(config, manifest, weather, notifications);
const softwareUpdates = new SoftwareUpdateManager(config, (event) =>
  engine.enqueueEvent(event),
);
const provisioning = new ProvisioningManager(config, (frameId) =>
  engine.configure(frameId),
);
const app = await buildApp(config, engine, provisioning);
await app.listen({ host: config.host, port: config.port });

void provisioning
  .initialize()
  .catch((error) =>
    app.log.warn({ err: errorForLog(error) }, "Alta del dispositivo pendiente"),
  );

const syncTimer = setInterval(() => {
  void engine
    .sync()
    .catch((error) =>
      app.log.warn({ err: errorForLog(error) }, "Sincronización fallida"),
    );
}, config.syncIntervalMs);
syncTimer.unref();
const provisioningTimer = setInterval(() => {
  void provisioning
    .refresh()
    .catch((error) =>
      app.log.warn({ err: errorForLog(error) }, "Consulta de alta fallida"),
    );
}, config.syncIntervalMs);
provisioningTimer.unref();
void engine
  .sync()
  .catch((error) =>
    app.log.warn({ err: errorForLog(error) }, "Sincronización inicial fallida"),
  );
const softwareTimer = setInterval(() => {
  void softwareUpdates.check().catch((error) =>
    app.log.warn({ err: errorForLog(error) }, "Consulta de software fallida"),
  );
}, config.softwareCheckIntervalMs);
softwareTimer.unref();
void softwareUpdates.check().catch((error) =>
  app.log.warn({ err: errorForLog(error) }, "Consulta inicial de software fallida"),
);

let terminatingAfterFatalError = false;

function fatalAndExit(error: unknown, message: string): void {
  if (terminatingAfterFatalError) return;
  terminatingAfterFatalError = true;
  app.log.fatal({ err: errorForLog(error) }, message);

  const logger = app.log as typeof app.log & {
    flush?: (callback?: (error?: Error) => void) => void;
  };
  if (!logger.flush) {
    process.exit(1);
    return;
  }

  // El callback confirma que Pino entregó el evento. El límite evita dejar un
  // proceso fatal colgado si el destino de logs también está averiado.
  const forcedExit = setTimeout(() => process.exit(1), 1_000);
  try {
    logger.flush(() => {
      clearTimeout(forcedExit);
      process.exit(1);
    });
  } catch {
    clearTimeout(forcedExit);
    process.exit(1);
  }
}

process.on("uncaughtException", (error) =>
  fatalAndExit(error, "Excepción no controlada"),
);
process.on("unhandledRejection", (reason) =>
  fatalAndExit(reason, "Promesa rechazada sin controlador"),
);

async function shutdown(signal: string): Promise<void> {
  clearInterval(syncTimer);
  clearInterval(provisioningTimer);
  clearInterval(softwareTimer);
  app.log.info({ signal }, "Deteniendo agente local");
  await app.close();
  process.exit(0);
}

process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

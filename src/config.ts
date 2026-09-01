import path from "node:path";

export interface AgentConfig {
  host: string;
  port: number;
  dataRoot: string;
  webRoot: string;
  centralUrl: string | null;
  frameId: string | null;
  token: string | null;
  telegramBotUsername: string;
  deviceBootstrapToken: string | null;
  deviceName: string | null;
  frameWidth: number;
  frameHeight: number;
  syncIntervalMs: number;
  weatherSyncIntervalMs: number;
  telemetryHeartbeatIntervalMs?: number;
  telemetryFullIntervalMs?: number;
  diskBlockPercent: number;
  softwareCheckIntervalMs: number;
  releasePublicKeyPath: string;
}

function integer(
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${name} debe ser un entero entre ${minimum} y ${maximum}`);
  }
  return value;
}

export function loadConfig(): AgentConfig {
  return {
    host: process.env.NAISKOS_HOST ?? "127.0.0.1",
    port: integer("NAISKOS_PORT", 8080, 1, 65_535),
    dataRoot: path.resolve(process.env.NAISKOS_DATA_ROOT ?? "./data"),
    webRoot: path.resolve(
      process.env.NAISKOS_WEB_ROOT ?? "../naiskos-ng/dist/naiskos-ng/browser",
    ),
    centralUrl: process.env.NAISKOS_CENTRAL_URL?.replace(/\/$/, "") ?? null,
    frameId: process.env.NAISKOS_FRAME_ID ?? null,
    token: process.env.NAISKOS_AGENT_TOKEN ?? null,
    telegramBotUsername: (process.env.NAISKOS_TELEGRAM_BOT_USERNAME ?? "naiskosbot").replace(
      /^@/,
      "",
    ),
    deviceBootstrapToken: process.env.NAISKOS_DEVICE_BOOTSTRAP_TOKEN ?? null,
    deviceName: process.env.NAISKOS_DEVICE_NAME?.trim() || null,
    frameWidth: integer("NAISKOS_FRAME_WIDTH", 1280, 1, 16_384),
    frameHeight: integer("NAISKOS_FRAME_HEIGHT", 800, 1, 16_384),
    syncIntervalMs: integer(
      "NAISKOS_SYNC_INTERVAL_MS",
      5_000,
      1_000,
      3_600_000,
    ),
    weatherSyncIntervalMs: integer(
      "NAISKOS_WEATHER_SYNC_INTERVAL_MS",
      60_000,
      60_000,
      24 * 60 * 60_000,
    ),
    telemetryHeartbeatIntervalMs: integer(
      "NAISKOS_TELEMETRY_HEARTBEAT_INTERVAL_MS",
      60_000,
      30_000,
      10 * 60_000,
    ),
    telemetryFullIntervalMs: integer(
      "NAISKOS_TELEMETRY_FULL_INTERVAL_MS",
      5 * 60_000,
      60_000,
      60 * 60_000,
    ),
    diskBlockPercent: integer("NAISKOS_DISK_BLOCK_PERCENT", 90, 50, 99),
    softwareCheckIntervalMs: integer(
      "NAISKOS_SOFTWARE_CHECK_INTERVAL_MS",
      60_000,
      60_000,
      24 * 60 * 60_000,
    ),
    releasePublicKeyPath:
      process.env.NAISKOS_RELEASE_PUBLIC_KEY_PATH ??
      "/etc/naiskos/release-signing-public.pem",
  };
}

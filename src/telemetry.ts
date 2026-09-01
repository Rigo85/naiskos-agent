import { execFile } from "node:child_process";
import { readFile, realpath, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { AgentConfig } from "./config.js";
import { AgentStatus } from "./types.js";

const execFileAsync = promisify(execFile);
const KIB = 1024;

export type ServiceState = "active" | "inactive" | "failed" | "unknown";

export interface HeartbeatTelemetry {
  schemaVersion: 1;
  kind: "heartbeat";
  observedAt: string;
  uptimeSeconds: number;
  agentState: AgentStatus["state"];
  installedManifestVersion: number;
  lastSyncAt: string | null;
  lastErrorCode: string | null;
}

export interface FullTelemetry {
  schemaVersion: 1;
  kind: "full";
  frameId: string;
  observedAt: string;
  uptimeSeconds: number;
  thermal: {
    temperatureCelsius: number | null;
    throttledMask: string | null;
  };
  memory: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    swapTotalBytes: number;
    swapUsedBytes: number;
  };
  storage: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    frameDataBytes: number;
    mediaDataBytes: number;
    usedPercent: number;
  };
  services: {
    agent: ServiceState;
    chromium: ServiceState;
    kioskLauncher: ServiceState;
  };
  sync: {
    state: "idle" | "checking" | "downloading" | "error";
    desiredManifestVersion: number;
    installedManifestVersion: number;
    pendingOutbox: number;
    lastSuccessAt: string | null;
    lastErrorCode: string | null;
  };
  software: {
    releaseId: string;
    agentVersion: string;
    viewerVersion: string;
    baselineVersion: string;
    nodeVersion: string;
    chromiumVersion: string;
    osVersion: string;
    kernelVersion: string;
  };
  display: {
    connected: boolean;
    connector: string;
    width: number;
    height: number;
    power: "on" | "off" | "unknown";
  };
  audio: {
    available: boolean;
    transport: "hdmi" | "analog" | "usb" | "unknown";
  };
  clock: { synchronized: boolean; timezone: string };
}

export function heartbeatTelemetry(status: AgentStatus): HeartbeatTelemetry {
  return {
    schemaVersion: 1,
    kind: "heartbeat",
    observedAt: new Date().toISOString(),
    uptimeSeconds: Math.max(0, Math.floor(os.uptime())),
    agentState: status.state,
    installedManifestVersion: status.manifestVersion,
    lastSyncAt: status.lastSyncAt,
    lastErrorCode: telemetryErrorCode(status.lastError),
  };
}

export async function collectSystemTelemetry(
  config: AgentConfig,
  status: AgentStatus,
  pendingOutbox: number,
  desiredManifestVersion = status.manifestVersion,
): Promise<FullTelemetry> {
  const [memory, temperature, throttledMask, chromium, kiosk, software, display, audio, clock] =
    await Promise.all([
      readMemory(),
      readTemperature(),
      readThrottledMask(),
      processState("chromium"),
      processState("start-naiskos-kiosk", true),
      readSoftware(),
      readDisplay(config),
      readAudio(),
      readClock(),
    ]);
  return {
    schemaVersion: 1,
    kind: "full",
    frameId: config.frameId ?? "",
    observedAt: new Date().toISOString(),
    uptimeSeconds: Math.max(0, Math.floor(os.uptime())),
    thermal: { temperatureCelsius: temperature, throttledMask },
    memory,
    storage: {
      totalBytes: status.diskTotalBytes,
      usedBytes: status.diskUsedBytes,
      availableBytes: status.diskAvailableBytes,
      frameDataBytes: status.frameDataBytes,
      mediaDataBytes: status.mediaDataBytes,
      usedPercent: status.diskUsedPercent,
    },
    services: { agent: "active", chromium, kioskLauncher: kiosk },
    sync: {
      state: syncState(status.state),
      desiredManifestVersion,
      installedManifestVersion: status.manifestVersion,
      pendingOutbox,
      lastSuccessAt: status.lastSyncAt,
      lastErrorCode: telemetryErrorCode(status.lastError),
    },
    software,
    display,
    audio,
    clock,
  };
}

export function telemetryErrorCode(error: string | null): string | null {
  if (!error) return null;
  const prefix = error.split(":", 1)[0]?.trim().toLowerCase() ?? "error";
  return prefix.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80) || "error";
}

function syncState(state: AgentStatus["state"]): FullTelemetry["sync"]["state"] {
  if (state === "syncing") return "checking";
  if (state === "error" || state === "offline" || state === "storage-blocked") return "error";
  return "idle";
}

async function readMemory(): Promise<FullTelemetry["memory"]> {
  const values = new Map<string, number>();
  try {
    for (const line of (await readFile("/proc/meminfo", "utf8")).split("\n")) {
      const match = line.match(/^(\w+):\s+(\d+)\s+kB$/);
      if (match) values.set(match[1]!, Number(match[2]) * KIB);
    }
  } catch {
    // El contrato conserva ceros explícitos cuando el kernel no expone /proc.
  }
  const totalBytes = values.get("MemTotal") ?? 0;
  const availableBytes = values.get("MemAvailable") ?? 0;
  const swapTotalBytes = values.get("SwapTotal") ?? 0;
  const swapFreeBytes = values.get("SwapFree") ?? 0;
  return {
    totalBytes,
    usedBytes: Math.max(0, totalBytes - availableBytes),
    availableBytes,
    swapTotalBytes,
    swapUsedBytes: Math.max(0, swapTotalBytes - swapFreeBytes),
  };
}

async function readTemperature(): Promise<number | null> {
  try {
    const raw = Number((await readFile("/sys/class/thermal/thermal_zone0/temp", "utf8")).trim());
    return Number.isFinite(raw) ? Math.round((raw / 1000) * 10) / 10 : null;
  } catch {
    return null;
  }
}

async function readThrottledMask(): Promise<string | null> {
  const output = await command("/usr/bin/vcgencmd", ["get_throttled"]);
  const match = output.match(/throttled=(0x[0-9a-f]+)/i);
  return match?.[1]?.toLowerCase() ?? null;
}

async function processState(name: string, fullCommand = false): Promise<ServiceState> {
  const output = await command("/usr/bin/pgrep", [fullCommand ? "-f" : "-x", name]);
  return output.trim() ? "active" : "inactive";
}

async function readSoftware(): Promise<FullTelemetry["software"]> {
  const releaseId = await releaseFromLink("/opt/naiskos/current");
  const agentVersion = await releaseFromLink("/opt/naiskos/agent");
  const viewerVersion = await releaseFromLink("/opt/naiskos/browser");
  const baseline = await readJsonValue("/etc/naiskos/baseline.json", "baselineVersion");
  const chromiumVersion = (await command("/usr/bin/chromium", ["--version"])) || "unknown";
  const osRelease = await keyValueFile("/etc/os-release");
  return {
    releaseId,
    agentVersion,
    viewerVersion,
    baselineVersion: baseline || "0",
    nodeVersion: process.version,
    chromiumVersion: chromiumVersion.trim().slice(0, 80),
    osVersion: (osRelease.get("PRETTY_NAME") ?? "unknown").slice(0, 120),
    kernelVersion: os.release().slice(0, 120),
  };
}

async function releaseFromLink(link: string): Promise<string> {
  try {
    const resolved = await realpath(link);
    const parts = resolved.split(path.sep);
    const releases = parts.lastIndexOf("releases");
    return (releases >= 0 ? parts[releases + 1] : path.basename(resolved)) || "unknown";
  } catch {
    return "unknown";
  }
}

async function readDisplay(config: AgentConfig): Promise<FullTelemetry["display"]> {
  const connector = "HDMI-A-1";
  try {
    const entries = await readdir("/sys/class/drm");
    const entry = entries.find((name) => name.endsWith(`-${connector}`));
    if (!entry) throw new Error("connector missing");
    const root = path.join("/sys/class/drm", entry);
    const connected = (await readFile(path.join(root, "status"), "utf8")).trim() === "connected";
    return {
      connected,
      connector,
      width: connected ? config.frameWidth : 0,
      height: connected ? config.frameHeight : 0,
      power: connected ? "on" : "off",
    };
  } catch {
    return { connected: false, connector, width: 0, height: 0, power: "unknown" };
  }
}

async function readAudio(): Promise<FullTelemetry["audio"]> {
  try {
    const cards = (await readFile("/proc/asound/cards", "utf8")).toLowerCase();
    const available = /\n?\s*\d+\s+\[/.test(cards);
    return {
      available,
      transport: cards.includes("hdmi") ? "hdmi" : cards.includes("usb") ? "usb" : "unknown",
    };
  } catch {
    return { available: false, transport: "unknown" };
  }
}

async function readClock(): Promise<FullTelemetry["clock"]> {
  const synchronized = (await command("/usr/bin/timedatectl", ["show", "--property=NTPSynchronized", "--value"]))
    .trim()
    .toLowerCase() === "yes";
  return { synchronized, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown" };
}

async function command(file: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(file, args, { timeout: 3_000, maxBuffer: 64 * 1024 });
    return stdout;
  } catch {
    return "";
  }
}

async function readJsonValue(file: string, key: string): Promise<string> {
  try {
    const value = (JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>)[key];
    return value === undefined ? "" : String(value);
  } catch {
    return "";
  }
}

async function keyValueFile(file: string): Promise<Map<string, string>> {
  const values = new Map<string, string>();
  try {
    for (const line of (await readFile(file, "utf8")).split("\n")) {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (match) values.set(match[1]!, match[2]!.replace(/^"|"$/g, ""));
    }
  } catch {
    // Devuelve el mapa vacío.
  }
  return values;
}

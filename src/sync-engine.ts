import { createHash, randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { access, mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { AgentConfig } from "./config.js";
import { readJson, writeJsonAtomic } from "./atomic-store.js";
import {
  AgentStatus,
  LocalManifest,
  LocalMediaItem,
  RemoteManifest,
  WeatherSnapshot,
  FrameNotification,
  EMPTY_WEATHER,
} from "./types.js";
import {
  normalizeSettings,
  validateRemoteManifest,
  validateWeatherSnapshot,
  validateNotifications,
} from "./validation.js";
import { scanWifiAccessPoints } from "./wifi-scan.js";
import {
  collectFileSystemUsage,
  collectFrameDataUsage,
} from "./storage-usage.js";

export class SyncEngine {
  readonly manifestFile: string;
  readonly mediaRoot: string;
  readonly weatherFile: string;
  readonly notificationsFile: string;
  status: AgentStatus;
  private running = false;
  private outboxChain: Promise<unknown> = Promise.resolve();
  private manifestChain: Promise<unknown> = Promise.resolve();
  private nextWeatherSyncAt = 0;
  private nextDataUsageScanAt = 0;

  constructor(
    private readonly config: AgentConfig,
    private manifest: LocalManifest,
    private weather: WeatherSnapshot = EMPTY_WEATHER,
    private notifications: FrameNotification[] = [],
  ) {
    this.manifest = {
      ...manifest,
      settings: normalizeSettings(manifest.settings),
      settingsRevision: Number.isSafeInteger(manifest.settingsRevision)
        ? manifest.settingsRevision
        : 0,
      media: manifest.media.map((item) => ({
        ...item,
        rotationDegrees: [0, 90, 180, 270].includes(item.rotationDegrees)
          ? item.rotationDegrees
          : 0,
      })),
    };
    this.manifestFile = path.join(config.dataRoot, "manifest.json");
    this.mediaRoot = path.join(config.dataRoot, "media");
    this.weatherFile = path.join(config.dataRoot, "weather.json");
    this.notificationsFile = path.join(config.dataRoot, "notifications.json");
    this.status = {
      state:
        config.frameId && config.centralUrl && config.token
          ? "ready"
          : "unconfigured",
      frameId: config.frameId,
      manifestVersion: this.manifest.version,
      lastSyncAt: null,
      lastError: null,
      diskTotalBytes: 0,
      diskUsedBytes: 0,
      diskAvailableBytes: 0,
      diskReservedBytes: 0,
      diskUsedPercent: 0,
      frameDataBytes: 0,
      mediaDataBytes: 0,
    };
  }

  currentManifest(): LocalManifest {
    return this.manifest;
  }

  currentWeather(): WeatherSnapshot {
    if (
      this.weather.current &&
      this.weather.staleAfter &&
      Date.parse(this.weather.staleAfter) <= Date.now()
    ) {
      return { ...this.weather, status: "stale" };
    }
    return this.weather;
  }

  currentNotifications(): FrameNotification[] {
    return this.notifications;
  }

  async markNotification(
    notificationId: string,
    action: "read" | "dismissed",
  ): Promise<boolean> {
    const found = this.notifications.some((item) => item.id === notificationId);
    if (!found) return false;
    const now = new Date().toISOString();
    this.notifications =
      action === "dismissed"
        ? this.notifications.filter((item) => item.id !== notificationId)
        : this.notifications.map((item) =>
            item.id === notificationId && !item.readAt
              ? { ...item, readAt: now, updatedAt: now }
              : item,
          );
    await writeJsonAtomic(this.notificationsFile, this.notifications);
    await this.enqueueEvent({
      type: `notification.${action}`,
      at: now,
      notificationId,
    });
    return true;
  }

  async markAllNotificationsRead(): Promise<number> {
    const unread = this.notifications.filter((item) => !item.readAt);
    for (const item of unread) await this.markNotification(item.id, "read");
    return unread.length;
  }

  async configure(frameId: string): Promise<void> {
    if (this.manifest.frameId !== frameId) {
      await this.replaceManifest({
        ...this.manifest,
        frameId,
        version: 0,
        publishedAt: new Date().toISOString(),
      });
    }
    this.status.frameId = frameId;
    this.status.state = "ready";
    this.status.lastError = null;
  }

  async replaceManifest(manifest: LocalManifest): Promise<void> {
    await this.withManifestLock(() => this.persistManifest(manifest));
  }

  async updateSettings(settings: LocalManifest["settings"]): Promise<void> {
    await this.withManifestLock(() =>
      this.persistManifest({ ...this.manifest, settings }),
    );
  }

  async updateMediaFit(
    mediaId: string,
    fitMode: LocalMediaItem["fitMode"],
  ): Promise<LocalMediaItem | null> {
    return this.withManifestLock(async () => {
      const found = this.manifest.media.find((item) => item.id === mediaId);
      if (!found) return null;
      const updated = { ...found, fitMode };
      await this.persistManifest({
        ...this.manifest,
        media: this.manifest.media.map((item) =>
          item.id === mediaId ? updated : item,
        ),
      });
      return updated;
    });
  }

  async enqueueEvent(event: Record<string, unknown>): Promise<string> {
    const id = randomUUID();
    await this.withOutboxLock(async () => {
      const file = path.join(this.config.dataRoot, "outbox.json");
      const events =
        (await readJson<Array<Record<string, unknown>>>(file)) ?? [];
      events.push({ id, ...event });
      await writeJsonAtomic(file, events.slice(-1_000));
    });
    return id;
  }

  async sync(): Promise<"updated" | "unchanged" | "blocked" | "unconfigured"> {
    if (this.running) return "unchanged";
    const { frameId, centralUrl, token } = this.config;
    if (!frameId || !centralUrl || !token) return "unconfigured";
    this.running = true;
    let outboxError: unknown = null;
    let weatherError: unknown = null;
    let notificationError: unknown = null;
    try {
      try {
        await this.flushOutbox();
      } catch (error) {
        outboxError = error;
      }
      if (!outboxError) {
        try {
          await this.syncNotifications();
        } catch (error) {
          notificationError = error;
        }
      }
      await this.refreshStorageUsage();
      if (this.status.diskUsedPercent >= this.config.diskBlockPercent) {
        this.status.state = "storage-blocked";
        this.status.lastError = `Almacenamiento al ${this.status.diskUsedPercent.toFixed(1)}%`;
        return "blocked";
      }
      this.status.state = "syncing";
      if (this.nextWeatherSyncAt <= Date.now()) {
        this.nextWeatherSyncAt = Date.now() + this.config.weatherSyncIntervalMs;
        try {
          await this.syncWeather();
        } catch (error) {
          weatherError = error;
        }
      }
      const response = await fetch(
        `${centralUrl}/api/v1/frames/${encodeURIComponent(frameId)}/manifest`,
        {
          headers: {
            authorization: `Bearer ${token}`,
            "if-none-match": `"${this.manifest.version}"`,
          },
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (response.status === 304) {
        this.markSuccess();
        return "unchanged";
      }
      if (!response.ok)
        throw new Error(`Central respondió HTTP ${response.status}`);
      const remote = validateRemoteManifest(await response.json(), frameId);
      if (remote.version <= this.manifest.version) {
        this.markSuccess();
        return "unchanged";
      }
      const local = await this.materialize(remote, token);
      await this.installRemoteManifest(remote, local);
      await this.refreshStorageUsage(true);
      this.markSuccess();
      return "updated";
    } catch (error) {
      this.status.state = error instanceof TypeError ? "offline" : "error";
      this.status.lastError =
        error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      this.running = false;
      if (outboxError) this.recordAuxiliaryError("Outbox", outboxError);
      if (weatherError) this.recordAuxiliaryError("Clima", weatherError);
      if (notificationError)
        this.recordAuxiliaryError("Notificaciones", notificationError);
      try {
        await this.reportTelemetry();
      } catch (error) {
        this.recordAuxiliaryError("Telemetría", error);
      }
    }
  }

  private async syncWeather(): Promise<void> {
    const { frameId, centralUrl, token } = this.config;
    if (!frameId || !centralUrl || !token) return;
    const wifiAccessPoints = await scanWifiAccessPoints();
    const response = await fetch(
      `${centralUrl}/api/v1/frames/${encodeURIComponent(frameId)}/weather`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ wifiAccessPoints }),
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok) throw new Error(`Central respondió HTTP ${response.status}`);
    const incoming = validateWeatherSnapshot(await response.json());
    if (
      incoming.status === "unavailable" &&
      this.weather.current &&
      this.weather.status !== "stale"
    ) {
      return;
    }
    if (JSON.stringify(incoming) === JSON.stringify(this.weather)) return;
    await writeJsonAtomic(this.weatherFile, incoming);
    this.weather = incoming;
  }

  private async syncNotifications(): Promise<void> {
    const { frameId, centralUrl, token } = this.config;
    if (!frameId || !centralUrl || !token) return;
    const response = await fetch(
      `${centralUrl}/api/v1/frames/${encodeURIComponent(frameId)}/notifications`,
      {
        headers: { authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok) throw new Error(`Central respondió HTTP ${response.status}`);
    const incoming = validateNotifications(await response.json());
    if (JSON.stringify(incoming) === JSON.stringify(this.notifications)) return;
    await writeJsonAtomic(this.notificationsFile, incoming);
    this.notifications = incoming;
  }

  private async flushOutbox(): Promise<void> {
    const { frameId, centralUrl, token } = this.config;
    if (!frameId || !centralUrl || !token) return;
    await this.withOutboxLock(async () => {
      const file = path.join(this.config.dataRoot, "outbox.json");
      const events =
        (await readJson<Array<Record<string, unknown>>>(file)) ?? [];
      if (events.length === 0) return;
      const batch = events.slice(0, 100);
      const response = await fetch(
        `${centralUrl}/api/v1/frames/${encodeURIComponent(frameId)}/events`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ events: batch }),
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (!response.ok)
        throw new Error(`Central respondió HTTP ${response.status}`);
      const result = (await response.json()) as { accepted?: string[] };
      const accepted = new Set(result.accepted ?? []);
      await writeJsonAtomic(
        file,
        events.filter((event) => !accepted.has(String(event.id))),
      );
    });
  }

  private async reportTelemetry(): Promise<void> {
    const { frameId, centralUrl, token } = this.config;
    if (!frameId || !centralUrl || !token) return;
    const response = await fetch(
      `${centralUrl}/api/v1/frames/${encodeURIComponent(frameId)}/telemetry`,
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(this.status),
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok)
      throw new Error(`Central respondió HTTP ${response.status}`);
  }

  private recordAuxiliaryError(scope: string, error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error);
    const message = `${scope}: ${detail}`;
    this.status.lastError = this.status.lastError
      ? `${this.status.lastError}; ${message}`
      : message;
  }

  private markSuccess(): void {
    this.status.state = "ready";
    this.status.lastSyncAt = new Date().toISOString();
    this.status.lastError = null;
  }

  private async materialize(
    remote: RemoteManifest,
    token: string,
  ): Promise<LocalManifest> {
    await mkdir(this.mediaRoot, { recursive: true });
    const media: LocalMediaItem[] = [];
    for (const item of remote.media) {
      const filename = `${item.sha256}${item.extension.toLowerCase()}`;
      await this.downloadIfMissing(
        item.downloadUrl,
        filename,
        item.sha256,
        token,
      );
      let posterUrl: string | null = null;
      if (item.posterDownloadUrl && item.posterSha256 && item.posterExtension) {
        const posterFilename = `${item.posterSha256}${item.posterExtension.toLowerCase()}`;
        await this.downloadIfMissing(
          item.posterDownloadUrl,
          posterFilename,
          item.posterSha256,
          token,
        );
        posterUrl = `/media/${posterFilename}`;
      }
      let thumbnailUrl: string | null = null;
      if (
        item.thumbnailDownloadUrl &&
        item.thumbnailSha256 &&
        item.thumbnailExtension
      ) {
        const thumbnailFilename = `${item.thumbnailSha256}${item.thumbnailExtension.toLowerCase()}`;
        try {
          await this.downloadIfMissing(
            item.thumbnailDownloadUrl,
            thumbnailFilename,
            item.thumbnailSha256,
            token,
          );
          thumbnailUrl = `/media/${thumbnailFilename}`;
        } catch (error) {
          console.warn(
            JSON.stringify({
              event: "media.thumbnail.download_failed",
              timestamp: new Date().toISOString(),
              mediaId: item.id,
              error: error instanceof Error ? error.message : String(error),
            }),
          );
        }
      }
      media.push({
        id: item.id,
        kind: item.kind,
        url: `/media/${filename}`,
        posterUrl,
        thumbnailUrl,
        caption: item.caption,
        senderName: item.senderName,
        receivedAt: item.receivedAt,
        fitMode: item.fitMode,
        rotationDegrees: item.rotationDegrees,
        durationSeconds: item.durationSeconds,
        sha256: item.sha256,
        sizeBytes: item.sizeBytes,
        posterSizeBytes: item.posterSizeBytes,
        thumbnailSizeBytes: thumbnailUrl ? (item.thumbnailSizeBytes ?? null) : null,
      });
    }
    return {
      schemaVersion: 1,
      frameId: remote.frameId,
      version: remote.version,
      publishedAt: remote.publishedAt,
      settingsRevision: remote.settingsRevision,
      settings: remote.settings,
      media,
    };
  }

  private async installRemoteManifest(
    remote: RemoteManifest,
    materialized: LocalManifest,
  ): Promise<void> {
    await this.withManifestLock(async () => {
      const preserveLocalSettings =
        (await this.hasPendingSettingsChange()) ||
        remote.settingsRevision <= this.manifest.settingsRevision;
      await this.persistManifest({
        ...materialized,
        settingsRevision: preserveLocalSettings
          ? this.manifest.settingsRevision
          : remote.settingsRevision,
        settings: preserveLocalSettings
          ? this.manifest.settings
          : remote.settings,
      });
    });
  }

  private async hasPendingSettingsChange(): Promise<boolean> {
    return this.withOutboxLock(async () => {
      const file = path.join(this.config.dataRoot, "outbox.json");
      const events =
        (await readJson<Array<Record<string, unknown>>>(file)) ?? [];
      return events.some(
        (event) => event.type === "settings.updated" || event.type === "settings.reset",
      );
    });
  }

  private async withOutboxLock<T>(work: () => Promise<T>): Promise<T> {
    const result = this.outboxChain.then(work, work);
    this.outboxChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async withManifestLock<T>(work: () => Promise<T>): Promise<T> {
    const result = this.manifestChain.then(work, work);
    this.manifestChain = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async persistManifest(manifest: LocalManifest): Promise<void> {
    await writeJsonAtomic(this.manifestFile, manifest);
    this.manifest = manifest;
    this.status.manifestVersion = manifest.version;
    await this.reconcileMediaRetention(manifest);
  }

  private async reconcileMediaRetention(manifest: LocalManifest): Promise<void> {
    await mkdir(this.mediaRoot, { recursive: true });
    const stateFile = path.join(this.config.dataRoot, "media-retention.json");
    const retention =
      (await readJson<Record<string, string>>(stateFile)) ?? {};
    const referenced = new Set<string>();
    for (const item of manifest.media) {
      referenced.add(path.basename(item.url));
      if (item.posterUrl) referenced.add(path.basename(item.posterUrl));
      if (item.thumbnailUrl) referenced.add(path.basename(item.thumbnailUrl));
    }
    const files = await readdir(this.mediaRoot);
    const now = Date.now();
    const graceMs = 24 * 60 * 60 * 1_000;
    for (const name of files) {
      if (!/^[a-f0-9]{64}\.[a-z0-9]{2,5}$/i.test(name)) continue;
      if (referenced.has(name)) {
        delete retention[name];
        continue;
      }
      const purgeAt = Date.parse(retention[name] ?? "");
      if (Number.isFinite(purgeAt) && purgeAt <= now) {
        await rm(path.join(this.mediaRoot, name), { force: true });
        delete retention[name];
      } else if (!Number.isFinite(purgeAt)) {
        retention[name] = new Date(now + graceMs).toISOString();
      }
    }
    for (const name of Object.keys(retention)) {
      if (!files.includes(name)) delete retention[name];
    }
    await writeJsonAtomic(stateFile, retention);
  }

  private async downloadIfMissing(
    url: string,
    filename: string,
    expectedHash: string,
    token: string,
  ): Promise<void> {
    const destination = path.join(this.mediaRoot, filename);
    try {
      await access(destination);
      return;
    } catch {
      // El archivo todavía no está en la caché administrada por el agente.
    }
    const temporary = `${destination}.${process.pid}.part`;
    const response = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(120_000),
    });
    if (!response.ok || !response.body)
      throw new Error(`No se pudo descargar ${filename}`);
    const hash = createHash("sha256");
    const input = Readable.fromWeb(response.body as never);
    input.on("data", (chunk: Buffer) => hash.update(chunk));
    try {
      await pipeline(input, createWriteStream(temporary, { mode: 0o600 }));
      if (hash.digest("hex") !== expectedHash.toLowerCase())
        throw new Error(`Hash inválido para ${filename}`);
      await rename(temporary, destination);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }

  private async refreshStorageUsage(forceDataScan = false): Promise<void> {
    await mkdir(this.config.dataRoot, { recursive: true });
    Object.assign(this.status, await collectFileSystemUsage(this.config.dataRoot));
    if (forceDataScan || this.nextDataUsageScanAt <= Date.now()) {
      Object.assign(
        this.status,
        await collectFrameDataUsage(this.config.dataRoot, this.mediaRoot),
      );
      this.nextDataUsageScanAt = Date.now() + 5 * 60_000;
    }
  }
}

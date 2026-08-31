export type FitMode = "contain" | "cover";

export interface FrameSettings {
  photoDurationSeconds: number;
  fadeDurationMs: number;
  defaultFitMode: FitMode;
  order: "newest" | "oldest" | "shuffle";
  volume: number;
  muted: boolean;
  showCaption: boolean;
  showSender: boolean;
  showClock: boolean;
  showDate: boolean;
  showWeather: boolean;
  use24Hour: boolean;
  temperatureUnit: "c" | "f";
}

export interface WeatherSnapshot {
  status: "pending" | "ready" | "stale" | "unavailable";
  location: {
    label: string;
    timezone: string;
    source: "google_wifi" | "maxmind" | "manual" | "telegram";
    accuracyRadiusKm: number | null;
  } | null;
  current: {
    temperatureC: number;
    apparentTemperatureC: number;
    weatherCode: number;
    isDay: boolean;
    observedAt: string;
  } | null;
  fetchedAt: string | null;
  staleAfter: string | null;
  lastError: string | null;
}

export interface RemoteMediaItem {
  id: string;
  kind: "photo" | "video";
  downloadUrl: string;
  posterDownloadUrl: string | null;
  thumbnailDownloadUrl?: string | null;
  extension: string;
  posterExtension: string | null;
  thumbnailExtension?: string | null;
  caption: string | null;
  senderName: string | null;
  receivedAt: string;
  fitMode: FitMode | "inherit";
  rotationDegrees: 0 | 90 | 180 | 270;
  durationSeconds: number | null;
  sha256: string;
  posterSha256: string | null;
  thumbnailSha256?: string | null;
  sizeBytes: number;
  posterSizeBytes: number | null;
  thumbnailSizeBytes?: number | null;
}

export interface LocalMediaItem {
  id: string;
  kind: "photo" | "video";
  url: string;
  posterUrl: string | null;
  thumbnailUrl?: string | null;
  caption: string | null;
  senderName: string | null;
  receivedAt: string;
  fitMode: FitMode | "inherit";
  rotationDegrees: 0 | 90 | 180 | 270;
  durationSeconds: number | null;
  sha256: string;
  sizeBytes: number;
  posterSizeBytes: number | null;
  thumbnailSizeBytes?: number | null;
}

export interface RemoteManifest {
  schemaVersion: 1;
  frameId: string;
  version: number;
  publishedAt: string;
  settingsRevision: number;
  settings: FrameSettings;
  media: RemoteMediaItem[];
}

export interface LocalManifest {
  schemaVersion: 1;
  frameId: string;
  version: number;
  publishedAt: string;
  settingsRevision: number;
  settings: FrameSettings;
  media: LocalMediaItem[];
}

export interface FrameNotification {
  id: string;
  kind: string;
  severity: "info" | "warning" | "error";
  title: string;
  message: string;
  createdAt: string;
  updatedAt: string;
  readAt: string | null;
  resolvedAt: string | null;
}

export interface AgentStatus {
  state:
    | "unconfigured"
    | "ready"
    | "syncing"
    | "storage-blocked"
    | "offline"
    | "error";
  frameId: string | null;
  manifestVersion: number;
  lastSyncAt: string | null;
  lastError: string | null;
  diskTotalBytes: number;
  diskUsedBytes: number;
  diskAvailableBytes: number;
  diskReservedBytes: number;
  diskUsedPercent: number;
  frameDataBytes: number;
  mediaDataBytes: number;
}

export const DEFAULT_SETTINGS: FrameSettings = {
  photoDurationSeconds: 30,
  fadeDurationMs: 450,
  defaultFitMode: "contain",
  order: "newest",
  volume: 0.5,
  muted: false,
  showCaption: true,
  showSender: true,
  showClock: true,
  showDate: true,
  showWeather: true,
  use24Hour: true,
  temperatureUnit: "c",
};

export const EMPTY_WEATHER: WeatherSnapshot = {
  status: "pending",
  location: null,
  current: null,
  fetchedAt: null,
  staleAfter: null,
  lastError: null,
};

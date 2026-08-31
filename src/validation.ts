import {
  DEFAULT_SETTINGS,
  FrameSettings,
  LocalManifest,
  RemoteManifest,
  WeatherSnapshot,
  FrameNotification,
} from "./types.js";

function object(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} no es un objeto válido`);
  }
  return value as Record<string, unknown>;
}

export function normalizeSettings(value: unknown): FrameSettings {
  const input = object(value, "settings");
  const duration = Number(
    input.photoDurationSeconds ?? DEFAULT_SETTINGS.photoDurationSeconds,
  );
  const fade = Number(input.fadeDurationMs ?? DEFAULT_SETTINGS.fadeDurationMs);
  const volume = Number(input.volume ?? DEFAULT_SETTINGS.volume);
  const fit = input.defaultFitMode;
  const order = input.order;
  if (!Number.isFinite(duration) || duration < 1 || duration > 86_400) {
    throw new Error("photoDurationSeconds fuera de rango");
  }
  if (!Number.isFinite(fade) || fade < 0 || fade > 3_000) {
    throw new Error("fadeDurationMs fuera de rango");
  }
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
    throw new Error("volume fuera de rango");
  }
  if (fit !== "contain" && fit !== "cover")
    throw new Error("defaultFitMode inválido");
  if (!["newest", "oldest", "shuffle"].includes(String(order))) {
    throw new Error("order inválido");
  }
  return {
    photoDurationSeconds: Math.round(duration),
    fadeDurationMs: Math.round(fade),
    defaultFitMode: fit,
    order: order as FrameSettings["order"],
    volume,
    muted: Boolean(input.muted),
    showCaption: Boolean(input.showCaption),
    showSender: Boolean(input.showSender),
    showClock:
      input.showClock === undefined
        ? DEFAULT_SETTINGS.showClock
        : Boolean(input.showClock),
    showDate:
      input.showDate === undefined ? DEFAULT_SETTINGS.showDate : Boolean(input.showDate),
    showWeather:
      input.showWeather === undefined
        ? DEFAULT_SETTINGS.showWeather
        : Boolean(input.showWeather),
    use24Hour:
      input.use24Hour === undefined
        ? DEFAULT_SETTINGS.use24Hour
        : Boolean(input.use24Hour),
    temperatureUnit:
      input.temperatureUnit === "f" ? "f" : DEFAULT_SETTINGS.temperatureUnit,
  };
}

export function validateWeatherSnapshot(value: unknown): WeatherSnapshot {
  const input = object(value, "weather");
  const status = String(input.status);
  if (!["pending", "ready", "stale", "unavailable"].includes(status)) {
    throw new Error("Estado meteorológico inválido");
  }
  let location: WeatherSnapshot["location"] = null;
  if (input.location !== null && input.location !== undefined) {
    const raw = object(input.location, "weather.location");
    const source = String(raw.source);
    const accuracyRadiusKm =
      raw.accuracyRadiusKm === null || raw.accuracyRadiusKm === undefined
        ? null
        : Number(raw.accuracyRadiusKm);
    if (
      typeof raw.label !== "string" ||
      raw.label.length < 1 ||
      raw.label.length > 240 ||
      typeof raw.timezone !== "string" ||
      raw.timezone.length < 1 ||
      !["google_wifi", "maxmind", "manual", "telegram"].includes(source) ||
      (accuracyRadiusKm !== null &&
        (!Number.isFinite(accuracyRadiusKm) || accuracyRadiusKm < 0))
    ) {
      throw new Error("Ubicación meteorológica inválida");
    }
    location = {
      label: raw.label,
      timezone: raw.timezone,
      source: source as "google_wifi" | "maxmind" | "manual" | "telegram",
      accuracyRadiusKm,
    };
  }
  let current: WeatherSnapshot["current"] = null;
  if (input.current !== null && input.current !== undefined) {
    const raw = object(input.current, "weather.current");
    const temperatureC = Number(raw.temperatureC);
    const apparentTemperatureC = Number(raw.apparentTemperatureC);
    const weatherCode = Number(raw.weatherCode);
    if (
      !Number.isFinite(temperatureC) ||
      !Number.isFinite(apparentTemperatureC) ||
      !Number.isInteger(weatherCode) ||
      typeof raw.isDay !== "boolean" ||
      typeof raw.observedAt !== "string" ||
      !Number.isFinite(Date.parse(raw.observedAt))
    ) {
      throw new Error("Condición meteorológica inválida");
    }
    current = {
      temperatureC,
      apparentTemperatureC,
      weatherCode,
      isDay: raw.isDay,
      observedAt: raw.observedAt,
    };
  }
  const fetchedAt = nullableDate(input.fetchedAt, "fetchedAt");
  const staleAfter = nullableDate(input.staleAfter, "staleAfter");
  const lastError =
    input.lastError === null || input.lastError === undefined
      ? null
      : String(input.lastError).slice(0, 1_000);
  if ((status === "ready" || status === "stale") && (!location || !current)) {
    throw new Error("Clima vigente sin ubicación o condición");
  }
  return {
    status: status as WeatherSnapshot["status"],
    location,
    current,
    fetchedAt,
    staleAfter,
    lastError,
  };
}

export function validateNotifications(value: unknown): FrameNotification[] {
  const input = object(value, "notifications");
  if (!Array.isArray(input.notifications)) {
    throw new Error("notifications no es una lista válida");
  }
  return input.notifications.slice(0, 100).map((value, index) => {
    const item = object(value, `notifications[${index}]`);
    const severity = String(item.severity);
    if (
      typeof item.id !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(item.id) ||
      typeof item.kind !== "string" ||
      !["info", "warning", "error"].includes(severity) ||
      typeof item.title !== "string" ||
      item.title.length < 1 ||
      item.title.length > 160 ||
      typeof item.message !== "string" ||
      item.message.length < 1 ||
      item.message.length > 1_000
    ) {
      throw new Error(`Notificación ${index} inválida`);
    }
    return {
      id: item.id,
      kind: item.kind.slice(0, 200),
      severity: severity as FrameNotification["severity"],
      title: item.title,
      message: item.message,
      createdAt: requiredDate(item.createdAt, `notifications[${index}].createdAt`),
      updatedAt: requiredDate(item.updatedAt, `notifications[${index}].updatedAt`),
      readAt: nullableDate(item.readAt, `notifications[${index}].readAt`),
      resolvedAt: nullableDate(item.resolvedAt, `notifications[${index}].resolvedAt`),
    };
  });
}

function requiredDate(value: unknown, name: string): string {
  const result = nullableDate(value, name);
  if (!result) throw new Error(`${name} es obligatorio`);
  return result;
}

function nullableDate(value: unknown, name: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) {
    throw new Error(`${name} inválido`);
  }
  return value;
}

export function validateRemoteManifest(
  value: unknown,
  expectedFrameId: string,
): RemoteManifest {
  const input = object(value, "manifest");
  if (input.schemaVersion !== 1 || input.frameId !== expectedFrameId) {
    throw new Error("Manifiesto incompatible o perteneciente a otro marco");
  }
  if (!Number.isSafeInteger(input.version) || Number(input.version) < 0) {
    throw new Error("Versión de manifiesto inválida");
  }
  const settingsRevision = Number(input.settingsRevision ?? 0);
  if (!Number.isSafeInteger(settingsRevision) || settingsRevision < 0) {
    throw new Error("Revisión de configuración inválida");
  }
  if (!Array.isArray(input.media)) throw new Error("Lista de medios inválida");
  for (const raw of input.media) {
    const media = object(raw, "media");
    if (media.kind !== "photo" && media.kind !== "video")
      throw new Error("Tipo de medio inválido");
    if (typeof media.id !== "string" || typeof media.downloadUrl !== "string") {
      throw new Error("Medio sin identificador o URL");
    }
    if (!/^[a-f0-9]{64}$/i.test(String(media.sha256)))
      throw new Error("SHA-256 inválido");
    if (!/^\.[a-z0-9]{2,5}$/i.test(String(media.extension)))
      throw new Error("Extensión inválida");
    if (![0, 90, 180, 270].includes(Number(media.rotationDegrees ?? 0)))
      throw new Error("Rotación inválida");
    const sizeBytes = Number(media.sizeBytes);
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0)
      throw new Error("Tamaño de medio inválido");
    const durationSeconds =
      media.durationSeconds === null || media.durationSeconds === undefined
        ? null
        : Number(media.durationSeconds);
    if (
      durationSeconds !== null &&
      (!Number.isFinite(durationSeconds) || durationSeconds <= 0)
    ) {
      throw new Error("Duración de medio inválida");
    }
    if (media.kind === "video" && durationSeconds === null)
      throw new Error("Video sin duración");
    const posterSizeBytes =
      media.posterSizeBytes === null || media.posterSizeBytes === undefined
        ? null
        : Number(media.posterSizeBytes);
    if (
      posterSizeBytes !== null &&
      (!Number.isSafeInteger(posterSizeBytes) || posterSizeBytes < 0)
    ) {
      throw new Error("Tamaño de póster inválido");
    }
    const thumbnailValues = [
      media.thumbnailDownloadUrl,
      media.thumbnailExtension,
      media.thumbnailSha256,
      media.thumbnailSizeBytes,
    ];
    const hasThumbnail = thumbnailValues.some(
      (value) => value !== null && value !== undefined,
    );
    let thumbnailSizeBytes: number | null = null;
    if (hasThumbnail) {
      if (
        typeof media.thumbnailDownloadUrl !== "string" ||
        !media.thumbnailDownloadUrl ||
        !/^\.[a-z0-9]{2,5}$/i.test(String(media.thumbnailExtension)) ||
        !/^[a-f0-9]{64}$/i.test(String(media.thumbnailSha256))
      ) {
        throw new Error("Miniatura incompleta o inválida");
      }
      thumbnailSizeBytes = Number(media.thumbnailSizeBytes);
      if (!Number.isSafeInteger(thumbnailSizeBytes) || thumbnailSizeBytes < 0) {
        throw new Error("Tamaño de miniatura inválido");
      }
    }
    media.rotationDegrees = Number(media.rotationDegrees ?? 0);
    media.sizeBytes = sizeBytes;
    media.durationSeconds = durationSeconds;
    media.posterSizeBytes = posterSizeBytes;
    media.thumbnailDownloadUrl = hasThumbnail
      ? String(media.thumbnailDownloadUrl)
      : null;
    media.thumbnailExtension = hasThumbnail
      ? String(media.thumbnailExtension)
      : null;
    media.thumbnailSha256 = hasThumbnail ? String(media.thumbnailSha256) : null;
    media.thumbnailSizeBytes = thumbnailSizeBytes;
  }
  return {
    ...(input as unknown as RemoteManifest),
    settingsRevision,
    settings: normalizeSettings(input.settings),
  };
}

export function emptyManifest(frameId = "unconfigured"): LocalManifest {
  return {
    schemaVersion: 1,
    frameId,
    version: 0,
    publishedAt: new Date(0).toISOString(),
    settingsRevision: 0,
    settings: { ...DEFAULT_SETTINGS },
    media: [],
  };
}

import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "../src/types.js";
import {
  normalizeSettings,
  validateRemoteManifest,
  validateWeatherSnapshot,
} from "../src/validation.js";

describe("normalizeSettings", () => {
  it("acepta la configuración predeterminada", () => {
    expect(normalizeSettings(DEFAULT_SETTINGS)).toEqual(DEFAULT_SETTINGS);
  });

  it("rechaza un volumen fuera de rango", () => {
    expect(() => normalizeSettings({ ...DEFAULT_SETTINGS, volume: 2 })).toThrow(
      "volume",
    );
  });
});

describe("validateRemoteManifest", () => {
  it("impide instalar el manifiesto de otro marco", () => {
    expect(() =>
      validateRemoteManifest(
        {
          schemaVersion: 1,
          frameId: "otro",
          version: 1,
          settings: DEFAULT_SETTINGS,
          media: [],
        },
        "este",
      ),
    ).toThrow("otro marco");
  });

  it("normaliza metadatos numéricos recibidos como texto", () => {
    const result = validateRemoteManifest(
      {
        schemaVersion: 1,
        frameId: "este",
        version: 2,
        settingsRevision: 1,
        settings: DEFAULT_SETTINGS,
        media: [
          {
            id: "video-1",
            kind: "video",
            downloadUrl: "https://naiskos.test/video.mp4",
            posterDownloadUrl: "https://naiskos.test/poster.jpg",
            extension: ".mp4",
            posterExtension: ".jpg",
            caption: null,
            senderName: null,
            receivedAt: "2026-08-29T00:00:00.000Z",
            fitMode: "inherit",
            rotationDegrees: "0",
            durationSeconds: "66.026",
            sha256: "a".repeat(64),
            posterSha256: "b".repeat(64),
            sizeBytes: "9697692",
            posterSizeBytes: "2048",
            thumbnailDownloadUrl: "https://naiskos.test/thumbnail.webp",
            thumbnailExtension: ".webp",
            thumbnailSha256: "c".repeat(64),
            thumbnailSizeBytes: "1024",
          },
        ],
      },
      "este",
    );

    expect(result.media[0]).toMatchObject({
      durationSeconds: 66.026,
      sizeBytes: 9_697_692,
      posterSizeBytes: 2_048,
      thumbnailSizeBytes: 1_024,
      rotationDegrees: 0,
    });
  });

  it("mantiene compatible un manifiesto anterior sin miniaturas", () => {
    const result = validateRemoteManifest(
      {
        schemaVersion: 1,
        frameId: "este",
        version: 1,
        settingsRevision: 0,
        settings: DEFAULT_SETTINGS,
        media: [],
      },
      "este",
    );
    expect(result.media).toEqual([]);
  });
});

describe("validateWeatherSnapshot", () => {
  it("normaliza y valida el clima entregado por la central", () => {
    expect(
      validateWeatherSnapshot({
        status: "ready",
        location: {
          label: "Trujillo, La Libertad, PE",
          timezone: "America/Lima",
          source: "maxmind",
          accuracyRadiusKm: "20",
        },
        current: {
          temperatureC: "24.1",
          apparentTemperatureC: 24.8,
          weatherCode: "2",
          isDay: true,
          observedAt: "2026-08-30T01:15:00.000Z",
        },
        fetchedAt: "2026-08-30T01:18:00.000Z",
        staleAfter: "2026-08-30T07:18:00.000Z",
        lastError: null,
      }),
    ).toMatchObject({
      status: "ready",
      location: { accuracyRadiusKm: 20 },
      current: { temperatureC: 24.1, weatherCode: 2 },
    });
  });
});

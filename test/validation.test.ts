import { describe, expect, it } from "vitest";

import { DEFAULT_SETTINGS } from "../src/types.js";
import {
  normalizeSettings,
  validateRemoteManifest,
  validateWeatherSnapshot,
} from "../src/validation.js";

describe("normalizeSettings", () => {
  it("conserva el fondo elegido y mantiene negro en configuraciones antiguas", () => {
    const { collageBackground, ...legacy } = DEFAULT_SETTINGS;
    expect(normalizeSettings(legacy).collageBackground).toBe("black");
    expect(normalizeSettings({ ...legacy, collageBackground: "material" }).collageBackground).toBe("material");
    expect(() => normalizeSettings({ ...legacy, collageBackground: "url(x)" })).toThrow("collageBackground");
  });
  it("conserva collage y normaliza configuraciones anteriores a individual", () => {
    for (const collageMode of ["off", "columns", "adaptive"] as const) {
      expect(normalizeSettings({ ...DEFAULT_SETTINGS, collageMode }).collageMode).toBe(collageMode);
    }
    const { collageMode, ...legacy } = DEFAULT_SETTINGS;
    expect(normalizeSettings(legacy).collageMode).toBe("off");
    expect(() => normalizeSettings({ ...DEFAULT_SETTINGS, collageMode: "recursive" })).toThrow("collageMode");
  });
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
  it.each([null, ["#123456", "#abcdef"], ["#123456", "url(x)"]])("tolera paleta opcional o inválida: %j", (bandColors) => {
    const manifest = { schemaVersion: 1, frameId: "f", version: 1, settings: DEFAULT_SETTINGS,
      media: [{ id: "p", kind: "photo", downloadUrl: "https://naiskos.test/p.webp", extension: ".webp",
        sha256: "a".repeat(64), sizeBytes: 1, bandColors }] };
    const result = validateRemoteManifest(manifest, "f");
    expect(result.media[0].bandColors).toEqual(bandColors?.[1] === "#abcdef" ? bandColors : null);
  });
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

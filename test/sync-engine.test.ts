import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentConfig } from "../src/config.js";
import { SyncEngine } from "../src/sync-engine.js";
import { emptyManifest } from "../src/validation.js";

const pendingWeather = {
  status: "pending",
  location: null,
  current: null,
  fetchedAt: null,
  staleAfter: null,
  lastError: null,
};

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("sincronización del agente", () => {
  it("activa el medio aunque una miniatura opcional no pueda descargarse", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "naiskos-thumbnail-fallback-"));
    temporaryDirectories.push(dataRoot);
    const frameId = "11111111-1111-4111-8111-111111111111";
    const display = Buffer.from("display-compatible");
    const config = {
      host: "127.0.0.1",
      port: 8080,
      dataRoot,
      webRoot: dataRoot,
      centralUrl: "https://naiskos.test",
      frameId,
      token: "token",
      telegramBotUsername: "naiskosbot",
      deviceBootstrapToken: null,
      deviceName: null,
      frameWidth: 1280,
      frameHeight: 800,
      syncIntervalMs: 5_000,
      weatherSyncIntervalMs: 60_000,
      diskBlockPercent: 90,
    } satisfies AgentConfig;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("display.webp")) return new Response(display);
        if (url.endsWith("thumbnail.webp")) return new Response(null, { status: 503 });
        throw new Error(`URL inesperada: ${url}`);
      }),
    );
    const engine = new SyncEngine(config, emptyManifest(frameId));
    const remote = {
      ...emptyManifest(frameId),
      version: 2,
      publishedAt: new Date().toISOString(),
      media: [
        {
          id: "photo-1",
          kind: "photo" as const,
          downloadUrl: "https://naiskos.test/display.webp",
          posterDownloadUrl: null,
          thumbnailDownloadUrl: "https://naiskos.test/thumbnail.webp",
          extension: ".webp",
          posterExtension: null,
          thumbnailExtension: ".webp",
          caption: null,
          senderName: null,
          receivedAt: new Date().toISOString(),
          fitMode: "inherit" as const,
          rotationDegrees: 0 as const,
          durationSeconds: null,
          sha256: createHash("sha256").update(display).digest("hex"),
          posterSha256: null,
          thumbnailSha256: "b".repeat(64),
          sizeBytes: display.length,
          posterSizeBytes: null,
          thumbnailSizeBytes: 123,
        },
      ],
    };
    const materialize = (
      engine as unknown as {
        materialize(value: typeof remote, token: string): Promise<ReturnType<SyncEngine["currentManifest"]>>;
      }
    ).materialize.bind(engine);

    const local = await materialize(remote, "token");

    expect(local.media[0]).toMatchObject({
      url: expect.stringMatching(/^\/media\/[a-f0-9]{64}\.webp$/),
      thumbnailUrl: null,
      thumbnailSizeBytes: null,
    });
  });

  it("expone y reporta un rechazo del outbox sin perder el manifiesto", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "naiskos-sync-"));
    temporaryDirectories.push(dataRoot);
    const frameId = "11111111-1111-4111-8111-111111111111";
    const config: AgentConfig = {
      host: "127.0.0.1",
      port: 8080,
      dataRoot,
      webRoot: dataRoot,
      centralUrl: "https://naiskos.test",
      frameId,
      token: "token",
      telegramBotUsername: "naiskosbot",
      deviceBootstrapToken: null,
      deviceName: null,
      frameWidth: 1280,
      frameHeight: 800,
      syncIntervalMs: 5_000,
      weatherSyncIntervalMs: 60_000,
      diskBlockPercent: 90,
    };
    await writeFile(
      path.join(dataRoot, "outbox.json"),
      JSON.stringify([
        {
          id: "dc3c227d-594e-4a88-ad4c-3ef330394127",
          type: "media.fit-mode.updated",
          mediaId: "local-cb3c5a54911a44a2",
          fitMode: "cover",
        },
      ]),
    );

    let telemetry: Record<string, unknown> | null = null;
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input);
        calls.push(url);
        if (url.endsWith("/weather")) return Response.json(pendingWeather);
        if (url.endsWith("/manifest")) return new Response(null, { status: 304 });
        if (url.endsWith("/events"))
          return Response.json({ error: "rechazado" }, { status: 500 });
        if (url.endsWith("/telemetry")) {
          telemetry = JSON.parse(String(init?.body));
          return new Response(null, { status: 204 });
        }
        throw new Error(`URL inesperada: ${url}`);
      }),
    );

    const engine = new SyncEngine(config, emptyManifest(frameId));
    await expect(engine.sync()).resolves.toBe("unchanged");

    expect(engine.status.state).toBe("ready");
    expect(engine.status.lastError).toBe("Outbox: Central respondió HTTP 500");
    expect(telemetry).toMatchObject({
      state: "ready",
      lastError: "Outbox: Central respondió HTTP 500",
    });
    expect(calls.findIndex((url) => url.endsWith("/events"))).toBeLessThan(
      calls.findIndex((url) => url.endsWith("/manifest")),
    );
  });

  it("una actualización de contenido no pisa ninguna opción productiva", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "naiskos-settings-"));
    temporaryDirectories.push(dataRoot);
    const frameId = "11111111-1111-4111-8111-111111111111";
    const productionSettings = {
      ...emptyManifest().settings,
      photoDurationSeconds: 47,
      fadeDurationMs: 321,
      defaultFitMode: "cover" as const,
      order: "oldest" as const,
      volume: 0.27,
      muted: true,
      showCaption: false,
      showSender: false,
    };
    const local = {
      ...emptyManifest(frameId),
      version: 8,
      settingsRevision: 3,
      settings: productionSettings,
    };
    const config: AgentConfig = {
      host: "127.0.0.1",
      port: 8080,
      dataRoot,
      webRoot: dataRoot,
      centralUrl: "https://naiskos.test",
      frameId,
      token: "token",
      telegramBotUsername: "naiskosbot",
      deviceBootstrapToken: null,
      deviceName: null,
      frameWidth: 1280,
      frameHeight: 800,
      syncIntervalMs: 5_000,
      weatherSyncIntervalMs: 60_000,
      diskBlockPercent: 90,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/weather")) return Response.json(pendingWeather);
        if (url.endsWith("/notifications"))
          return Response.json({ notifications: [] });
        if (url.endsWith("/manifest")) {
          return Response.json({
            schemaVersion: 1,
            frameId,
            version: 9,
            publishedAt: "2026-08-29T21:00:00.000Z",
            settingsRevision: 3,
            settings: {
              photoDurationSeconds: 30,
              fadeDurationMs: 450,
              defaultFitMode: "contain",
              order: "newest",
              volume: 0.5,
              muted: false,
              showCaption: true,
              showSender: true,
            },
            media: [],
          });
        }
        if (url.endsWith("/telemetry")) return new Response(null, { status: 204 });
        throw new Error(`URL inesperada: ${url}`);
      }),
    );

    const engine = new SyncEngine(config, local);
    await expect(engine.sync()).resolves.toBe("updated");
    expect(engine.currentManifest().version).toBe(9);
    expect(engine.currentManifest().settingsRevision).toBe(3);
    expect(engine.currentManifest().settings).toEqual(productionSettings);
  });

  it("adopta todas las opciones cuando existe una revisión explícitamente nueva", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "naiskos-settings-revision-"));
    temporaryDirectories.push(dataRoot);
    const frameId = "11111111-1111-4111-8111-111111111111";
    const remoteSettings = {
      ...emptyManifest().settings,
      photoDurationSeconds: 90,
      fadeDurationMs: 800,
      defaultFitMode: "cover",
      order: "shuffle",
      volume: 0.8,
      muted: false,
      showCaption: false,
      showSender: true,
    };
    const config = {
      host: "127.0.0.1",
      port: 8080,
      dataRoot,
      webRoot: dataRoot,
      centralUrl: "https://naiskos.test",
      frameId,
      token: "token",
      telegramBotUsername: "naiskosbot",
      deviceBootstrapToken: null,
      deviceName: null,
      frameWidth: 1280,
      frameHeight: 800,
      syncIntervalMs: 5_000,
      weatherSyncIntervalMs: 60_000,
      diskBlockPercent: 90,
    } satisfies AgentConfig;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/weather")) return Response.json(pendingWeather);
        if (url.endsWith("/notifications"))
          return Response.json({ notifications: [] });
        if (url.endsWith("/manifest"))
          return Response.json({
            schemaVersion: 1,
            frameId,
            version: 2,
            publishedAt: "2026-08-29T21:00:00.000Z",
            settingsRevision: 1,
            settings: remoteSettings,
            media: [],
          });
        if (url.endsWith("/telemetry")) return new Response(null, { status: 204 });
        throw new Error(`URL inesperada: ${url}`);
      }),
    );

    const engine = new SyncEngine(config, emptyManifest(frameId));
    await engine.sync();
    expect(engine.currentManifest().settingsRevision).toBe(1);
    expect(engine.currentManifest().settings).toEqual(remoteSettings);
  });

  it("sincroniza notificaciones centrales y las conserva localmente", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "naiskos-notifications-"));
    temporaryDirectories.push(dataRoot);
    const frameId = "11111111-1111-4111-8111-111111111111";
    const config = {
      host: "127.0.0.1",
      port: 8080,
      dataRoot,
      webRoot: dataRoot,
      centralUrl: "https://naiskos.test",
      frameId,
      token: "token",
      telegramBotUsername: "naiskosbot",
      deviceBootstrapToken: null,
      deviceName: null,
      frameWidth: 1280,
      frameHeight: 800,
      syncIntervalMs: 5_000,
      weatherSyncIntervalMs: 60_000,
      diskBlockPercent: 90,
    } satisfies AgentConfig;
    const notification = {
      id: "dc3c227d-594e-4a88-ad4c-3ef330394127",
      kind: "media.processing.failed",
      severity: "error",
      title: "Contenido no procesado",
      message: "Vuelve a enviarlo.",
      createdAt: "2026-08-31T14:00:00.000Z",
      updatedAt: "2026-08-31T14:00:00.000Z",
      readAt: null,
      resolvedAt: null,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith("/notifications"))
          return Response.json({ notifications: [notification] });
        if (url.endsWith("/weather")) return Response.json(pendingWeather);
        if (url.endsWith("/manifest")) return new Response(null, { status: 304 });
        if (url.endsWith("/telemetry")) return new Response(null, { status: 204 });
        throw new Error(`URL inesperada: ${url}`);
      }),
    );

    const engine = new SyncEngine(config, emptyManifest(frameId));
    await engine.sync();
    expect(engine.currentNotifications()).toEqual([notification]);
    expect(
      JSON.parse(await readFile(path.join(dataRoot, "notifications.json"), "utf8")),
    ).toEqual([notification]);
  });
});

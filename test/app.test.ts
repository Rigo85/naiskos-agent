import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../src/app.js";
import { AgentConfig } from "../src/config.js";
import { SyncEngine } from "../src/sync-engine.js";
import { emptyManifest } from "../src/validation.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

async function fixture() {
  const dataRoot = await mkdtemp(path.join(os.tmpdir(), "naiskos-agent-"));
  temporaryDirectories.push(dataRoot);
  const config: AgentConfig = {
    host: "127.0.0.1",
    port: 8080,
    dataRoot,
    webRoot: path.join(dataRoot, "missing-browser"),
    centralUrl: null,
    frameId: null,
    token: null,
    telegramBotUsername: "naiskosbot",
    deviceBootstrapToken: null,
    deviceName: null,
    frameWidth: 1280,
    frameHeight: 800,
    syncIntervalMs: 5_000,
    weatherSyncIntervalMs: 60_000,
    diskBlockPercent: 90,
  };
  const engine = new SyncEngine(config, emptyManifest());
  const app = await buildApp(config, engine);
  return { app, engine };
}

describe("agente HTTP", () => {
  it("adopta el frameId real sin borrar el demo y reinicia su versión local", async () => {
    const { app, engine } = await fixture();
    await engine.replaceManifest({
      ...emptyManifest("demo-local"),
      version: 4,
      settings: {
        ...emptyManifest().settings,
        photoDurationSeconds: 45,
      },
    });

    await engine.configure("e410e4df-7e9a-4e18-a088-56a775c1b74e");

    expect(engine.currentManifest()).toMatchObject({
      frameId: "e410e4df-7e9a-4e18-a088-56a775c1b74e",
      version: 0,
      settings: { photoDurationSeconds: 45 },
    });
    await app.close();
  });

  it("expone salud y manifiesto sin requerir conexión central", async () => {
    const { app } = await fixture();
    const health = await app.inject({ method: "GET", url: "/api/v1/health" });
    const manifest = await app.inject({
      method: "GET",
      url: "/api/v1/manifest",
    });
    const weather = await app.inject({ method: "GET", url: "/api/v1/weather" });
    expect(health.statusCode).toBe(200);
    expect(health.json().state).toBe("unconfigured");
    expect(manifest.statusCode).toBe(200);
    expect(manifest.json().media).toEqual([]);
    expect(weather.json()).toMatchObject({ status: "pending", current: null });
    await app.close();
  });

  it("expone, marca y oculta notificaciones persistentes", async () => {
    const { app, engine } = await fixture();
    const firstId = "dc3c227d-594e-4a88-ad4c-3ef330394127";
    const secondId = "ec3c227d-594e-4a88-ad4c-3ef330394128";
    (engine as unknown as { notifications: unknown[] }).notifications = [
      {
        id: firstId,
        kind: "storage.capacity.blocked",
        severity: "error",
        title: "Almacenamiento casi lleno",
        message: "Libera espacio.",
        createdAt: "2026-08-31T14:00:00.000Z",
        updatedAt: "2026-08-31T14:00:00.000Z",
        readAt: null,
        resolvedAt: null,
      },
      {
        id: secondId,
        kind: "media.processing.failed",
        severity: "error",
        title: "Contenido no procesado",
        message: "Vuelve a enviarlo.",
        createdAt: "2026-08-31T14:01:00.000Z",
        updatedAt: "2026-08-31T14:01:00.000Z",
        readAt: null,
        resolvedAt: null,
      },
    ];

    expect(
      (await app.inject({ method: "GET", url: "/api/v1/notifications" })).json()
        .notifications,
    ).toHaveLength(2);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/v1/notifications/${firstId}/read`,
        })
      ).statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/v1/notifications/${secondId}`,
        })
      ).statusCode,
    ).toBe(204);

    const visible = (
      await app.inject({ method: "GET", url: "/api/v1/notifications" })
    ).json().notifications;
    expect(visible).toHaveLength(1);
    expect(visible[0].readAt).toBeTruthy();
    const outbox = JSON.parse(
      await readFile(path.join((engine as unknown as { manifestFile: string }).manifestFile, "..", "outbox.json"), "utf8"),
    ) as Array<Record<string, unknown>>;
    expect(outbox.map((event) => event.type)).toEqual([
      "notification.read",
      "notification.dismissed",
    ]);
    await app.close();
  });

  it("persiste los ajustes locales y valida sus límites", async () => {
    const { app } = await fixture();
    const response = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings",
      payload: {
        photoDurationSeconds: 45,
        fadeDurationMs: 450,
        defaultFitMode: "contain",
        order: "newest",
        volume: 0.5,
        muted: false,
        showCaption: true,
        showSender: true,
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().photoDurationSeconds).toBe(45);
    expect(
      (await app.inject({ method: "GET", url: "/api/v1/manifest" })).json()
        .settings.photoDurationSeconds,
    ).toBe(45);

    const partial = await app.inject({
      method: "PATCH",
      url: "/api/v1/settings",
      payload: { volume: 0.25 },
    });
    expect(partial.json().volume).toBe(0.25);
    expect(partial.json().photoDurationSeconds).toBe(45);
    await app.close();
  });

  it("protege y publica las acciones locales del sistema para el lanzador", async () => {
    const { app } = await fixture();
    const forbidden = await app.inject({
      method: "POST",
      url: "/api/v1/system/actions",
      payload: { action: "exit" },
    });
    expect(forbidden.statusCode).toBe(403);

    const accepted = await app.inject({
      method: "POST",
      url: "/api/v1/system/actions",
      headers: { "x-naiskos-request": "viewer" },
      payload: { action: "exit" },
    });
    expect(accepted.statusCode).toBe(202);
    expect(accepted.json()).toMatchObject({
      accepted: true,
      sequence: 1,
      action: "exit",
    });

    const control = await app.inject({
      method: "GET",
      url: "/api/v1/system/control",
    });
    expect(control.body).toBe("1:exit");
    await app.close();
  });

  it("encola rotación y eliminación sin modificar anticipadamente el manifiesto", async () => {
    const { app, engine } = await fixture();
    const mediaId = "b210a8b6-1a17-4759-af25-2cf1fca0c057";
    await engine.replaceManifest({
      ...emptyManifest("frame-test"),
      media: [
        {
          id: mediaId,
          kind: "photo",
          url: "/media/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.webp",
          posterUrl: null,
          caption: null,
          senderName: null,
          receivedAt: "2026-08-29T00:00:00.000Z",
          fitMode: "inherit",
          rotationDegrees: 0,
          durationSeconds: null,
          sha256: "a".repeat(64),
          sizeBytes: 10,
          posterSizeBytes: null,
        },
      ],
    });

    const rotation = await app.inject({
      method: "POST",
      url: `/api/v1/media/${mediaId}/rotation`,
      payload: { rotationDegrees: 90 },
    });
    const deletion = await app.inject({
      method: "DELETE",
      url: `/api/v1/media/${mediaId}`,
    });

    expect(rotation.statusCode).toBe(202);
    expect(deletion.statusCode).toBe(202);
    expect(engine.currentManifest().media).toHaveLength(1);
    const outbox = JSON.parse(
      await readFile(path.join((engine as unknown as { manifestFile: string }).manifestFile, "..", "outbox.json"), "utf8"),
    ) as Array<Record<string, unknown>>;
    expect(outbox.map((event) => event.type)).toEqual([
      "media.rotation.requested",
      "media.deleted",
    ]);
    await app.close();
  });
});

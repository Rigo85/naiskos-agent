import { createReadStream } from "node:fs";
import { access, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import Fastify, { FastifyInstance, LogController } from "fastify";
import fastifyStatic from "@fastify/static";

import { AgentConfig } from "./config.js";
import { ProvisioningManager } from "./provisioning.js";
import { SyncEngine } from "./sync-engine.js";
import { FitMode } from "./types.js";
import { normalizeSettings } from "./validation.js";
import { errorForLog } from "./logging.js";

type SystemAction = "exit" | "poweroff";

export async function buildApp(
  config: AgentConfig,
  engine: SyncEngine,
  provisioning?: ProvisioningManager,
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: {
      redact: {
        paths: [
          "authorization",
          "cookie",
          "password",
          "secret",
          "token",
          "req.headers.authorization",
          "req.headers.cookie",
          "err.authorization",
          "err.cookie",
          "err.password",
          "err.secret",
          "err.token",
        ],
        censor: "[REDACTED]",
      },
    },
    logController: new LogController({ disableRequestLogging: true }),
    trustProxy: false,
    bodyLimit: 128 * 1024,
  });
  await mkdir(engine.mediaRoot, { recursive: true });
  let systemControl: { sequence: number; action: SystemAction | "none" } = {
    sequence: 0,
    action: "none",
  };

  app.addHook("onError", async (request, _reply, error) => {
    request.log.error({ err: error }, "Petición local fallida");
  });

  app.addHook("onSend", async (request, reply, payload) => {
    if (request.url.startsWith("/api/")) {
      reply.header("cache-control", "no-store");
    }
    reply.header("x-content-type-options", "nosniff");
    return payload;
  });

  app.get("/api/v1/health", async () => ({ ok: true, ...engine.status }));
  app.get("/api/v1/provisioning", async () =>
    provisioning
      ? provisioning.status
      : {
          state: config.frameId && config.token ? "approved" : "disabled",
          requestId: null,
          deepLink: null,
          frameId: config.frameId,
          pairingCode: null,
          pairingDeepLink: null,
        },
  );
  app.get("/api/v1/provisioning/qr.png", async (_request, reply) => {
    const qr = await provisioning?.qrPng();
    if (!qr) return reply.code(404).send({ error: "Alta no pendiente" });
    return reply.type("image/png").send(qr);
  });
  app.post("/api/v1/provisioning/reset", async (request, reply) => {
    if (request.headers["x-naiskos-request"] !== "viewer") {
      return reply.code(403).send({ error: "Solicitud local inválida" });
    }
    if (!provisioning) {
      return reply.code(409).send({ error: "Alta no disponible" });
    }
    try {
      return await provisioning.reset();
    } catch (error) {
      return reply.code(409).send({
        error: error instanceof Error ? error.message : "No se pudo reiniciar el alta",
      });
    }
  });
  app.get("/api/v1/pairing/qr.png", async (_request, reply) => {
    const qr = await provisioning?.pairingQrPng();
    if (!qr) return reply.code(404).send({ error: "Marco todavía no registrado" });
    return reply.type("image/png").send(qr);
  });
  app.post("/api/v1/pairing/rotate", async (request, reply) => {
    if (request.headers["x-naiskos-request"] !== "viewer") {
      return reply.code(403).send({ error: "Solicitud local inválida" });
    }
    if (!provisioning) {
      return reply.code(409).send({ error: "Vinculación no disponible" });
    }
    try {
      return await provisioning.rotatePairingCode();
    } catch (error) {
      return reply.code(409).send({
        error: error instanceof Error ? error.message : "No se pudo cambiar el código",
      });
    }
  });
  app.get("/api/v1/system/control", async (_request, reply) =>
    reply
      .type("text/plain; charset=utf-8")
      .send(`${systemControl.sequence}:${systemControl.action}`),
  );
  app.post<{ Body: { action?: SystemAction } }>(
    "/api/v1/system/actions",
    async (request, reply) => {
      if (request.headers["x-naiskos-request"] !== "viewer") {
        return reply.code(403).send({ error: "Solicitud local inválida" });
      }
      const action = request.body?.action;
      if (action !== "exit" && action !== "poweroff") {
        return reply.code(400).send({ error: "Acción de sistema inválida" });
      }
      await engine.enqueueEvent({
        type: `system.${action}.requested`,
        at: new Date().toISOString(),
        actor: null,
      });
      systemControl = { sequence: systemControl.sequence + 1, action };
      return reply.code(202).send({ accepted: true, ...systemControl });
    },
  );
  app.get("/api/v1/manifest", async (_request, reply) => {
    reply.header("etag", `"${engine.currentManifest().version}"`);
    return engine.currentManifest();
  });
  app.get("/api/v1/weather", async () => engine.currentWeather());
  app.get("/api/v1/notifications", async () => ({
    notifications: engine.currentNotifications(),
  }));
  app.post<{ Params: { id: string } }>(
    "/api/v1/notifications/:id/read",
    async (request, reply) => {
      if (!(await engine.markNotification(request.params.id, "read"))) {
        return reply.code(404).send({ error: "Notificación no encontrada" });
      }
      void engine.sync().catch(() => undefined);
      return reply.code(204).send();
    },
  );
  app.delete<{ Params: { id: string } }>(
    "/api/v1/notifications/:id",
    async (request, reply) => {
      if (!(await engine.markNotification(request.params.id, "dismissed"))) {
        return reply.code(404).send({ error: "Notificación no encontrada" });
      }
      void engine.sync().catch(() => undefined);
      return reply.code(204).send();
    },
  );
  app.post("/api/v1/notifications/read-all", async (_request, reply) => {
    const updated = await engine.markAllNotificationsRead();
    void engine.sync().catch(() => undefined);
    return reply.send({ updated });
  });

  app.patch("/api/v1/settings", async (request, reply) => {
    try {
      const current = engine.currentManifest();
      const settings = normalizeSettings({
        ...current.settings,
        ...(request.body && typeof request.body === "object"
          ? request.body
          : {}),
      });
      await engine.enqueueEvent({
        type: "settings.updated",
        at: new Date().toISOString(),
        settings,
      });
      await engine.updateSettings(settings);
      return settings;
    } catch (error) {
      return reply
        .code(400)
        .send({
          error: error instanceof Error ? error.message : "Ajustes inválidos",
        });
    }
  });

  app.post("/api/v1/settings/reset", async () => {
    const { DEFAULT_SETTINGS } = await import("./types.js");
    const settings = { ...DEFAULT_SETTINGS };
    await engine.enqueueEvent({
      type: "settings.reset",
      at: new Date().toISOString(),
    });
    await engine.updateSettings(settings);
    return settings;
  });

  app.patch<{
    Params: { id: string };
    Body: { fitMode?: FitMode | "inherit" };
  }>(
    "/api/v1/media/:id",
    async (request, reply) => {
      const fitMode = request.body?.fitMode;
      if (fitMode !== "inherit" && fitMode !== "contain" && fitMode !== "cover") {
        return reply.code(400).send({ error: "fitMode inválido" });
      }
      const current = engine.currentManifest();
      const found = current.media.find((item) => item.id === request.params.id);
      if (!found) return reply.code(404).send({ error: "Medio no encontrado" });
      await engine.enqueueEvent({
        type: "media.fit-mode.updated",
        at: new Date().toISOString(),
        mediaId: found.id,
        fitMode,
      });
      const updated = await engine.updateMediaFit(found.id, fitMode);
      if (!updated) return reply.code(404).send({ error: "Medio no encontrado" });
      return updated;
    },
  );

  app.post<{
    Params: { id: string };
    Body: { rotationDegrees?: number };
  }>("/api/v1/media/:id/rotation", async (request, reply) => {
    const rotationDegrees = Number(request.body?.rotationDegrees);
    if (![0, 90, 180, 270].includes(rotationDegrees)) {
      return reply.code(400).send({ error: "Rotación inválida" });
    }
    const found = engine
      .currentManifest()
      .media.find((item) => item.id === request.params.id);
    if (!found) return reply.code(404).send({ error: "Medio no encontrado" });
    await engine.enqueueEvent({
      type: "media.rotation.requested",
      at: new Date().toISOString(),
      mediaId: found.id,
      rotationDegrees,
    });
    void engine.sync().catch((error) =>
      request.log.warn(
        { err: errorForLog(error) },
        "Rotación pendiente de sincronización",
      ),
    );
    return reply.code(202).send({ accepted: true, rotationDegrees });
  });

  app.delete<{ Params: { id: string } }>(
    "/api/v1/media/:id",
    async (request, reply) => {
      const found = engine
        .currentManifest()
        .media.find((item) => item.id === request.params.id);
      if (!found) return reply.code(404).send({ error: "Medio no encontrado" });
      await engine.enqueueEvent({
        type: "media.deleted",
        at: new Date().toISOString(),
        mediaId: found.id,
      });
      void engine.sync().catch((error) =>
        request.log.warn(
          { err: errorForLog(error) },
          "Eliminación pendiente de sincronización",
        ),
      );
      return reply.code(202).send({ accepted: true });
    },
  );

  app.post("/api/v1/sync", async (_request, reply) => {
    try {
      return { result: await engine.sync(), status: engine.status };
    } catch {
      return reply
        .code(502)
        .send({ error: engine.status.lastError, status: engine.status });
    }
  });

  app.get<{ Params: { filename: string } }>(
    "/media/:filename",
    async (request, reply) => {
      if (!/^[a-f0-9]{64}\.[a-z0-9]{2,5}$/i.test(request.params.filename)) {
        return reply.code(404).send();
      }
      const file = path.join(engine.mediaRoot, request.params.filename);
      try {
        await access(file);
        const details = await stat(file);
        const range = parseRange(request.headers.range, details.size);
        reply.header("accept-ranges", "bytes");
        reply.header("cache-control", "private, max-age=31536000, immutable");
        if (range) {
          reply.code(206);
          reply.header(
            "content-range",
            `bytes ${range.start}-${range.end}/${details.size}`,
          );
          reply.header("content-length", String(range.end - range.start + 1));
          return reply
            .type(mediaType(path.extname(file)))
            .send(createReadStream(file, range));
        }
        reply.header("content-length", String(details.size));
        return reply
          .type(mediaType(path.extname(file)))
          .send(createReadStream(file));
      } catch {
        return reply.code(404).send();
      }
    },
  );

  try {
    await access(path.join(config.webRoot, "index.html"));
    await app.register(fastifyStatic, {
      root: config.webRoot,
      wildcard: false,
    });
    app.setNotFoundHandler((_request, reply) => reply.sendFile("index.html"));
  } catch {
    app.setNotFoundHandler((_request, reply) =>
      reply.code(503).type("text/plain").send("Naiskos UI no está instalada."),
    );
  }

  return app;
}

function mediaType(extension: string): string {
  return (
    {
      ".jpg": "image/jpeg",
      ".jpeg": "image/jpeg",
      ".png": "image/png",
      ".webp": "image/webp",
      ".avif": "image/avif",
      ".mp4": "video/mp4",
      ".webm": "video/webm",
    }[extension.toLowerCase()] ?? "application/octet-stream"
  );
}

function parseRange(
  header: string | undefined,
  size: number,
): { start: number; end: number } | null {
  const match = header?.match(/^bytes=(\d*)-(\d*)$/);
  if (!match) return null;
  const suffixLength = !match[1] && match[2] ? Number(match[2]) : null;
  const start =
    suffixLength === null ? Number(match[1]) : Math.max(0, size - suffixLength);
  const end = suffixLength === null && match[2] ? Number(match[2]) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    end >= size
  ) {
    return null;
  }
  return { start, end };
}

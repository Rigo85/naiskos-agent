import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { AgentConfig } from "../src/config.js";
import { SoftwareUpdateManager } from "../src/software-update.js";

const roots: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("vencimiento de actualizaciones", () => {
  it("descarta una solicitud preparada cuando la central deja de autorizarla", async () => {
    const root = await temporaryRoot();
    const releaseId = "20260907-expiry-test-001";
    const releaseRoot = path.join(root, "updates", releaseId);
    await mkdir(releaseRoot, { recursive: true });
    await writeFile(path.join(releaseRoot, "release.tar.gz"), "staged");
    await writeFile(
      path.join(root, "updates", "activation-request.json"),
      JSON.stringify({ releaseId }),
    );
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));

    const manager = new SoftwareUpdateManager(config(root), async () => "event-id");
    await expect(manager.check()).resolves.toBe("none");
    await expect(readFile(path.join(root, "updates", "activation-request.json"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(path.join(releaseRoot, "release.tar.gz"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rechaza una asignación cuyo vencimiento ya pasó", async () => {
    const root = await temporaryRoot();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      campaignId: "11111111-1111-4111-8111-111111111111",
      releaseId: "20260907-expired-test-001",
      maintenanceWindow: { from: "00:00", until: "06:00" },
      observeMinutes: 60,
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      archiveSizeBytes: 1,
      archiveSha256: "a".repeat(64),
      manifestUrl: "https://example.invalid/manifest",
      signatureUrl: "https://example.invalid/signature",
      archiveUrl: "https://example.invalid/archive",
    }), { status: 200, headers: { "content-type": "application/json" } })));

    const manager = new SoftwareUpdateManager(config(root), async () => "event-id");
    await expect(manager.check()).rejects.toThrow("Asignación de software inválida");
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "naiskos-update-expiry-"));
  roots.push(root);
  return root;
}

function config(dataRoot: string): AgentConfig {
  return {
    host: "127.0.0.1",
    port: 8080,
    dataRoot,
    webRoot: dataRoot,
    centralUrl: "https://naiskos.example",
    frameId: "22222222-2222-4222-8222-222222222222",
    token: "token-de-prueba-con-longitud-suficiente",
    telegramBotUsername: "naiskosbot",
    deviceBootstrapToken: null,
    deviceName: null,
    frameWidth: 1280,
    frameHeight: 800,
    syncIntervalMs: 5_000,
    weatherSyncIntervalMs: 60_000,
    diskBlockPercent: 90,
    softwareCheckIntervalMs: 60_000,
    releasePublicKeyPath: path.join(dataRoot, "release-public.pem"),
  };
}

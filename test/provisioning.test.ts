import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AgentConfig } from "../src/config.js";
import {
  loadProvisionedCredentials,
  LocalEnrollmentState,
  ProvisioningManager,
} from "../src/provisioning.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true })),
  );
});

describe("alta del agente", () => {
  it("se registra solo, envía hashes y conserva el código de vinculación", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "naiskos-enrollment-"));
    temporaryDirectories.push(dataRoot);
    const config = fixtureConfig(dataRoot);
    let submission: Record<string, unknown> | null = null;
    const fetcher: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/api/v1/provisioning/automatic") && init?.method === "POST") {
        submission = JSON.parse(String(init.body)) as Record<string, unknown>;
        return Response.json(
          {
            frameId: "e410e4df-7e9a-4e18-a088-56a775c1b74e",
            frameName: "Naiskos prueba",
            created: true,
          },
          { status: 201 },
        );
      }
      if (url.includes("/pairing-code") && init?.method === "PUT") {
        return new Response(null, { status: 204 });
      }
      return new Response(null, { status: 404 });
    };
    const approved: string[] = [];
    const manager = new ProvisioningManager(
      config,
      (frameId) => approved.push(frameId),
      fetcher,
    );

    await manager.initialize();
    const local = JSON.parse(
      await readFile(path.join(dataRoot, "device-enrollment.json"), "utf8"),
    ) as LocalEnrollmentState;
    expect(manager.status.state).toBe("approved");
    expect(manager.status.deepLink).toBeNull();
    expect(manager.status.pairingDeepLink).toContain("t.me/naiskosbot?start=frame_");
    expect(submission?.hardwareFingerprint).toBe(local.hardwareFingerprint);
    expect(submission?.tokenHash).toBe(sha256(local.agentToken));
    expect(submission?.pairingCodeHash).toBe(sha256(local.pairingCode));
    expect(JSON.stringify(submission)).not.toContain(local.agentToken);
    expect(JSON.stringify(submission)).not.toContain(local.pairingCode);
    const qr = await manager.pairingQrPng();
    expect(qr?.subarray(1, 4).toString()).toBe("PNG");

    expect(config.frameId).toBe("e410e4df-7e9a-4e18-a088-56a775c1b74e");
    expect(config.token).toBe(local.agentToken);
    expect(approved).toEqual(["e410e4df-7e9a-4e18-a088-56a775c1b74e"]);
    expect(
      (await stat(path.join(dataRoot, "device-credentials.json"))).mode & 0o777,
    ).toBe(0o600);

    const reloaded = fixtureConfig(dataRoot);
    expect((await loadProvisionedCredentials(reloaded))?.frameId).toBe(
      "e410e4df-7e9a-4e18-a088-56a775c1b74e",
    );
    expect(reloaded.token).toBe(local.agentToken);

    const mismatched = fixtureConfig(dataRoot);
    mismatched.frameId = "a210a8b6-1a17-4759-af25-2cf1fca0c056";
    mismatched.token = local.agentToken;
    await expect(loadProvisionedCredentials(mismatched)).rejects.toThrow(
      /no coinciden/,
    );
  });
});

function fixtureConfig(dataRoot: string): AgentConfig {
  return {
    host: "127.0.0.1",
    port: 8080,
    dataRoot,
    webRoot: path.join(dataRoot, "browser"),
    centralUrl: "https://naiskos.test",
    frameId: null,
    token: null,
    telegramBotUsername: "naiskosbot",
    deviceBootstrapToken: "bootstrap-token-for-tests-which-is-long-enough",
    deviceName: "Naiskos prueba",
    frameWidth: 1280,
    frameHeight: 800,
    syncIntervalMs: 5_000,
    weatherSyncIntervalMs: 60_000,
    diskBlockPercent: 90,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

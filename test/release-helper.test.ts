import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

const execute = promisify(execFile);
const helper = path.resolve("deploy/naiskos-release-helper.mjs");
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })
  ));
});

async function credentialsFile(frameId: string, agentToken: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "naiskos-credentials-"));
  temporaryDirectories.push(root);
  const file = path.join(root, "device-credentials.json");
  await writeFile(file, JSON.stringify({ frameId, agentToken }));
  return file;
}

describe("credenciales del helper privilegiado", () => {
  it("ignora variables vacías y usa la credencial persistida", async () => {
    const frameId = "a210a8b6-1a17-4759-af25-2cf1fca0c056";
    const token = randomBytes(32).toString("base64url");
    const file = await credentialsFile(frameId, token);
    await expect(execute(process.execPath, [helper, "check-central-credentials", file], {
      env: {
        ...process.env,
        NAISKOS_CENTRAL_URL: "https://naiskos.example.test",
        NAISKOS_FRAME_ID: "",
        NAISKOS_AGENT_TOKEN: "",
      },
    })).resolves.toBeDefined();
  });

  it("rechaza fuentes no vacías que discrepan", async () => {
    const file = await credentialsFile(
      "a210a8b6-1a17-4759-af25-2cf1fca0c056",
      randomBytes(32).toString("base64url"),
    );
    await expect(execute(process.execPath, [helper, "check-central-credentials", file], {
      env: {
        ...process.env,
        NAISKOS_CENTRAL_URL: "https://naiskos.example.test",
        NAISKOS_FRAME_ID: "b210a8b6-1a17-4759-af25-2cf1fca0c057",
        NAISKOS_AGENT_TOKEN: randomBytes(32).toString("base64url"),
      },
    })).rejects.toThrow(/no coinciden/);
  });
});

describe("cola durable de mantenimiento", () => {
  it("inicializa la cola antes de ejecutar el comando de vaciado", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "naiskos-maintenance-"));
    temporaryDirectories.push(root);

    await expect(execute(process.execPath, [helper, "flush-maintenance-reports"], {
      env: {
        ...process.env,
        NAISKOS_DATA_ROOT: root,
      },
    })).resolves.toBeDefined();
  });
});

import { createHash, verify } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import { writeJsonAtomic } from "./atomic-store.js";
import { AgentConfig } from "./config.js";

interface SoftwareAssignment {
  campaignId: string;
  releaseId: string;
  maintenanceWindow: { from: string; until: string };
  observeMinutes: number;
  archiveSizeBytes: number;
  archiveSha256: string;
  manifestUrl: string;
  signatureUrl: string;
  archiveUrl: string;
}

interface ReleaseManifest {
  schemaVersion: 1;
  releaseId: string;
  compatibility: {
    architectures: string[];
    minimumBaselineVersion: string;
    nodeMajor: number;
  };
  archive: { filename: string; sizeBytes: number; sha256: string };
  files: Array<{ path: string; sizeBytes: number; sha256: string }>;
  migrations: string[];
}

export class SoftwareUpdateManager {
  private running = false;

  constructor(
    private readonly config: AgentConfig,
    private readonly emit: (event: Record<string, unknown>) => Promise<string>,
  ) {}

  async check(): Promise<"none" | "staged" | "unconfigured"> {
    if (this.running) return "none";
    const { frameId, centralUrl, token } = this.config;
    if (!frameId || !centralUrl || !token) return "unconfigured";
    this.running = true;
    let assignment: SoftwareAssignment | null = null;
    try {
      const response = await fetch(
        `${centralUrl}/api/v1/frames/${encodeURIComponent(frameId)}/software`,
        {
          headers: { authorization: `Bearer ${token}` },
          signal: AbortSignal.timeout(20_000),
        },
      );
      if (response.status === 204) return "none";
      if (!response.ok) throw new Error(`Central respondió HTTP ${response.status}`);
      assignment = validateAssignment(await response.json());
      const updateRoot = path.join(this.config.dataRoot, "updates");
      const releaseRoot = path.join(updateRoot, assignment.releaseId);
      const requestFile = path.join(updateRoot, "activation-request.json");
      try {
        const current = JSON.parse(await readFile(requestFile, "utf8")) as { releaseId?: string };
        if (current.releaseId === assignment.releaseId) return "staged";
      } catch {
        // No hay una activación ya preparada para esta versión.
      }
      await mkdir(releaseRoot, { recursive: true, mode: 0o750 });
      await this.emitStatus(assignment, "downloading");
      const manifestFile = path.join(releaseRoot, "release.json");
      const signatureFile = path.join(releaseRoot, "release.json.sig");
      await this.download(assignment.manifestUrl, manifestFile, token, false);
      await this.download(assignment.signatureUrl, signatureFile, token, false);
      const manifestBytes = await readFile(manifestFile);
      const signature = await readFile(signatureFile);
      const publicKey = await readFile(this.config.releasePublicKeyPath);
      if (!verify(null, manifestBytes, publicKey, signature)) {
        throw new Error("Firma Ed25519 inválida");
      }
      const manifest = validateManifest(JSON.parse(manifestBytes.toString("utf8")), assignment);
      const archiveFile = path.join(releaseRoot, manifest.archive.filename);
      await this.download(assignment.archiveUrl, archiveFile, token, true);
      const archiveDetails = await stat(archiveFile);
      const archiveHash = await sha256File(archiveFile);
      if (
        archiveDetails.size !== manifest.archive.sizeBytes ||
        archiveHash !== manifest.archive.sha256
      ) {
        await rm(archiveFile, { force: true });
        throw new Error("Archivo incompleto o alterado");
      }
      await this.emitStatus(assignment, "verified", 100);
      await writeJsonAtomic(requestFile, {
        schemaVersion: 1,
        campaignId: assignment.campaignId,
        releaseId: assignment.releaseId,
        stagedAt: new Date().toISOString(),
        maintenanceWindow: assignment.maintenanceWindow,
        observeMinutes: assignment.observeMinutes,
        manifestFile,
        signatureFile,
        archiveFile,
      });
      await this.emitStatus(assignment, "awaiting_window", 100);
      return "staged";
    } catch (error) {
      if (assignment) {
        await this.emit({
          type: "software.release.status",
          at: new Date().toISOString(),
          campaignId: assignment.campaignId,
          releaseId: assignment.releaseId,
          status: "failed",
          error: error instanceof Error ? error.message.slice(0, 1_000) : String(error).slice(0, 1_000),
        }).catch(() => undefined);
      }
      throw error;
    } finally {
      this.running = false;
    }
  }

  private async emitStatus(
    assignment: SoftwareAssignment,
    status: string,
    progressPercent?: number,
  ): Promise<void> {
    await this.emit({
      type: "software.release.status",
      at: new Date().toISOString(),
      campaignId: assignment.campaignId,
      releaseId: assignment.releaseId,
      status,
      ...(progressPercent === undefined ? {} : { progressPercent }),
    });
  }

  private async download(
    url: string,
    destination: string,
    token: string,
    resume: boolean,
  ): Promise<void> {
    const temporary = `${destination}.part`;
    let offset = 0;
    if (resume) {
      try {
        offset = (await stat(temporary)).size;
      } catch {
        offset = 0;
      }
    } else {
      await rm(temporary, { force: true });
    }
    const response = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        ...(offset > 0 ? { range: `bytes=${offset}-` } : {}),
      },
      signal: AbortSignal.timeout(10 * 60_000),
    });
    if (!response.ok || !response.body) throw new Error(`Descarga HTTP ${response.status}`);
    const append = offset > 0 && response.status === 206;
    if (offset > 0 && !append) await rm(temporary, { force: true });
    await pipeline(
      Readable.fromWeb(response.body as never),
      createWriteStream(temporary, { flags: append ? "a" : "w", mode: 0o600 }),
    );
    await rename(temporary, destination);
  }
}

function validateAssignment(value: unknown): SoftwareAssignment {
  const assignment = value as Partial<SoftwareAssignment>;
  if (
    !assignment ||
    !isUuid(String(assignment.campaignId ?? "")) ||
    !/^[0-9]{8}[A-Za-z0-9._-]{1,80}$/.test(String(assignment.releaseId ?? "")) ||
    !assignment.maintenanceWindow ||
    typeof assignment.manifestUrl !== "string" ||
    typeof assignment.signatureUrl !== "string" ||
    typeof assignment.archiveUrl !== "string"
  ) throw new Error("Asignación de software inválida");
  return assignment as SoftwareAssignment;
}

function validateManifest(value: unknown, assignment: SoftwareAssignment): ReleaseManifest {
  const manifest = value as Partial<ReleaseManifest>;
  if (
    !manifest || manifest.schemaVersion !== 1 ||
    manifest.releaseId !== assignment.releaseId ||
    manifest.compatibility?.nodeMajor !== 24 ||
    !manifest.compatibility.architectures.includes("arm64") ||
    !manifest.archive || manifest.archive.sha256 !== assignment.archiveSha256 ||
    manifest.archive.sizeBytes !== assignment.archiveSizeBytes ||
    !Array.isArray(manifest.files) || !Array.isArray(manifest.migrations)
  ) throw new Error("Manifiesto de software incompatible");
  return manifest as ReleaseManifest;
}

async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

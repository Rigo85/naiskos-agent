import { createHash, randomBytes, randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";

import QRCode from "qrcode";

import { readJson, writeJsonAtomic } from "./atomic-store.js";
import { AgentConfig } from "./config.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface LocalEnrollmentState {
  schemaVersion: 1;
  requestId: string;
  hardwareSource: "device-tree" | "cpuinfo" | "machine-id" | "generated";
  hardwareFingerprint: string;
  deviceModel: string;
  suggestedName: string;
  agentToken: string;
  claimCode: string;
  pairingCode: string;
  createdAt: string;
}

export interface ProvisionedCredentials {
  schemaVersion: 1;
  frameId: string;
  agentToken: string;
  hardwareFingerprint: string;
  approvedAt: string;
  pairingCode?: string;
}

export interface PublicProvisioningStatus {
  state: "disabled" | "pending" | "approved" | "rejected" | "expired" | "error";
  requestId: string | null;
  deepLink: string | null;
  deviceModel: string | null;
  suggestedName: string | null;
  frameId: string | null;
  expiresAt: string | null;
  lastError: string | null;
  pairingCode: string | null;
  pairingDeepLink: string | null;
}

interface AutomaticEnrollmentResponse {
  frameId: string;
  frameName: string;
  created: boolean;
}

export class ProvisioningManager {
  private readonly enrollmentFile: string;
  private readonly credentialsFile: string;
  private enrollment: LocalEnrollmentState | null = null;
  private publicState: PublicProvisioningStatus = {
    state: "disabled",
    requestId: null,
    deepLink: null,
    deviceModel: null,
    suggestedName: null,
    frameId: null,
    expiresAt: null,
    lastError: null,
    pairingCode: null,
    pairingDeepLink: null,
  };

  constructor(
    private readonly config: AgentConfig,
    private readonly onApproved: (frameId: string) => void | Promise<void>,
    private readonly fetcher: typeof fetch = fetch,
  ) {
    this.enrollmentFile = path.join(config.dataRoot, "device-enrollment.json");
    this.credentialsFile = path.join(config.dataRoot, "device-credentials.json");
  }

  get status(): PublicProvisioningStatus {
    return { ...this.publicState };
  }

  async qrPng(): Promise<Buffer | null> {
    const deepLink = this.publicState.deepLink;
    if (!deepLink || this.publicState.state !== "pending") return null;
    return QRCode.toBuffer(deepLink, {
      type: "png",
      width: 420,
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#17130d", light: "#fffaf0" },
    });
  }

  async pairingQrPng(): Promise<Buffer | null> {
    const deepLink = this.publicState.pairingDeepLink;
    if (!deepLink || this.publicState.state !== "approved") return null;
    return QRCode.toBuffer(deepLink, {
      type: "png",
      width: 420,
      margin: 2,
      errorCorrectionLevel: "M",
      color: { dark: "#17130d", light: "#fffaf0" },
    });
  }

  async initialize(): Promise<void> {
    const credentials = await loadProvisionedCredentials(this.config);
    if (credentials) {
      const completed = await this.ensureCredentialsPairingCode(credentials);
      this.publicState = {
        ...this.publicState,
        state: "approved",
        frameId: completed.frameId,
        pairingCode: displayPairingCode(completed.pairingCode!),
        pairingDeepLink: pairingDeepLink(
          this.config.telegramBotUsername,
          completed.pairingCode!,
        ),
      };
      await this.registerPairingCode(completed).catch((error) => {
        this.publicState.lastError = error instanceof Error ? error.message : String(error);
      });
      return;
    }
    if (this.config.frameId && this.config.token) {
      this.publicState = {
        ...this.publicState,
        state: "approved",
        frameId: this.config.frameId,
      };
      return;
    }
    if (!this.config.centralUrl) return;
    this.enrollment = await ensureEnrollmentState(this.config, this.enrollmentFile);
    this.updatePublicState("pending");
    await this.refresh();
  }

  async refresh(): Promise<void> {
    if (this.publicState.state === "approved") return;
    try {
      await this.submit();
    } catch (error) {
      this.publicState.lastError = error instanceof Error ? error.message : String(error);
      throw error;
    }
  }

  async reset(): Promise<PublicProvisioningStatus> {
    if (this.publicState.state === "approved") {
      throw new Error("El dispositivo ya está aprobado");
    }
    if (!this.config.centralUrl) {
      throw new Error("La central no está configurada");
    }
    await rm(this.enrollmentFile, { force: true });
    this.enrollment = await ensureEnrollmentState(this.config, this.enrollmentFile);
    this.publicState = {
      state: "pending",
      requestId: null,
      deepLink: null,
      deviceModel: null,
      suggestedName: null,
      frameId: null,
      expiresAt: null,
      lastError: null,
      pairingCode: null,
      pairingDeepLink: null,
    };
    this.updatePublicState("pending");
    await this.refresh();
    return this.status;
  }

  async poll(): Promise<void> {
    await this.submit();
  }

  private async submit(): Promise<void> {
    if (!this.enrollment || !this.config.centralUrl) return;
    if (!this.config.deviceBootstrapToken) {
      throw new Error("La credencial de registro automático no está configurada");
    }
    const response = await this.fetcher(
      `${this.config.centralUrl}/api/v1/provisioning/automatic`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${this.config.deviceBootstrapToken}`,
        },
        body: JSON.stringify({
          hardwareFingerprint: this.enrollment.hardwareFingerprint,
          tokenHash: sha256(this.enrollment.agentToken),
          pairingCodeHash: sha256(this.enrollment.pairingCode),
          deviceModel: this.enrollment.deviceModel,
          suggestedName: this.enrollment.suggestedName,
          width: this.config.frameWidth,
          height: this.config.frameHeight,
        }),
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok) {
      throw new Error(`Registro automático respondió HTTP ${response.status}`);
    }
    const remote = (await response.json()) as AutomaticEnrollmentResponse;
    if (!UUID.test(remote.frameId)) throw new Error("La central devolvió un marco inválido");
    const credentials: ProvisionedCredentials = {
      schemaVersion: 1,
      frameId: remote.frameId,
      agentToken: this.enrollment.agentToken,
      hardwareFingerprint: this.enrollment.hardwareFingerprint,
      approvedAt: new Date().toISOString(),
      pairingCode: this.enrollment.pairingCode,
    };
    await writeJsonAtomic(this.credentialsFile, credentials);
    this.config.frameId = credentials.frameId;
    this.config.token = credentials.agentToken;
    this.updatePublicState("approved", credentials.frameId);
    await this.onApproved(credentials.frameId);
  }

  async rotatePairingCode(): Promise<PublicProvisioningStatus> {
    const credentials = await loadProvisionedCredentials(this.config);
    if (!credentials || !credentials.frameId) {
      throw new Error("El marco todavía no está registrado");
    }
    const pairingCode = generatePairingCode();
    const updated = { ...credentials, pairingCode };
    await this.registerPairingCode(updated);
    await writeJsonAtomic(this.credentialsFile, updated);
    this.setPairingPublicState(updated);
    return this.status;
  }

  private async ensureCredentialsPairingCode(
    credentials: ProvisionedCredentials,
  ): Promise<ProvisionedCredentials> {
    if (validPairingCode(credentials.pairingCode)) return credentials;
    const updated = { ...credentials, pairingCode: generatePairingCode() };
    await writeJsonAtomic(this.credentialsFile, updated);
    return updated;
  }

  private async registerPairingCode(credentials: ProvisionedCredentials): Promise<void> {
    if (!this.config.centralUrl || !credentials.pairingCode) return;
    const response = await this.fetcher(
      `${this.config.centralUrl}/api/v1/frames/${credentials.frameId}/pairing-code`,
      {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${credentials.agentToken}`,
        },
        body: JSON.stringify({ pairingCodeHash: sha256(credentials.pairingCode) }),
        signal: AbortSignal.timeout(20_000),
      },
    );
    if (!response.ok) {
      throw new Error(`Registro del código de vinculación respondió HTTP ${response.status}`);
    }
  }

  private setPairingPublicState(credentials: ProvisionedCredentials): void {
    this.publicState = {
      ...this.publicState,
      state: "approved",
      frameId: credentials.frameId,
      pairingCode: displayPairingCode(credentials.pairingCode!),
      pairingDeepLink: pairingDeepLink(
        this.config.telegramBotUsername,
        credentials.pairingCode!,
      ),
      lastError: null,
    };
  }

  private updatePublicState(
    state: PublicProvisioningStatus["state"],
    frameId: string | null = null,
  ): void {
    this.publicState = {
      state,
      requestId: this.enrollment?.requestId ?? null,
      deepLink: null,
      deviceModel: this.enrollment?.deviceModel ?? null,
      suggestedName: this.enrollment?.suggestedName ?? null,
      frameId,
      expiresAt: this.publicState.expiresAt,
      lastError: null,
      pairingCode:
        state === "approved" && this.enrollment
          ? displayPairingCode(this.enrollment.pairingCode)
          : null,
      pairingDeepLink:
        state === "approved" && this.enrollment
          ? pairingDeepLink(this.config.telegramBotUsername, this.enrollment.pairingCode)
          : null,
    };
  }
}

export async function loadProvisionedCredentials(
  config: AgentConfig,
): Promise<ProvisionedCredentials | null> {
  const file = path.join(config.dataRoot, "device-credentials.json");
  const value = await readJson<ProvisionedCredentials>(file);
  if (
    !value ||
    value.schemaVersion !== 1 ||
    !UUID.test(value.frameId) ||
    Buffer.from(value.agentToken, "base64url").length !== 32 ||
    !/^[a-f0-9]{64}$/i.test(value.hardwareFingerprint)
  ) {
    return null;
  }
  config.frameId = value.frameId;
  config.token = value.agentToken;
  return value;
}

async function ensureEnrollmentState(
  config: AgentConfig,
  file: string,
): Promise<LocalEnrollmentState> {
  const current = await readJson<LocalEnrollmentState>(file);
  if (
    current?.schemaVersion === 1 &&
    UUID.test(current.requestId) &&
    /^[a-f0-9]{64}$/i.test(current.hardwareFingerprint) &&
    Buffer.from(current.agentToken, "base64url").length === 32 &&
    /^[A-Za-z0-9_-]{24}$/.test(current.claimCode)
  ) {
    if (validPairingCode(current.pairingCode)) return current;
    const upgraded = { ...current, pairingCode: generatePairingCode() };
    await writeJsonAtomic(file, upgraded);
    return upgraded;
  }
  const identity = await readHardwareIdentity(config.dataRoot);
  const state: LocalEnrollmentState = {
    schemaVersion: 1,
    requestId: randomUUID(),
    hardwareSource: identity.source,
    hardwareFingerprint: identity.fingerprint,
    deviceModel: identity.model,
    suggestedName:
      config.deviceName ?? `Naiskos ${identity.fingerprint.slice(0, 6).toUpperCase()}`,
    agentToken: randomBytes(32).toString("base64url"),
    claimCode: randomBytes(18).toString("base64url"),
    pairingCode: generatePairingCode(),
    createdAt: new Date().toISOString(),
  };
  await writeJsonAtomic(file, state);
  return state;
}

export async function readHardwareIdentity(
  dataRoot: string,
): Promise<{
  source: LocalEnrollmentState["hardwareSource"];
  fingerprint: string;
  model: string;
}> {
  const model =
    clean(await readOptional("/proc/device-tree/model")) ??
    `Equipo ${hostname()}`;
  const candidates: Array<{
    source: LocalEnrollmentState["hardwareSource"];
    value: string | null;
  }> = [
    { source: "device-tree", value: clean(await readOptional("/proc/device-tree/serial-number")) },
    { source: "cpuinfo", value: cpuInfoSerial(await readOptional("/proc/cpuinfo")) },
    { source: "machine-id", value: clean(await readOptional("/etc/machine-id")) },
  ];
  const found = candidates.find((candidate) => candidate.value);
  if (found?.value) {
    return {
      source: found.source,
      fingerprint: sha256(`naiskos-device-v1:${found.source}:${found.value.toLowerCase()}`),
      model,
    };
  }
  const fallbackFile = path.join(dataRoot, "generated-device-id.json");
  const saved = await readJson<{ id?: string }>(fallbackFile);
  const generated =
    saved?.id && /^[a-f0-9]{64}$/i.test(saved.id)
      ? saved.id
      : randomBytes(32).toString("hex");
  if (saved?.id !== generated) await writeJsonAtomic(fallbackFile, { id: generated });
  return {
    source: "generated",
    fingerprint: sha256(`naiskos-device-v1:generated:${generated}`),
    model,
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

const PAIRING_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function generatePairingCode(): string {
  const bytes = randomBytes(12);
  return [...bytes]
    .map((value) => PAIRING_ALPHABET[value % PAIRING_ALPHABET.length])
    .join("");
}

function validPairingCode(value: unknown): value is string {
  return typeof value === "string" && /^[A-HJ-NP-Z2-9]{12}$/.test(value);
}

function displayPairingCode(value: string): string {
  return value.match(/.{1,4}/g)?.join("-") ?? value;
}

function pairingDeepLink(username: string, code: string): string {
  return `https://t.me/${username}?start=frame_${code}`;
}

async function readOptional(file: string): Promise<string | null> {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

function clean(value: string | null): string | null {
  const normalized = value?.replaceAll("\0", "").trim();
  return normalized || null;
}

function cpuInfoSerial(value: string | null): string | null {
  return clean(value?.match(/^Serial\s*:\s*(\S+)$/m)?.[1] ?? null);
}

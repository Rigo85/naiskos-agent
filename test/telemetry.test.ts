import { describe, expect, it } from "vitest";

import { heartbeatTelemetry, telemetryErrorCode } from "../src/telemetry.js";
import { AgentStatus } from "../src/types.js";

const status: AgentStatus = {
  state: "ready",
  frameId: "11111111-1111-4111-8111-111111111111",
  manifestVersion: 8,
  lastSyncAt: "2026-08-31T23:55:00.000Z",
  lastError: null,
  diskTotalBytes: 100,
  diskUsedBytes: 20,
  diskAvailableBytes: 70,
  diskReservedBytes: 10,
  diskUsedPercent: 22.22,
  frameDataBytes: 15,
  mediaDataBytes: 10,
};

describe("telemetría remota", () => {
  it("genera un heartbeat pequeño sin mensajes internos", () => {
    expect(heartbeatTelemetry(status)).toMatchObject({
      schemaVersion: 1,
      kind: "heartbeat",
      agentState: "ready",
      installedManifestVersion: 8,
      lastSyncAt: status.lastSyncAt,
      lastErrorCode: null,
    });
  });

  it("normaliza errores a códigos acotados y no publica el detalle", () => {
    expect(telemetryErrorCode("Outbox: token que no debe salir")).toBe("outbox");
    expect(telemetryErrorCode("Clima: timeout")).toBe("clima");
  });
});

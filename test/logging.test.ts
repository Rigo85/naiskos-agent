import { describe, expect, it } from "vitest";

import { errorForLog } from "../src/logging.js";

describe("errorForLog", () => {
  it("conserva un Error y su causa para el serializador de Pino", () => {
    const error = new Error("fallo exterior", {
      cause: new Error("fallo interior"),
    });
    expect(errorForLog(error)).toBe(error);
    expect(errorForLog(error).cause).toBeInstanceOf(Error);
  });

  it("conserva valores lanzados que no son Error y oculta secretos", () => {
    const thrown: Record<string, unknown> = {
      code: "ECONNRESET",
      detail: "conexión cerrada",
      token: "no-publicar",
      telegramToken: "tampoco-publicar",
    };
    thrown.circular = thrown;

    const normalized = errorForLog(thrown);
    expect(normalized.message).toContain("ECONNRESET");
    expect(normalized.message).toContain("conexión cerrada");
    expect(normalized.message).toContain("[REDACTED]");
    expect(normalized.message).toContain("[Circular]");
    expect(normalized.message).not.toContain("no-publicar");
    expect(normalized.message).not.toContain("tampoco-publicar");
  });
});

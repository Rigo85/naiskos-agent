import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ReposeManager, scheduledActive } from "../src/repose.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function managerAt(now: Date) {
  const root = await mkdtemp(path.join(os.tmpdir(), "naiskos-repose-"));
  directories.push(root);
  const events: Record<string, unknown>[] = [];
  const manager = await ReposeManager.create(root, async (event) => { events.push(event); }, "23:30", "07:00", now);
  return { root, events, manager };
}

describe("reposo persistente", () => {
  it("considera activo el horario que cruza medianoche", () => {
    const schedule = { from: "23:30", until: "07:00" };
    expect(scheduledActive(new Date(2026, 8, 14, 23, 45), schedule)).toBe(true);
    expect(scheduledActive(new Date(2026, 8, 15, 6, 59), schedule)).toBe(true);
    expect(scheduledActive(new Date(2026, 8, 15, 7, 0), schedule)).toBe(false);
    expect(scheduledActive(new Date(2026, 8, 15, 12, 0), schedule)).toBe(false);
  });

  it("persiste la activación manual y registra sólo los cambios reales", async () => {
    const now = new Date(2026, 8, 14, 15, 0);
    const { root, events, manager } = await managerAt(now);
    expect(manager.current().active).toBe(false);

    const active = await manager.setManual(true, now);
    expect(active.active).toBe(true);
    expect(active.source).toBe("manual");
    expect(active.overrideUntil).not.toBeNull();
    expect(events.map((event) => event.type)).toEqual(["repose.entered"]);

    await manager.setManual(true, now);
    expect(events).toHaveLength(1);
    expect(JSON.parse(await readFile(path.join(root, "repose.json"), "utf8"))).toMatchObject({
      schemaVersion: 1,
      active: true,
      source: "manual",
    });
  });

  it("respeta una salida manual nocturna hasta el próximo límite", async () => {
    const night = new Date(2026, 8, 14, 23, 45);
    const { manager } = await managerAt(night);
    expect(manager.current().active).toBe(true);
    await manager.setManual(false, night);
    expect((await manager.setScheduled(true, new Date(2026, 8, 15, 0, 5))).active).toBe(false);
  });
});

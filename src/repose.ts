import path from "node:path";

import { readJson, writeJsonAtomic } from "./atomic-store.js";

export type ReposeSource = "manual" | "schedule";

export interface ReposeState {
  schemaVersion: 1;
  active: boolean;
  source: ReposeSource | null;
  enteredAt: string | null;
  updatedAt: string;
  overrideUntil: string | null;
  schedule: { from: string; until: string };
}

type EventWriter = (event: Record<string, unknown>) => Promise<unknown>;

export class ReposeManager {
  private state: ReposeState;
  private chain: Promise<unknown> = Promise.resolve();

  private constructor(
    private readonly file: string,
    private readonly writeEvent: EventWriter,
    schedule: ReposeState["schedule"],
    state: ReposeState,
  ) {
    this.state = { ...state, schedule };
  }

  static async create(
    dataRoot: string,
    writeEvent: EventWriter,
    from = "23:30",
    until = "07:00",
    now = new Date(),
  ): Promise<ReposeManager> {
    const schedule = { from: validTime(from, "23:30"), until: validTime(until, "07:00") };
    const file = path.join(dataRoot, "repose.json");
    const stored = normalizeState(await readJson<unknown>(file), schedule, now);
    const manager = new ReposeManager(file, writeEvent, schedule, stored);
    await manager.reconcile(now);
    return manager;
  }

  current(): ReposeState {
    return structuredClone(this.state);
  }

  setManual(active: boolean, now = new Date()): Promise<ReposeState> {
    return this.update(
      active,
      "manual",
      nextBoundary(now, active ? this.state.schedule.until : this.state.schedule.from),
      now,
    );
  }

  setScheduled(active: boolean, now = new Date()): Promise<ReposeState> {
    if (this.state.overrideUntil && Date.parse(this.state.overrideUntil) > now.getTime()) {
      return Promise.resolve(this.current());
    }
    return this.update(active, "schedule", null, now);
  }

  private async reconcile(now: Date): Promise<void> {
    const overrideActive = this.state.overrideUntil && Date.parse(this.state.overrideUntil) > now.getTime();
    if (overrideActive) {
      await writeJsonAtomic(this.file, this.state);
      return;
    }
    const active = scheduledActive(now, this.state.schedule);
    const timestamp = now.toISOString();
    this.state = {
      ...this.state,
      active,
      source: active ? "schedule" : null,
      enteredAt: active ? this.state.enteredAt ?? timestamp : null,
      updatedAt: timestamp,
      overrideUntil: null,
    };
    await writeJsonAtomic(this.file, this.state);
  }

  private update(
    active: boolean,
    source: ReposeSource,
    overrideUntil: string | null,
    now = new Date(),
  ): Promise<ReposeState> {
    const operation = this.chain.then(async () => {
      const changed = this.state.active !== active;
      const timestamp = now.toISOString();
      this.state = {
        ...this.state,
        active,
        source,
        enteredAt: active ? (changed ? timestamp : this.state.enteredAt ?? timestamp) : null,
        updatedAt: timestamp,
        overrideUntil,
      };
      await writeJsonAtomic(this.file, this.state);
      if (changed) {
        await this.writeEvent({
          type: active ? "repose.entered" : "repose.exited",
          at: timestamp,
          source,
          actor: source === "manual" ? "viewer" : null,
        });
      }
      return this.current();
    });
    this.chain = operation.catch(() => undefined);
    return operation;
  }
}

function normalizeState(
  value: unknown,
  schedule: ReposeState["schedule"],
  now: Date,
): ReposeState {
  const body = value && typeof value === "object" ? value as Record<string, unknown> : null;
  const updatedAt = typeof body?.updatedAt === "string" && Number.isFinite(Date.parse(body.updatedAt))
    ? body.updatedAt : now.toISOString();
  return {
    schemaVersion: 1,
    active: body?.active === true,
    source: body?.source === "manual" || body?.source === "schedule" ? body.source : null,
    enteredAt: typeof body?.enteredAt === "string" && Number.isFinite(Date.parse(body.enteredAt))
      ? body.enteredAt : null,
    updatedAt,
    overrideUntil:
      typeof body?.overrideUntil === "string" && Number.isFinite(Date.parse(body.overrideUntil))
        ? body.overrideUntil : null,
    schedule,
  };
}

function validTime(value: string, fallback: string): string {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(value) ? value : fallback;
}

function minutes(value: string): number {
  const [hour, minute] = value.split(":").map(Number);
  return hour! * 60 + minute!;
}

export function scheduledActive(now: Date, schedule: ReposeState["schedule"]): boolean {
  const current = now.getHours() * 60 + now.getMinutes();
  const from = minutes(schedule.from);
  const until = minutes(schedule.until);
  if (from === until) return false;
  return from < until ? current >= from && current < until : current >= from || current < until;
}

function nextBoundary(now: Date, value: string): string {
  const [hour, minute] = value.split(":").map(Number);
  const boundary = new Date(now);
  boundary.setHours(hour!, minute!, 0, 0);
  if (boundary.getTime() <= now.getTime()) boundary.setDate(boundary.getDate() + 1);
  return boundary.toISOString();
}

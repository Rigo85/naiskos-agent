import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { collectStorageUsage } from "../src/storage-usage.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("collectStorageUsage", () => {
  it("separa el uso del filesystem, la data del marco y sus medios", async () => {
    const dataRoot = await mkdtemp(path.join(os.tmpdir(), "naiskos-storage-"));
    temporaryDirectories.push(dataRoot);
    const mediaRoot = path.join(dataRoot, "media");
    await mkdir(mediaRoot);
    const mediaFile = path.join(mediaRoot, "sample.webp");
    const stateFile = path.join(dataRoot, "manifest.json");
    await writeFile(mediaFile, Buffer.alloc(8_192, 1));
    await writeFile(stateFile, Buffer.alloc(4_096, 2));

    const usage = await collectStorageUsage(dataRoot, mediaRoot);
    const mediaDetails = await stat(mediaFile);

    expect(usage.diskTotalBytes).toBeGreaterThan(0);
    expect(usage.diskUsedBytes).toBeGreaterThan(0);
    expect(usage.diskAvailableBytes).toBeGreaterThan(0);
    expect(usage.diskUsedPercent).toBeGreaterThan(0);
    expect(usage.diskUsedPercent).toBeLessThan(100);
    expect(usage.mediaDataBytes).toBeGreaterThanOrEqual(mediaDetails.blocks * 512);
    expect(usage.frameDataBytes).toBeGreaterThan(usage.mediaDataBytes);
  });
});

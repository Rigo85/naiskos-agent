import { describe, expect, it } from "vitest";

import { ViewerMonitor, ViewerPlaybackSnapshot } from "../src/viewer-monitor.js";

const playback: ViewerPlaybackSnapshot = {
  mediaId: "video-1",
  mediaKind: "video",
  state: "playing",
  currentTime: 9,
  duration: 12,
  readyState: 4,
  networkState: 1,
  paused: false,
  ended: false,
  seeking: false,
  view: "viewer",
};

describe("monitor del visor", () => {
  it("reinicia Chromium al perder latidos, con gracia inicial y enfriamiento", () => {
    const start = Date.parse("2026-09-13T12:00:00.000Z");
    const monitor = new ViewerMonitor(start);
    expect(monitor.claimRestart(start + 120_000)).toBe(false);
    expect(monitor.claimRestart(start + 120_001)).toBe(true);
    expect(monitor.claimRestart(start + 180_000)).toBe(false);

    monitor.record(playback, start + 200_000);
    expect(monitor.snapshot(start + 230_000)).toMatchObject({
      connected: true,
      heartbeatAgeSeconds: 30,
      playback: { mediaId: "video-1", state: "playing" },
    });
    expect(monitor.claimRestart(start + 245_000)).toBe(false);
    expect(monitor.claimRestart(start + 245_001)).toBe(true);
  });
});

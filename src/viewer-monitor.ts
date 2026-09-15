export type ViewerPlaybackState =
  | "empty"
  | "photo"
  | "loading"
  | "playing"
  | "paused"
  | "waiting"
  | "recovering"
  | "repose"
  | "error";

export interface ViewerPlaybackSnapshot {
  mediaId: string | null;
  mediaKind: "photo" | "video" | null;
  state: ViewerPlaybackState;
  currentTime: number;
  duration: number;
  readyState: number;
  networkState: number;
  paused: boolean;
  ended: boolean;
  seeking: boolean;
  view: "viewer" | "overlay" | "repose";
  navigation: ViewerNavigationSnapshot;
}

export interface ViewerNavigationSnapshot {
  phase: "stable" | "staging" | "transitioning" | "degraded";
  operationId: number | null;
  candidateMediaId: string | null;
  candidateMediaSha256: string | null;
  phaseElapsedMs: number;
  deadlineMs: number | null;
  failuresInOperation: number;
}

export interface ViewerMonitorSnapshot {
  connected: boolean;
  lastHeartbeatAt: string | null;
  heartbeatAgeSeconds: number | null;
  restartsRequested: number;
  playback: ViewerPlaybackSnapshot | null;
}

const STARTUP_GRACE_MS = 120_000;
const HEARTBEAT_STALE_MS = 45_000;
const RESTART_COOLDOWN_MS = 120_000;
const NAVIGATION_DEADLINE_GRACE_MS = 15_000;

export class ViewerMonitor {
  private readonly startedAt: number;
  private lastHeartbeatAt: number | null = null;
  private lastRestartAt: number | null = null;
  private playback: ViewerPlaybackSnapshot | null = null;
  private restartsRequested = 0;

  constructor(now = Date.now()) {
    this.startedAt = now;
  }

  record(playback: ViewerPlaybackSnapshot, now = Date.now()): void {
    this.playback = { ...playback };
    this.lastHeartbeatAt = now;
  }

  claimRestart(now = Date.now()): boolean {
    const reference = this.lastHeartbeatAt ?? this.startedAt;
    const staleAfter = this.lastHeartbeatAt === null ? STARTUP_GRACE_MS : HEARTBEAT_STALE_MS;
    const heartbeatStale = now - reference > staleAfter;
    const navigation = this.playback?.navigation;
    const navigationStuck = Boolean(
      this.lastHeartbeatAt !== null &&
      now - this.lastHeartbeatAt <= HEARTBEAT_STALE_MS &&
      this.playback?.view === "viewer" &&
      (navigation?.phase === "staging" || navigation?.phase === "transitioning") &&
      navigation.deadlineMs !== null &&
      navigation.phaseElapsedMs > navigation.deadlineMs + NAVIGATION_DEADLINE_GRACE_MS,
    );
    if (!heartbeatStale && !navigationStuck) return false;
    if (this.lastRestartAt !== null && now - this.lastRestartAt <= RESTART_COOLDOWN_MS) return false;
    this.lastRestartAt = now;
    this.restartsRequested += 1;
    return true;
  }

  snapshot(now = Date.now()): ViewerMonitorSnapshot {
    const ageMs = this.lastHeartbeatAt === null ? null : Math.max(0, now - this.lastHeartbeatAt);
    return {
      connected: ageMs !== null && ageMs <= HEARTBEAT_STALE_MS,
      lastHeartbeatAt:
        this.lastHeartbeatAt === null ? null : new Date(this.lastHeartbeatAt).toISOString(),
      heartbeatAgeSeconds: ageMs === null ? null : Math.floor(ageMs / 1_000),
      restartsRequested: this.restartsRequested,
      playback: this.playback ? { ...this.playback } : null,
    };
  }
}

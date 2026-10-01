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
  lease?: { id: string; revision: number; elapsedMs: number; budgetMs: number;
    suspended: boolean; pauseRemainingMs: number | null; expired: boolean };
  buildId?: string;
  sessionId?: string;
  uiReady?: boolean;
  quiescedFor?: string | null;
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
  private visit = '';
  private safetyAt: number | null = null;
  private safetyElapsed = 0;
  private progressAt = 0;
  private position = 0;
  private pausedElapsed = 0;
  private budget = 0;
  private revision = 0;
  private reportedBudget = 0;
  private photoSeconds = 30;
  private durationSeconds = 120;
  private interactionElapsed = 0;
  private phaseKey = '';
  private phaseAt = 0;
  private readonly retiredSessions = new Set<string>();

  configurePlayback(durationSeconds: number | null, photoSeconds: number): void {
    this.durationSeconds = Number.isFinite(durationSeconds) && Number(durationSeconds) > 0 ? Math.min(122, Number(durationSeconds)) : 120;
    this.photoSeconds = photoSeconds;
  }

  private suspended(): boolean {
    return !this.playback || this.playback.view !== 'viewer' ||
      this.playback.quiescedFor != null ||
      ['staging', 'transitioning'].includes(this.playback.navigation.phase) ||
      (this.playback.navigation.phase === 'degraded' && this.playback.navigation.deadlineMs !== null);
  }

  private advanceSafety(now: number): void {
    let delta = this.safetyAt === null ? 0 : Math.max(0, now - this.safetyAt);
    if (this.playback?.mediaKind === 'photo' && this.playback.lease?.suspended && !this.suspended()) {
      const exempt = Math.min(delta, Math.max(0, 30_000 - this.interactionElapsed));
      this.interactionElapsed += delta;
      delta -= exempt;
    } else this.interactionElapsed = 0;
    if (!this.suspended()) {
      if (this.playback?.state === 'paused') this.pausedElapsed += delta;
      else this.safetyElapsed += delta;
    }
    this.safetyAt = now;
  }

  playbackHealth(now = performance.now()): { healthy: boolean; reason: string | null } {
    this.advanceSafety(now);
    const nav = this.playback?.navigation;
    if (this.playback?.view === 'viewer' && nav && nav.phase !== 'stable' && nav.deadlineMs !== null &&
      now - this.phaseAt > Math.min(nav.deadlineMs, 30_000) + 15_000)
      return { healthy: false, reason: 'navigation-budget-expired' };
    if (!this.playback?.mediaId || this.suspended()) return { healthy: true, reason: null };
    const reason = this.playback.state === 'paused'
      ? (this.pausedElapsed > this.photoSeconds * 1000 + 15_000 ? 'pause-budget-expired' : null)
      : this.safetyElapsed > this.budget + 15_000 ? 'scene-budget-expired'
      : this.playback.mediaKind === 'video' && this.safetyElapsed - this.progressAt > 30_000 ? 'video-no-progress' : null;
    return { healthy: reason === null, reason };
  }

  constructor(now = Date.now()) {
    this.startedAt = now;
  }

  record(playback: ViewerPlaybackSnapshot, now = Date.now(), monotonicNow = performance.now()): void {
    if (playback.sessionId && this.retiredSessions.has(playback.sessionId)) return;
    if (playback.sessionId && this.playback?.sessionId && playback.sessionId !== this.playback.sessionId) {
      this.retiredSessions.add(this.playback.sessionId);
      if (this.retiredSessions.size > 8) this.retiredSessions.delete(this.retiredSessions.values().next().value!);
    }
    // HTTP completion order may differ from emission order at a scene boundary.
    if (playback.sessionId === this.playback?.sessionId && playback.lease && this.playback?.lease) {
      const incoming = Number(playback.lease.id.split(':').at(-1));
      const previous = Number(this.playback.lease.id.split(':').at(-1));
      if (Number.isSafeInteger(incoming) && Number.isSafeInteger(previous) && incoming < previous) return;
    }
    this.advanceSafety(monotonicNow);
    const visit = `${playback.sessionId ?? ''}:${playback.lease?.id ?? playback.mediaId}`;
    const phaseKey = `${visit}:${playback.view}:${playback.navigation.phase}:${playback.navigation.operationId}`;
    if (phaseKey !== this.phaseKey) { this.phaseKey = phaseKey; this.phaseAt = monotonicNow; }
    if (visit !== this.visit) {
      this.interactionElapsed = 0;
      this.visit = visit;
      this.safetyElapsed = 0;
      this.progressAt = 0;
      this.pausedElapsed = 0;
      this.position = playback.currentTime;
      this.revision = playback.lease?.revision ?? 0;
      this.reportedBudget = playback.lease?.budgetMs ?? 0;
      this.budget = playback.mediaKind === 'video'
        ? Math.max(0, this.durationSeconds - Math.min(playback.currentTime, this.durationSeconds)) * 1000 + 20_000
        : this.photoSeconds * 1000 + 1_000;
    } else {
      if (playback.lease && playback.lease.revision > this.revision) {
        // Explicit user seek/photo interaction. Never trust reported elapsed time.
        this.budget = playback.mediaKind === 'video'
          ? Math.max(this.safetyElapsed, this.budget + Math.max(-122_000,
            Math.min(122_000, playback.lease.budgetMs - this.reportedBudget)))
          : this.safetyElapsed + this.photoSeconds * 1000 + 1_000;
        this.revision = playback.lease.revision;
        this.reportedBudget = playback.lease.budgetMs;
        this.progressAt = this.safetyElapsed;
      }
      if (!playback.seeking && !playback.paused && playback.currentTime > this.position + 0.05)
        this.progressAt = this.safetyElapsed;
      if (playback.state !== 'paused' && this.playback?.state === 'paused') {
        this.pausedElapsed = 0;
        this.progressAt = this.safetyElapsed;
      }
      this.position = playback.currentTime;
    }
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
    if (!heartbeatStale && !navigationStuck && this.playbackHealth().healthy) return false;
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

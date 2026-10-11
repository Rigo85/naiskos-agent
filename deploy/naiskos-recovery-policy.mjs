// Pure policy: deadlines use boot uptime, never wall-clock/NTP.
export const DAY = 24 * 60 * 60_000;
export function advanceClock(state, bootId, uptimeMs) {
  const sameBoot = state.bootId === bootId;
  const elapsed = sameBoot ? Math.max(0, uptimeMs - (state.uptimeMs ?? uptimeMs)) : 0;
  state.cooldownMs = Math.max(0, (state.cooldownMs ?? 0) - elapsed);
  if (!sameBoot) {
    state.unhealthySince = null; state.healthySince = null;
    state.progress = null; state.progressSeen = false;
    state.attempts = 0; state.agentAttempts = 0;
  }
  state.bootId = bootId; state.uptimeMs = uptimeMs;
  return sameBoot;
}
export function functionalProgress(state, runtime, current, now) {
  const playback = runtime?.viewer?.playback;
  if (!runtime?.ready || !current?.browserLive) {
    state.healthySince = null; state.progressSeen = false; state.progress = null;
    return false;
  }
  const progress = JSON.stringify([playback?.sessionId, playback?.lease?.id,
    playback?.mediaKind === 'photo' ? playback?.lease?.elapsedMs : playback?.currentTime]);
  if (state.progress !== null && state.progress !== progress) state.progressSeen = true;
  state.progress = progress;
  state.healthySince ??= now;
  // A responsive menu/rest screen is intentional, not a frozen slideshow.
  const intentionalView = ['repose', 'overlay'].includes(playback?.view);
  return now - state.healthySince >= 120_000 && (state.progressSeen || intentionalView);
}
export function recoveryDecision(state, { now, intentionalExit, ready, apiAvailable, blocked }) {
  if (intentionalExit) { state.unhealthySince = null; return 'idle'; }
  if (ready) { state.unhealthySince = null; return 'idle'; }
  state.unhealthySince ??= now;
  if (now - state.unhealthySince < 120_000) return 'wait';
  if (state.cooldownMs > 0 && state.incident?.status === 'limited') return 'limited';
  if (!apiAvailable && state.agentAttempts < 1) return 'restart-agent';
  if (blocked || state.attempts >= 3) return state.cooldownMs > 0 ? 'limited' : 'reboot';
  return 'restart-viewer';
}

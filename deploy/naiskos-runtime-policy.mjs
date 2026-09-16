// Pure policy shared by the activator and its regression tests.
export function runtimeHealthy(runtime, processStatus, expectedBuild) {
  return runtime?.schemaVersion === 1 && runtime.ready === true &&
    runtime.agentBuildId === expectedBuild && runtime.viewer?.connected === true &&
    runtime.viewer.playback?.buildId === expectedBuild && runtime.viewer.playback.uiReady === true &&
    processStatus?.browserLive === true && processStatus.launcherPresent === true;
}

export function observe(previous, sample) {
  const state = { ...previous };
  const sameBoot = state.bootId === sample.bootId;
  const sameSession = state.agentInstanceId === sample.agentInstanceId && state.viewerSessionId === sample.viewerSessionId;
  const delta = sameBoot && sameSession && Number.isFinite(state.lastUptime) ? sample.uptime - state.lastUptime : 0;
  if (!sameBoot) state.graceUntilUptime = sample.uptime + 120;
  state.bootId = sample.bootId;
  state.agentInstanceId = sample.agentInstanceId;
  state.viewerSessionId = sample.viewerSessionId;
  state.lastUptime = sample.uptime;
  state.observedSeconds = Number(state.observedSeconds ?? 0);
  state.failures = Number(state.failures ?? 0);
  if (sample.paused || sample.uptime < (state.graceUntilUptime ?? 0)) {
    state.lastHealthy = false;
    return { state, decision: 'wait' };
  }
  if (sample.healthy) {
    if (state.lastHealthy && delta > 0 && delta <= 420) state.observedSeconds += delta;
    state.failures = 0;
    state.lastHealthy = true;
    return { state, decision: state.observedSeconds >= state.observeMinutes * 60 ? 'installed' : 'wait' };
  }
  state.lastHealthy = false;
  state.failures += 1;
  return { state, decision: state.failures >= 3 ? 'rollback' : 'wait' };
}

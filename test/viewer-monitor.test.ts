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
  navigation: {
    phase: "stable",
    operationId: null,
    candidateMediaId: null,
    candidateMediaSha256: null,
    phaseElapsedMs: 0,
    deadlineMs: null,
    failuresInOperation: 0,
  },
};

describe("monitor del visor", () => {
  it('no retrocede por un heartbeat tardío de una escena o sesión sustituida', () => {
    const monitor=new ViewerMonitor(0);
    const lease={id:'one:2',revision:0,elapsedMs:0,budgetMs:30000,suspended:false,pauseRemainingMs:null,expired:false};
    monitor.record({...playback,sessionId:'one',lease},0,0);
    monitor.record({...playback,sessionId:'one',lease:{...lease,id:'one:1'}},1000,1000);
    expect(monitor.snapshot(1000).playback?.lease?.id).toBe('one:2');
    monitor.record({...playback,sessionId:'two',lease:{...lease,id:'two:1'}},2000,2000);
    monitor.record({...playback,sessionId:'one',lease:{...lease,id:'one:3'}},3000,3000);
    expect(monitor.snapshot(3000).playback?.sessionId).toBe('two');
  });
  it('una biblioteca indisponible con reintentos vivos no genera una tormenta de reinicios', () => {
    const monitor=new ViewerMonitor(0);
    const navigation={...playback.navigation,phase:'degraded' as const,deadlineMs:30000};
    for(let t=0;t<=600000;t+=30000){
      monitor.record({...playback,state:'error',navigation:{...navigation,operationId:t}},t,t);
      expect(monitor.playbackHealth(t).healthy).toBe(true);
    }
    // The retry mechanism itself stopped: independent agent clock still detects it.
    expect(monitor.playbackHealth(646000).reason).toBe('navigation-budget-expired');
  });
  it('movimiento de barra explícito ajusta el presupuesto sin regenerar margen', () => {
    const monitor=new ViewerMonitor(0); monitor.configurePlayback(60,30);
    const lease={id:'one:1',revision:0,elapsedMs:0,budgetMs:80000,suspended:false,pauseRemainingMs:null,expired:false};
    monitor.record({...playback,currentTime:0,lease},0,0);
    monitor.record({...playback,currentTime:20,lease},20000,20000);
    monitor.record({...playback,currentTime:10,lease:{...lease,revision:1,budgetMs:90000}},20001,20001);
    for(let t=30000;t<=105000;t+=15000) monitor.record({...playback,currentTime:10+(t-20000)/1000,
      lease:{...lease,revision:1,budgetMs:90000}},t,t);
    expect(monitor.playbackHealth(105001).reason).toBe('scene-budget-expired');
  });
  it('detecta el seeking de 63.590/63.914 aunque lleguen latidos y elapsed falso', () => {
    const monitor = new ViewerMonitor(0);
    monitor.configurePlayback(63.914,30);
    const stuck = { ...playback, sessionId:'one', state:'loading' as const, seeking:true,
      currentTime:63.589997, duration:63.914,
      lease:{id:'visit',revision:0,elapsedMs:0,budgetMs:83914,suspended:false,pauseRemainingMs:null,expired:false} };
    for(let t=0;t<=45000;t+=15000) monitor.record(stuck,t,t);
    expect(monitor.playbackHealth(45000).healthy).toBe(false);
  });
  it('el tiempo total vence aunque el reproductor declare pequeños avances', () => {
    const monitor = new ViewerMonitor(0);
    monitor.configurePlayback(5,30);
    for(let t=0;t<=45000;t+=15000) monitor.record({...playback,currentTime:t/100000},t,t);
    expect(monitor.playbackHealth(45000)).toEqual({healthy:false,reason:'scene-budget-expired'});
  });
  it('menú y reposo no consumen presupuesto ni causan reinicios', () => {
    const monitor = new ViewerMonitor(0);
    monitor.configurePlayback(64,30);
    monitor.record({...playback,currentTime:0},0,0);
    monitor.record({...playback,currentTime:10,view:'repose'},10000,10000);
    monitor.record({...playback,currentTime:10,view:'repose'},3600000,3600000);
    expect(monitor.playbackHealth(3600000).healthy).toBe(true);
    monitor.record({...playback,currentTime:10},3600001,3600001);
    expect(monitor.playbackHealth(3600001).healthy).toBe(true);
  });
  it('una pausa manual excedida no queda exenta para siempre', () => {
    const monitor = new ViewerMonitor(0);
    monitor.configurePlayback(64,30);
    monitor.record({...playback,state:'paused',paused:true},0,0);
    monitor.record({...playback,state:'paused',paused:true},46000,46000);
    expect(monitor.playbackHealth(46000).reason).toBe('pause-budget-expired');
  });
  it('cada repetición normal del mismo archivo tiene identidad nueva', () => {
    const monitor = new ViewerMonitor(0);
    const lease={id:'one',revision:0,elapsedMs:0,budgetMs:30000,suspended:false,pauseRemainingMs:null,expired:false};
    monitor.configurePlayback(10,30);
    monitor.record({...playback,currentTime:0,lease},0,0);
    monitor.record({...playback,currentTime:0,lease:{...lease,id:'two'}},60000,60000);
    expect(monitor.playbackHealth(60000).healthy).toBe(true);
  });
  it('un salto de reloj civil no altera los plazos monotónicos', () => {
    const monitor = new ViewerMonitor(0);
    monitor.record({...playback,currentTime:0},100000000,0);
    monitor.record({...playback,currentTime:1},1,1000);
    expect(monitor.playbackHealth(1000).healthy).toBe(true);
  });
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

  it("reinicia un visor que sigue latiendo pero excedió el plazo de navegación", () => {
    const start = Date.parse("2026-09-15T12:00:00.000Z");
    const monitor = new ViewerMonitor(start);
    monitor.record({
      ...playback,
      mediaKind: "photo",
      state: "photo",
      navigation: {
        phase: "staging",
        operationId: 42,
        candidateMediaId: "photo-bad",
        candidateMediaSha256: "a".repeat(64),
        phaseElapsedMs: 20_001,
        deadlineMs: 5_000,
        failuresInOperation: 1,
      },
    }, start + 1_000);
    expect(monitor.claimRestart(start + 1_001)).toBe(true);
  });

  it("no interpreta el reposo ni una navegación dentro de plazo como bloqueo", () => {
    const start = Date.parse("2026-09-15T12:00:00.000Z");
    const monitor = new ViewerMonitor(start);
    monitor.record({
      ...playback,
      state: "repose",
      view: "repose",
      navigation: {
        phase: "staging",
        operationId: 7,
        candidateMediaId: "video-2",
        candidateMediaSha256: "b".repeat(64),
        phaseElapsedMs: 60_000,
        deadlineMs: 5_000,
        failuresInOperation: 0,
      },
    }, start + 1_000);
    expect(monitor.claimRestart(start + 1_001)).toBe(false);
  });
});

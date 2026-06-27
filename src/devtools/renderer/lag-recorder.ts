/**
 * Renderer-side event-loop lag recorder - the renderer half of the freeze
 * flight recorder (mirrors `src/main/diagnostics/event-loop-lag.ts`).
 *
 * The renderer is a single thread shared by every xterm, the React board, and
 * all input, so a stall here IS a visible UI freeze. A timer measures its own
 * drift; stalls beyond the threshold land in a bounded ring with timestamps,
 * queryable via the `window.__kangenticLagReport` global the inspection server
 * reads. So when a user reports "the UI just froze", the recorded history shows
 * exactly when and for how long the renderer thread blocked.
 *
 * Dev-only: installed by `DevtoolsBootstrap`, which renders only behind the
 * `__KANGENTIC_DEV__` guard in `App.tsx`.
 */

interface RendererLagSpike {
  at: string;
  lagMs: number;
}

interface RendererLagReport {
  monitoring: boolean;
  monitoringForMs: number | null;
  sampleIntervalMs: number;
  spikeThresholdMs: number;
  samples: number;
  maxLagMs: number;
  spikeCount: number;
  recentSpikes: RendererLagSpike[];
}

// Keep these three constants in sync with event-loop-lag.ts (the main-process
// half) so the merged /event-loop-lag report compares like-for-like spikes.
const SAMPLE_INTERVAL_MS = 100;
const SPIKE_THRESHOLD_MS = 75;
const RING_SIZE = 120;

let timer: ReturnType<typeof setInterval> | null = null;
let startedAtMs: number | null = null;
let lastFire = 0;
let samples = 0;
let maxLagMs = 0;
let spikeCount = 0;
const recentSpikes: RendererLagSpike[] = [];

export function startRendererLagRecorder(): void {
  if (timer) return;
  startedAtMs = Date.now();
  lastFire = performance.now();
  timer = setInterval(() => {
    const now = performance.now();
    const lag = now - lastFire - SAMPLE_INTERVAL_MS;
    lastFire = now;
    samples += 1;
    if (lag > maxLagMs) maxLagMs = lag;
    if (lag >= SPIKE_THRESHOLD_MS) {
      spikeCount += 1;
      recentSpikes.push({ at: new Date().toISOString(), lagMs: Math.round(lag) });
      while (recentSpikes.length > RING_SIZE) recentSpikes.shift();
    }
  }, SAMPLE_INTERVAL_MS);
}

export function stopRendererLagRecorder(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export function getRendererLagReport(): RendererLagReport {
  return {
    monitoring: timer !== null,
    monitoringForMs: startedAtMs !== null ? Date.now() - startedAtMs : null,
    sampleIntervalMs: SAMPLE_INTERVAL_MS,
    spikeThresholdMs: SPIKE_THRESHOLD_MS,
    samples,
    maxLagMs: Math.round(maxLagMs),
    spikeCount,
    recentSpikes: [...recentSpikes],
  };
}

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
  /** Max lag from a VISIBLE-window sample (throttle artifacts are excluded). */
  maxLagMs: number;
  /** Spike count from VISIBLE-window samples only. */
  spikeCount: number;
  /** Recent VISIBLE-window spikes only (background-throttle spikes never enter the ring). */
  recentSpikes: RendererLagSpike[];
  /** Whether the window was hidden at report time. */
  documentHidden: boolean;
  /** Spikes attributed to background throttling (window hidden), not real freezes. */
  hiddenSpikeCount: number;
  /** Max lag observed while the window was throttled (background), in ms. */
  maxHiddenLagMs: number;
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
// Background-throttle artifacts are routed here instead of the ring. When
// `document.hidden`, Chromium throttles this 100ms sampler to >=1s, so every
// hidden sample reads as a ~900ms "spike" that would otherwise flood the ring
// (2 minutes of background evicts all real freeze history) and dominate maxLagMs.
let hiddenSpikeCount = 0;
let maxHiddenLagMs = 0;
let lastSampleHidden = false;

function isDocumentHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden === true;
}

export function startRendererLagRecorder(): void {
  if (timer) return;
  startedAtMs = Date.now();
  lastFire = performance.now();
  timer = setInterval(() => {
    const now = performance.now();
    const lag = now - lastFire - SAMPLE_INTERVAL_MS;
    lastFire = now;
    samples += 1;
    const hidden = isDocumentHidden();
    // The first VISIBLE sample after foregrounding still carries the throttle
    // backlog, so classify it as an artifact via the previous-sample flag.
    const throttleArtifact = hidden || lastSampleHidden;
    lastSampleHidden = hidden;
    if (throttleArtifact) {
      if (lag > maxHiddenLagMs) maxHiddenLagMs = lag;
      if (lag >= SPIKE_THRESHOLD_MS) hiddenSpikeCount += 1;
      return;
    }
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
    documentHidden: isDocumentHidden(),
    hiddenSpikeCount,
    maxHiddenLagMs: Math.round(maxHiddenLagMs),
  };
}

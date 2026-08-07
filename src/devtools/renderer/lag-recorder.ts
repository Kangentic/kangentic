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
 * The sampler answers WHEN, never WHAT: a `{at, lagMs}` pair carries no stack and
 * no label, so every diagnosis using it alone ends in a guess about which code ran.
 * A second ring closes that, built on `long-animation-frame`, which the browser
 * annotates with each contributing script's registration URL and function name plus
 * a style/layout breakdown. The two rings share a wall-clock stamp, so a spike and
 * the frame that caused it line up by timestamp in one report. Concretely, the
 * split is the diagnosis: script time names JS, `styleLayoutMs` names a layout or
 * style cost, and a script's `forcedLayoutMs` names read/write thrash.
 *
 * Dev-only: installed by `DevtoolsBootstrap`, which renders only behind the
 * `__KANGENTIC_DEV__` guard in `App.tsx`.
 */

interface RendererLagSpike {
  at: string;
  lagMs: number;
}

/** One script's contribution to a long frame, as attributed by the browser. */
interface RendererLongFrameScript {
  /** Where the callback was REGISTERED (a module URL in dev), not where it was called from. */
  sourceURL: string;
  sourceFunctionName: string;
  /** What ran it: `user-callback` (rAF, ResizeObserver), `event-listener`, `module-script`. */
  invokerType: string;
  /** The specific invoker, e.g. `DIV#root.onclick` or `FrameRequestCallback`. */
  invoker: string;
  durationMs: number;
  /** Time this script spent in layout it forced by reading geometry it had just invalidated. */
  forcedLayoutMs: number;
}

interface RendererLongFrame {
  /** Wall-clock, so an entry joins to `recentSpikes[].at` by timestamp. */
  at: string;
  durationMs: number;
  /** Duration past the 50ms long-task bar, i.e. how long input was actually blocked. */
  blockingMs: number;
  /** Time in rendering (style, layout, paint, compositing commit) for this frame. */
  renderMs: number;
  /** Time in style and layout specifically. The discriminator for a layout-property animation. */
  styleLayoutMs: number;
  /** Attributed scripts, heaviest first. Trivial ones are dropped to bound the payload. */
  scripts: RendererLongFrameScript[];
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
  /**
   * Recent long animation frames, with per-script attribution. The lag sampler above says
   * WHEN the thread blocked; this says WHAT ran. `unavailable` where the runtime has no
   * `long-animation-frame` entry type.
   */
  recentLongFrames: RendererLongFrame[] | 'unavailable';
}

/**
 * Minimal shapes for the `long-animation-frame` entry type. Declared here rather than
 * imported: TypeScript's DOM lib does not yet ship `PerformanceLongAnimationFrameTiming`,
 * and the alternative is an `any` cast, which this codebase does not allow.
 */
interface LongAnimationFrameScript extends PerformanceEntry {
  sourceURL?: string;
  sourceFunctionName?: string;
  invokerType?: string;
  invoker?: string;
  forcedStyleAndLayoutDuration?: number;
}

interface LongAnimationFrameTiming extends PerformanceEntry {
  blockingDuration?: number;
  renderStart?: number;
  styleAndLayoutStart?: number;
  scripts?: LongAnimationFrameScript[];
}

// Keep these three constants in sync with event-loop-lag.ts (the main-process
// half) so the merged /event-loop-lag report compares like-for-like spikes.
const SAMPLE_INTERVAL_MS = 100;
const SPIKE_THRESHOLD_MS = 75;
const RING_SIZE = 120;

// The long-frame ring is separate and shorter: each entry carries its attributed scripts, so
// it is far heavier than a `{at, lagMs}` spike, and the report is read over an HTTP bridge.
const LONG_FRAME_RING_SIZE = 60;
// A script contributing less than this to a frame is noise next to the one that caused it.
const LONG_FRAME_SCRIPT_FLOOR_MS = 5;
// Enough to name the cause without turning one frame into a wall of text.
const LONG_FRAME_SCRIPTS_PER_FRAME = 5;

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

const recentLongFrames: RendererLongFrame[] = [];
let longFrameObserver: PerformanceObserver | null = null;
let longFrameSupported = false;

function isDocumentHidden(): boolean {
  return typeof document !== 'undefined' && document.hidden === true;
}

function toLongFrame(entry: LongAnimationFrameTiming): RendererLongFrame {
  const endTime = entry.startTime + entry.duration;
  const scripts = (entry.scripts ?? [])
    .map((script) => ({
      sourceURL: script.sourceURL ?? '',
      sourceFunctionName: script.sourceFunctionName ?? '',
      invokerType: script.invokerType ?? '',
      invoker: script.invoker ?? '',
      durationMs: Math.round(script.duration),
      forcedLayoutMs: Math.round(script.forcedStyleAndLayoutDuration ?? 0),
    }))
    .filter((script) => script.durationMs >= LONG_FRAME_SCRIPT_FLOOR_MS)
    .sort((left, right) => right.durationMs - left.durationMs)
    .slice(0, LONG_FRAME_SCRIPTS_PER_FRAME);
  return {
    // `startTime` is relative to `timeOrigin`; converting to wall clock is what lets a long
    // frame be lined up against a `recentSpikes` entry, which is the whole point of carrying
    // both rings in one report.
    at: new Date(performance.timeOrigin + entry.startTime).toISOString(),
    durationMs: Math.round(entry.duration),
    blockingMs: Math.round(entry.blockingDuration ?? 0),
    renderMs: entry.renderStart ? Math.round(endTime - entry.renderStart) : 0,
    styleLayoutMs: entry.styleAndLayoutStart ? Math.round(endTime - entry.styleAndLayoutStart) : 0,
    scripts,
  };
}

function startLongFrameObserver(): void {
  if (longFrameObserver) return;
  const supportedTypes = PerformanceObserver.supportedEntryTypes ?? [];
  if (!supportedTypes.includes('long-animation-frame')) return;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      recentLongFrames.push(toLongFrame(entry as LongAnimationFrameTiming));
      while (recentLongFrames.length > LONG_FRAME_RING_SIZE) recentLongFrames.shift();
    }
  });
  // `buffered` replays the frames the browser already recorded before this ran, so the
  // report covers boot rather than starting from whenever the devtools bootstrap mounted.
  //
  // FIRST attach only. The ring deliberately survives a stop - it is a flight recorder, like
  // `recentSpikes` - and the browser's own entry buffer still holds those same frames, so
  // replaying it on a RE-attach (a dev remount of DevtoolsBootstrap) would push a second copy
  // of frames the ring already carries. A duplicated spike reads as a real repeat, which is
  // exactly the wrong conclusion for a tool whose whole job is attribution.
  observer.observe({ type: 'long-animation-frame', buffered: !longFrameSupported });
  // Published only once `observe` has succeeded. Assigning before it would leave a non-null
  // observer that never observed, and the guard at the top of this function would then block
  // every retry for the rest of the session.
  longFrameObserver = observer;
  longFrameSupported = true;
}

export function startRendererLagRecorder(): void {
  if (timer) return;
  startLongFrameObserver();
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
  if (longFrameObserver) {
    longFrameObserver.disconnect();
    longFrameObserver = null;
  }
}

// Both handles this module owns - a setInterval and a PerformanceObserver - outlive the module
// itself on a dev update. `DevtoolsBootstrap`'s effect has an empty dependency array
// (install.tsx), so it does not re-run on every Fast Refresh; editing this file would otherwise
// leave the OLD instance's interval and observer running forever against a discarded module,
// invisible to `getRendererLagReport()` (which reads the NEW instance's bindings) and
// compounding on every save for the rest of the session. Pattern D from
// .claude/rules/hmr-patterns.md, applied at the module that owns the handle.
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose(() => {
    stopRendererLagRecorder();
  });
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
    recentLongFrames: longFrameSupported ? [...recentLongFrames] : 'unavailable',
  };
}

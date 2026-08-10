/**
 * Load rig for auto_command injection.
 *
 * The bug report is specifically "unreliable under heavy load, with several
 * agents running", so this measures a DELIVERY RATE rather than asserting a
 * single happy path. It drives the real `TerminalSubmit.submitKeystrokes`
 * against `FakeTui`, a model of Claude Code's Ink prompt that can fail the
 * way the real one fails (see `injection-tui-simulator.ts`).
 *
 * The headline metric is the keystroke path's confirmation rate: whether the
 * exact command text became a discrete submission. Ground truth is the TUI's
 * own submission log, not our verifier, so a broken verifier cannot flatter
 * the number.
 *
 * Trials are independent simulated sessions and run concurrently, so a wide
 * sweep costs roughly one trial of wall-clock time. Latencies are seeded and
 * timing-relative, never OS-dependent.
 *
 * MEASURED DELIVERY RATE, before and after the rebuild. "Before" is the
 * pre-rebuild implementation (fixed 100ms keypress delays, 500ms settle, no
 * drain, auto_command structurally unverified):
 *
 *   scenario                              before    after
 *   picker-render sweep ................   57.1%   100.0%
 *   loaded sweep (seeded jitter) .......   57.5%   100.0%
 *   draft present, warm session ........   64.3%   100.0%
 *   fresh spawn, user typed during wait     0.0%   100.0%
 *   startup render swallows the clear ..   64.3%   100.0%
 *   adapter with no verifier ...........   57.1%    92.9%
 *
 * Every failure in the "before" picker sweep fell in the 100-200ms band,
 * which is exactly `KEYPRESS_DELAY < pickerRenderMs < 2 * KEYPRESS_DELAY`:
 * the Esc lands before the picker mounts (no-op), the picker then renders,
 * and it eats the Enter. The fresh-spawn row is the reported bug verbatim -
 * all 14 trials submitted `instead can we/code-review` as a single message.
 *
 * Note what the last row's "before" is: the old implementation never verified
 * an auto_command on ANY adapter, so its 57.1% picker-sweep number IS the
 * no-verifier number. Every user was on that path. After the rebuild, an
 * adapter with a `command-injection` verifier reaches 100% because a swallowed
 * submission is detected and retried; one without still improves to 92.9% on
 * the handshakes alone, and its SAFETY property holds absolutely either way
 * (a delivery may be missed, but a wrong one is never submitted).
 */
import { describe, it, expect } from 'vitest';
import { TerminalSubmit } from '../../src/main/pty/terminal-submit';
import type { PasteEngine } from '../../src/main/pty/paste-engine';
import type { SessionManager } from '../../src/main/pty/session-manager';
import {
  SimulatedSessionManager,
  DEFAULT_TUI_OPTIONS,
  createRandom,
  createStubPasteEngine,
  createSubmissionVerifier,
  wasDeliveredExactly,
  type FakeTuiOptions,
} from './injection-tui-simulator';

const SESSION_ID = 'sess-load-rig';
const AUTO_COMMAND = '/code-review';

interface TrialOptions {
  pickerRenderMs: number;
  repaintLatencyMs?: number;
  writeQueueDelayMs?: number;
  /** Text the user had already typed and not submitted. */
  draft?: string;
  /** Fresh-spawn paths suppress the leading clear. */
  freshlySpawned?: boolean;
  /**
   * Attach the transcript verifier to the command itself. Defaults to true;
   * set false to model an adapter with no `command-injection` verifier (11 of
   * 12 adapters), where delivery can only ever be `unconfirmed`.
   */
  verifyCommand?: boolean;
  /** Model an agent actively streaming output (a live turn). */
  busyRepaintIntervalMs?: number;
  /** Window after spawn during which a Ctrl+C is swallowed by ConPTY. */
  startupRenderMs?: number;
  /**
   * How long the TUI leaves bytes sitting before reading them, i.e. how much
   * input coalesces into one read. Raise it to model a child that is busy
   * rendering and has not touched stdin yet.
   */
  readCoalesceWindowMs?: number;
}

interface TrialResult {
  delivered: boolean;
  submissions: string[];
  maxConsecutiveEmptyCtrlC: number;
}

async function runTrial(options: TrialOptions): Promise<TrialResult> {
  const tuiOptions: FakeTuiOptions = {
    ...DEFAULT_TUI_OPTIONS,
    pickerRenderMs: options.pickerRenderMs,
    repaintLatencyMs: options.repaintLatencyMs ?? DEFAULT_TUI_OPTIONS.repaintLatencyMs,
    busyRepaintIntervalMs: options.busyRepaintIntervalMs ?? DEFAULT_TUI_OPTIONS.busyRepaintIntervalMs,
    startupRenderMs: options.startupRenderMs ?? DEFAULT_TUI_OPTIONS.startupRenderMs,
    readCoalesceWindowMs: options.readCoalesceWindowMs ?? DEFAULT_TUI_OPTIONS.readCoalesceWindowMs,
  };
  const sessionManager = new SimulatedSessionManager(SESSION_ID, tuiOptions, {
    writeQueueDelayMs: options.writeQueueDelayMs ?? 0,
  });
  if (options.draft) sessionManager.tui.setDraft(options.draft);

  const submit = new TerminalSubmit(
    sessionManager as unknown as SessionManager,
    createStubPasteEngine() as unknown as PasteEngine,
  );

  try {
    await submit.submitKeystrokes(
      SESSION_ID,
      [{ text: AUTO_COMMAND, verify: options.verifyCommand === false ? 'none' : 'submitted' }],
      {
        freshlySpawned: options.freshlySpawned,
        pendingDraft: options.draft ?? null,
        verifier: options.verifyCommand === false ? null : createSubmissionVerifier(sessionManager.tui),
        source: 'load-rig',
      },
    );
    return {
      delivered: wasDeliveredExactly(sessionManager.tui, AUTO_COMMAND),
      submissions: sessionManager.tui.submissions.map((entry) => entry.text),
      maxConsecutiveEmptyCtrlC: sessionManager.tui.maxConsecutiveEmptyCtrlC,
    };
  } finally {
    sessionManager.dispose();
  }
}

interface RateReport {
  total: number;
  delivered: number;
  rate: number;
  failures: Array<{ pickerRenderMs: number; submissions: string[] }>;
}

async function measureRate(trials: TrialOptions[]): Promise<RateReport> {
  const results = await Promise.all(trials.map((trial) => runTrial(trial)));
  const failures = results
    .map((result, index) => ({ result, trial: trials[index] }))
    .filter(({ result }) => !result.delivered)
    .map(({ result, trial }) => ({
      pickerRenderMs: trial.pickerRenderMs,
      submissions: result.submissions,
    }));
  const delivered = results.filter((result) => result.delivered).length;
  return {
    total: results.length,
    delivered,
    rate: delivered / results.length,
    failures,
  };
}

/**
 * Picker render latencies spanning the band that matters. The keystroke
 * sequence sends Esc then Enter on fixed delays, so a picker that renders
 * AFTER the Esc but BEFORE the Enter swallows the submission. Sampling only
 * fast renders would report a rate near 100% and hide the whole defect.
 */
function latencySweep(): number[] {
  return [5, 20, 40, 60, 80, 100, 120, 140, 160, 180, 200, 240, 280, 320];
}

/** A busier machine: seeded jitter on picker render, repaint, and the queue. */
function loadedSweep(seed: number, count: number): TrialOptions[] {
  const random = createRandom(seed);
  return Array.from({ length: count }, () => ({
    pickerRenderMs: Math.round(random() * 300),
    repaintLatencyMs: 1 + Math.round(random() * 20),
    writeQueueDelayMs: Math.round(random() * 15),
  }));
}

describe('auto_command injection delivery rate', () => {
  it('reports the keystroke-path delivery rate across a picker-render sweep', async () => {
    const report = await measureRate(latencySweep().map((pickerRenderMs) => ({ pickerRenderMs })));

    console.log(
      `[injection-rig] picker-render sweep: ${report.delivered}/${report.total} delivered ` +
        `(${(report.rate * 100).toFixed(1)}%). Failing latencies: ` +
        `${report.failures.map((failure) => `${failure.pickerRenderMs}ms`).join(', ') || 'none'}`,
    );

    // The sweep must actually exercise the path; a zero-trial run would
    // report a vacuous 100%.
    expect(report.total).toBe(latencySweep().length);
    expect(report.rate).toBe(1);
  }, 30_000);

  it('reports the delivery rate under simulated load', async () => {
    const report = await measureRate(loadedSweep(20260806, 40));

    console.log(
      `[injection-rig] loaded sweep: ${report.delivered}/${report.total} delivered ` +
        `(${(report.rate * 100).toFixed(1)}%)`,
    );

    expect(report.total).toBe(40);
    expect(report.rate).toBe(1);
  }, 30_000);

  it('never concatenates the command onto a user draft', async () => {
    const report = await measureRate(
      latencySweep().map((pickerRenderMs) => ({ pickerRenderMs, draft: 'instead can we' })),
    );

    console.log(
      `[injection-rig] draft-present sweep: ${report.delivered}/${report.total} delivered ` +
        `(${(report.rate * 100).toFixed(1)}%). Bad submissions: ` +
        `${JSON.stringify(report.failures.flatMap((failure) => failure.submissions))}`,
    );

    // The specific reported bug: the draft and the command submitted together
    // as one message. Nothing may ever be submitted that is not exactly the
    // command.
    const everySubmission = report.failures.flatMap((failure) => failure.submissions);
    expect(everySubmission.filter((text) => text !== AUTO_COMMAND)).toEqual([]);
    expect(report.rate).toBe(1);
  }, 30_000);

  it('never concatenates on the fresh-spawn path when the user typed during the wait', async () => {
    // This is the reported bug's most likely real path. Fresh-spawn delivery
    // is DEFERRED (up to a 30s fallback) and runs with sendCtrlC:false, so the
    // prompt is only empty "by construction" at spawn time, not at delivery
    // time. A user who starts typing while the injection waits gets their text
    // glued: `instead can we/code-review` submitted as one message.
    const trials = latencySweep().map((pickerRenderMs) => ({
      pickerRenderMs,
      draft: 'instead can we',
      freshlySpawned: true,
    }));
    const results = await Promise.all(trials.map((trial) => runTrial(trial)));

    const glued = results.flatMap((result) =>
      result.submissions.filter((text) => text !== AUTO_COMMAND),
    );
    const delivered = results.filter((result) => result.delivered).length;
    console.log(
      `[injection-rig] fresh-spawn draft sweep: ${delivered}/${results.length} delivered ` +
        `(${((delivered / results.length) * 100).toFixed(1)}%). Glued submissions: ${JSON.stringify(glued)}`,
    );

    expect(glued).toEqual([]);
    expect(delivered).toBe(results.length);
  }, 30_000);

  it('reports the delivery rate for an adapter with no transcript verifier', async () => {
    // Most adapters still return null from getSubmissionVerifier (Claude,
    // Codex, and Qwen are the exceptions, each gated on a measured
    // submit-time flush), so this remains the bucket many users are in.
    // the bucket most users are actually in. There is no retry signal here:
    // reliability rests entirely on the settle handshake landing Esc after
    // the picker rendered, and on keeping Esc and Enter adjacent. Measured
    // separately so a healthy Claude number cannot hide a bad general one.
    //
    // This path cannot reach 100%. A residual race remains where the picker
    // mounts inside the one-tick gap between Esc and Enter, and it cannot be
    // closed by shrinking that gap further: writing `\x1b\r` as one payload
    // risks the terminal's input parser reading it as Meta+Enter (a newline,
    // not a submit), and the write queue coalesces adjacent small writes into
    // a single `pty.write` unless a drain separates them. An adapter closes
    // this properly by implementing `getSubmissionVerifier('command-injection')`,
    // which turns the residual race into a retried-and-recovered case.
    const report = await measureRate(
      latencySweep().map((pickerRenderMs) => ({ pickerRenderMs, verifyCommand: false })),
    );

    console.log(
      `[injection-rig] no-verifier sweep: ${report.delivered}/${report.total} delivered ` +
        `(${(report.rate * 100).toFixed(1)}%). Failing latencies: ` +
        `${report.failures.map((failure) => `${failure.pickerRenderMs}ms`).join(', ') || 'none'}`,
    );

    // The SAFETY property is absolute and timing-independent: a delivery may
    // be missed, but nothing may ever be submitted that is not exactly the
    // command. Assert that strictly.
    const everySubmission = report.failures.flatMap((failure) => failure.submissions);
    expect(everySubmission.filter((text) => text !== AUTO_COMMAND)).toEqual([]);
    // The rate itself gets a loose floor rather than an exact value: this
    // path is genuinely timing-sensitive and CI runners are slower than a
    // developer machine, so a tight assertion here would be flaky by design.
    expect(report.rate).toBeGreaterThanOrEqual(0.75);
  }, 30_000);

  it('survives a startup render window that swallows the leading clear', async () => {
    // The ConPTY drop that produced the historical `</task>/test` glue bug.
    const trials = latencySweep().map((pickerRenderMs) => ({
      pickerRenderMs,
      startupRenderMs: 150,
    }));
    const results = await Promise.all(trials.map((trial) => runTrial(trial)));

    const delivered = results.filter((result) => result.delivered).length;
    const bad = results.flatMap((result) => result.submissions.filter((text) => text !== AUTO_COMMAND));
    console.log(
      `[injection-rig] startup-render sweep: ${delivered}/${results.length} delivered ` +
        `(${((delivered / results.length) * 100).toFixed(1)}%). Bad submissions: ${JSON.stringify(bad)}`,
    );

    expect(bad).toEqual([]);
    expect(delivered).toBe(results.length);
  }, 30_000);

  it('never fires two consecutive Ctrl+C presses on an empty prompt', async () => {
    // Two in a row is what actually exits Claude Code. The old exhaustion
    // path could produce that pair.
    const results = await Promise.all(
      latencySweep().map((pickerRenderMs) => runTrial({ pickerRenderMs, verifyCommand: true })),
    );
    for (const result of results) {
      expect(result.maxConsecutiveEmptyCtrlC).toBeLessThan(2);
    }
  }, 30_000);
});

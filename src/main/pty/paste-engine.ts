import type { SessionManager } from './session-manager';
import type { SubmissionVerifier } from '../../shared/types';
import { waitForOutputSettle, type OutputSettleResult } from './output-settle';

/**
 * PasteEngine: deterministic paste-and-submit for TUI agents. Private
 * implementation detail of `TerminalSubmit.submitContent` - external
 * callers should never reach into this module directly. The browser pane
 * goes through `terminalSubmit.submitContent`, which forwards to
 * `pasteAndSubmit` here.
 *
 * Algorithm:
 *   1. drain pending writeQueue bytes
 *   2. chunked writeRaw of `\e[200~payload\e[201~` (1KB chunks with
 *      setImmediate yields - keeps ConPTY's child-side reads atomic)
 *   3. wait for output-settle (data + 250ms idle, capped per-byte,
 *      floored at MIN_GAP_MS for React's commit cycle)
 *   4. queue write of `\r` + drain (queue path matches what real user
 *      keystrokes take; writeRaw misroutes Enter on Claude Code)
 *   5. wait for submission evidence. The optional `SubmissionVerifier`
 *      callback (supplied via `PasteOptions.verifier`) races in parallel
 *      with an `'activity'` non-idle backstop and a post-`\r` data path
 *      (50-byte cursor-blip floor). The first signal to resolve wins; a
 *      verifier returning false does NOT short-circuit the others. Retry
 *      `\r` once on timeout, hard-error if both windows time out.
 *
 * Enter must be a separate write: per Ink source, bracketed paste content
 * goes to `usePaste` (not `useInput`), and if `\r` arrives in the same
 * kernel read as `\e[201~` the submit handler can read stale closure
 * state. The settle wait + floor guarantees React commits before Enter.
 *
 * CALLER CONTRACT: the session must be subscribed (in
 * `SessionManager.focusedSessionIds`) before invoking. The `'data'` event
 * is gated on subscription for IPC-bandwidth reasons, so settle (step 3)
 * and evidence (step 5) only resolve via the data path when the session
 * is focused. Both fall back to wall-clock floors and activity events
 * respectively, but the engine is meaningfully slower and less
 * deterministic without subscription. Browser pane and the keystroke
 * delivery path (TerminalSubmit) both run alongside an active terminal
 * panel that subscribes via `TERMINAL_SUBSCRIBE`, so they satisfy this
 * naturally. The gate is default-closed (an empty focused set forwards
 * NOTHING - e.g. a mobile-bridge paste while the desktop shows the Backlog
 * view), in which case the engine degrades to those wall-clock/activity
 * fallbacks: slower, still correct.
 */

export interface PasteOptions {
  /** Wrap content in `\e[200~ ... \e[201~`. Default true. */
  bracketed?: boolean;
  /** Hard timeout for the entire pasteAndSubmit operation. Default 15000ms. */
  timeoutMs?: number;
  /** Caller-driven cancellation. */
  signal?: AbortSignal;
  /** Diagnostic label for the `[paste-engine]` log lines. */
  source?: string;
  /** Optional verifier callback that confirms the pasted prompt was accepted.
   *  Looked up by the caller from `adapter.getSubmissionVerifier('paste')` and
   *  forwarded here. When omitted, only the legacy 'activity' + any-data
   *  fallback paths are active. */
  verifier?: SubmissionVerifier;
  /** When false, the "any data byte resolves evidence" fallback is
   *  disabled - useful in unit tests that want to assert a specific
   *  evidence path fired in isolation. Default true. */
  allowAnyDataFallback?: boolean;
}

export interface PasteEngine {
  pasteAndSubmit(sessionId: string, text: string, options?: PasteOptions): Promise<void>;
}

export class PasteSubmitError extends Error {
  readonly code: 'aborted' | 'timeout' | 'no-submission-evidence';
  constructor(code: PasteSubmitError['code'], message: string) {
    super(message);
    this.name = 'PasteSubmitError';
    this.code = code;
  }
}

const BRACKETED_PASTE_START = '\x1b[200~';
const BRACKETED_PASTE_END = '\x1b[201~';
/** TUI broadcasts these sequences to enable/disable bracketed-paste mode.
 *  When mode is OFF, our paste packet bytes are interpreted as raw input
 *  (one character at a time), which can confirm permission prompts or
 *  type into search fields. We track these in output so we can refuse the
 *  retry path and surface a clear error instead. */
const BRACKETED_PASTE_MODE_ON = '\x1b[?2004h';
const BRACKETED_PASTE_MODE_OFF = '\x1b[?2004l';
/** Conservative: small enough that Windows ConPTY's child-side ReadFile
 *  reliably returns the whole chunk in one read. */
const PASTE_CHUNK_SIZE = 1024;
/** Quiet window after first data byte. 250ms covers slow renders / bigger
 *  React trees without noticeably delaying the happy path. */
const OUTPUT_SETTLE_IDLE_MS = 250;
/** React commit floor: total paste-to-Enter wait is never below this,
 *  regardless of how fast output settles. Prevents the usePaste/useInput
 *  batching race when the TUI emits its redraw faster than React commits.
 *  Sized after a regression that combined two causes: an insufficient
 *  500ms floor AND \r going through writeRaw (bypassing the queue) instead
 *  of sessionManager.write. Switching \r to the queue path was the primary
 *  fix; this larger floor is defensive headroom. Don't shrink this without
 *  also revisiting the queue routing decision below. */
const MIN_GAP_MS = 1000;
/** Floor for the cap; the per-byte multiplier extends this for large payloads. */
const SETTLE_CAP_MIN_MS = 1000;
const SETTLE_CAP_PER_BYTE_MS = 0.5;
/** How long to wait after \r for proof the agent moved (activity event or
 *  output bytes). Tuned so a busy session has time to transition to
 *  'thinking' but a stuck \r is caught quickly enough to retry. */
const EVIDENCE_FIRST_WAIT_MS = 3000;
/** Shorter retry window: if the first \r got swallowed, the second one
 *  should be processed faster (no paste-commit race). */
const EVIDENCE_RETRY_WAIT_MS = 2000;
/* Worst-case end-to-end budget = MIN_GAP_MS + capMs + EVIDENCE_FIRST_WAIT_MS
 * + EVIDENCE_RETRY_WAIT_MS ~= 7s for a small payload, more for large pastes
 * (capMs scales with packet length). Keep `timeoutMs` (default 15000ms in
 * `pasteAndSubmit`) comfortably above this sum. */

/** Strip CR and other C0 controls that would corrupt paste; keep \t and \n. */
export function sanitizeForPaste(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\x00-\x08\x0b-\x1f]/g, '');
}

/**
 * Write packet in PASTE_CHUNK_SIZE chunks with event-loop yields between.
 * The yield (setImmediate, not a wall-clock delay) lets node-pty/ConPTY
 * deliver each chunk to the agent before the next arrives, preventing
 * the close marker from landing in a different child-side ReadFile call
 * than its content - Ink's parser cannot reassemble paste across reads.
 *
 * INVARIANT: callers must not enable concurrent input on the same session
 * while this is in flight. `writeRaw` bypasses the per-session FIFO write
 * queue, so any caller routing user input through `sessionManager.write`
 * during a paste-engine call can interleave bytes at the OS pipe level,
 * splitting the bracketed-paste packet. Browser pane (Send button blocks)
 * and the keystroke delivery path (which uses sessionManager.write
 * exclusively, not writeRaw) both naturally satisfy this.
 *
 * PLATFORM NOTE: on Windows ConPTY, each `pty.write` traverses an IPC
 * channel to conhost (1-5ms per write). For 100KB+ payloads (~100 chunks)
 * this can add ~500ms-1s of write latency before settle starts. Unix
 * PTYs are microseconds. Not a bug, just a latency floor users on
 * Windows may notice for very large pastes.
 */
async function writeChunked(
  sessionManager: SessionManager,
  sessionId: string,
  packet: string,
  signal: AbortSignal,
): Promise<void> {
  for (let offset = 0; offset < packet.length; offset += PASTE_CHUNK_SIZE) {
    if (signal.aborted) {
      throw new PasteSubmitError('aborted', 'paste-engine: aborted during chunked write');
    }
    const end = Math.min(offset + PASTE_CHUNK_SIZE, packet.length);
    sessionManager.writeRaw(sessionId, packet.slice(offset, end));
    if (end < packet.length) {
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  }
}

type SettleResult = OutputSettleResult;

/**
 * Wait for the TUI to render the paste placeholder, then honor the
 * React-commit floor before resolving. Resolves on first data + idle
 * window, or capMs fallback if data never arrives. The floor keeps
 * fast-render small payloads from racing past React's commit cycle.
 *
 * Delegates to the shared `waitForOutputSettle` primitive. Stays on the
 * renderer-gated `'data'` event (not `'data-tap'`) to preserve this engine's
 * documented caller contract: the browser pane and dictation paths run
 * alongside a subscribed terminal, and widening the seam here would change
 * paste timing for reasons unrelated to this change.
 */
function waitForPasteSettle(
  sessionManager: SessionManager,
  sessionId: string,
  packetLength: number,
  signal: AbortSignal,
): Promise<SettleResult> {
  const capMs = Math.max(SETTLE_CAP_MIN_MS, Math.round(packetLength * SETTLE_CAP_PER_BYTE_MS) + SETTLE_CAP_MIN_MS);
  return waitForOutputSettle(sessionManager, sessionId, {
    event: 'data',
    idleMs: OUTPUT_SETTLE_IDLE_MS,
    capMs,
    floorMs: MIN_GAP_MS,
    signal,
    abortError: (stage) => {
      if (stage === 'before') return new PasteSubmitError('aborted', 'paste-engine: aborted before settle');
      if (stage === 'floor') return new PasteSubmitError('aborted', 'paste-engine: aborted during minimum-gap floor');
      return new PasteSubmitError('aborted', 'paste-engine: aborted during output settle');
    },
  });
}

type EvidenceResult = 'verifier' | 'activity' | 'data' | 'timeout';

/**
 * Cursor-blip floor for the post-`\r` data path. After the carriage return
 * lands, the TUI typically emits a cursor-position report (~2-6 bytes) that
 * predates any actual response - resolving evidence on those bytes alone
 * produces false positives. 50 bytes empirically clears the blip without
 * blocking any real response prefix.
 */
const POST_ENTER_DATA_FLOOR_BYTES = 50;

/**
 * Wait for proof the agent processed our `\r`. Resolves on the first
 * matching signal among:
 *
 *   1. `verifier({ type: 'paste' })` returns true (when supplied) - the
 *      strongest signal an adapter can provide. Runs in parallel with the
 *      listeners below, so a verifier returning false (or throwing) does
 *      NOT short-circuit the wait - the fallbacks remain active.
 *   2. `'activity'` non-idle transition. This is the SessionManager's own
 *      view of "agent moved on our submit"; covers Claude/Codex/Gemini/Qwen
 *      hook signals because those events drive activity transitions.
 *   3. Post-`\r` data bytes crossing POST_ENTER_DATA_FLOOR_BYTES. Disabled
 *      via `allowAnyDataFallback: false` for tests that want isolated paths.
 *
 * Resolves `'timeout'` instead of rejecting so the caller can retry.
 *
 * Fresh-window: `tWriteEnter` is captured by the caller right before
 * the `\r` write. Bytes received before that timestamp do not count
 * toward the data path (stale renders from before the submit cannot
 * satisfy it). Activity transitions are inherently post-\r and not gated.
 */
function waitForSubmissionEvidence(
  sessionManager: SessionManager,
  sessionId: string,
  timeoutMs: number,
  signal: AbortSignal,
  verifier: SubmissionVerifier | undefined,
  tWriteEnter: number,
  allowAnyDataFallback: boolean,
): Promise<EvidenceResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new PasteSubmitError('aborted', 'paste-engine: aborted before evidence wait'));
      return;
    }

    let resolved = false;
    let postWriteBytes = 0;

    const cleanup = (): void => {
      sessionManager.off('data', onData);
      sessionManager.off('activity', onActivity);
      signal.removeEventListener('abort', onAbort);
      clearTimeout(timer);
    };

    const finish = (result: EvidenceResult): void => {
      if (resolved) return;
      resolved = true;
      cleanup();
      resolve(result);
    };

    const onData = (...args: unknown[]): void => {
      if (args[0] !== sessionId) return;
      // Fresh-window: discard bytes that arrived before the \r write.
      // Compares wall-clock Date.now() values; we accept rare clock-skew
      // edge cases because the alternative (performance.now everywhere)
      // is a wider change.
      if (Date.now() < tWriteEnter) return;
      const chunk = args[1];
      if (typeof chunk === 'string') {
        postWriteBytes += chunk.length;
      }
      if (allowAnyDataFallback && postWriteBytes >= POST_ENTER_DATA_FLOOR_BYTES) {
        finish('data');
      }
    };

    const onActivity = (...args: unknown[]): void => {
      if (args[0] !== sessionId) return;
      const activity = args[1];
      // Only 'thinking' is proof the paste was acknowledged. Permission
      // transitions don't count - the paste might have triggered the
      // permission prompt itself.
      if (activity === 'thinking') finish('activity');
    };

    const onAbort = (): void => {
      if (resolved) return;
      resolved = true;
      cleanup();
      reject(new PasteSubmitError('aborted', 'paste-engine: aborted during evidence wait'));
    };

    sessionManager.on('data', onData);
    sessionManager.on('activity', onActivity);
    signal.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(() => finish('timeout'), timeoutMs);

    // OR-combine: if a verifier is supplied, run it in parallel with the
    // listeners. A `true` resolution wins; a `false` resolution leaves the
    // listeners active so activity / data / timeout still decide. A throw
    // propagates and aborts the wait (caller's retry path handles it).
    if (verifier) {
      Promise.resolve(verifier({ type: 'paste' }))
        .then((confirmed) => {
          if (confirmed) finish('verifier');
        })
        .catch((caught) => {
          if (resolved) return;
          resolved = true;
          cleanup();
          reject(caught);
        });
    }
  });
}

export function createPasteEngine(sessionManager: SessionManager): PasteEngine {
  return {
    async pasteAndSubmit(sessionId, text, options = {}) {
      const start = Date.now();
      const bracketed = options.bracketed ?? true;
      const totalTimeoutMs = options.timeoutMs ?? 15000;
      const source = options.source ?? 'unknown';
      const verifier = options.verifier;
      const allowAnyDataFallback = options.allowAnyDataFallback ?? true;

      const timeoutController = new AbortController();
      const timeoutTimer = setTimeout(() => timeoutController.abort(), totalTimeoutMs);
      const { signal: linkedSignal, dispose: disposeLink } = linkSignals(
        options.signal, timeoutController.signal,
      );

      const safeText = sanitizeForPaste(text);
      const packet = bracketed
        ? `${BRACKETED_PASTE_START}${safeText}${BRACKETED_PASTE_END}`
        : safeText;

      // Track bracketed-paste-mode toggles in the output stream. If the TUI
      // disables mode mid-call, a modal/permission prompt has taken focus
      // and our retry \r could confirm it. Listener lives for the whole
      // pasteAndSubmit call; the early data path may fire before we even
      // start writing the packet.
      let pasteModeOff = false;
      const monitorPasteMode = (...args: unknown[]): void => {
        if (args[0] !== sessionId) return;
        const chunk = args[1];
        if (typeof chunk !== 'string') return;
        // Compare positions of the LAST occurrence of each marker so the
        // most-recent toggle in this chunk wins. Presence-only checks would
        // misclassify chunks like "...ON...OFF..." as ON because both `if`
        // branches fire and one always overwrites the other regardless of
        // textual order.
        const offIdx = chunk.lastIndexOf(BRACKETED_PASTE_MODE_OFF);
        const onIdx = chunk.lastIndexOf(BRACKETED_PASTE_MODE_ON);
        if (offIdx === -1 && onIdx === -1) return;
        if (offIdx > onIdx) pasteModeOff = true;
        else if (onIdx > offIdx) pasteModeOff = false;
      };
      sessionManager.on('data', monitorPasteMode);

      try {
        await sessionManager.drain(sessionId);
        if (linkedSignal.aborted) throw new PasteSubmitError('aborted', 'paste-engine: aborted before write');

        const writeStart = Date.now();
        await writeChunked(sessionManager, sessionId, packet, linkedSignal);
        const writeMs = Date.now() - writeStart;

        const settleStart = Date.now();
        const settle = await waitForPasteSettle(sessionManager, sessionId, packet.length, linkedSignal);
        const settleMs = Date.now() - settleStart;

        // Send \r through the queue (not writeRaw). The queue's setImmediate-
        // paced drain ships \r in a distinct event-loop tick, which matches
        // the path real user keystrokes take. writeRaw skips the queue and
        // empirically lands \r in a way Claude Code's TUI accepts as input
        // but does not submit (paste content commits, but the Enter handler
        // sees stale state). Routing through the queue + draining gives
        // ConPTY a clean separation between the close marker and \r.
        const tWriteEnter = Date.now();
        sessionManager.write(sessionId, '\r');
        await sessionManager.drain(sessionId);

        // Wait for proof the agent moved. If the first \r got swallowed
        // (TUI in a transition state, autocomplete, etc.), retry once -
        // a stray \r outside paste content with empty input is a TUI no-op,
        // so retrying is safe even when the original DID submit and we
        // simply missed the evidence. Two timeouts -> hard failure with a
        // descriptive code so the renderer can prompt the user.
        const evidenceStart = Date.now();
        let evidenceResult = await waitForSubmissionEvidence(
          sessionManager, sessionId, EVIDENCE_FIRST_WAIT_MS, linkedSignal,
          verifier, tWriteEnter, allowAnyDataFallback,
        );
        let retried = false;
        if (evidenceResult === 'timeout') {
          if (pasteModeOff) {
            // TUI disabled bracketed paste mode during our call (modal,
            // permission prompt, etc.). Retrying \r could confirm the
            // modal as a destructive action. Bail out instead.
            throw new PasteSubmitError(
              'no-submission-evidence',
              `paste-engine: ${source} sent paste but agent disabled bracketed-paste mode (modal/prompt focused). Skipped retry to avoid confirming a destructive action.`,
            );
          }
          retried = true;
          const tRetryEnter = Date.now();
          sessionManager.write(sessionId, '\r');
          await sessionManager.drain(sessionId);
          evidenceResult = await waitForSubmissionEvidence(
            sessionManager, sessionId, EVIDENCE_RETRY_WAIT_MS, linkedSignal,
            verifier, tRetryEnter, allowAnyDataFallback,
          );
        }
        const evidenceMs = Date.now() - evidenceStart;

        if (evidenceResult === 'timeout') {
          throw new PasteSubmitError(
            'no-submission-evidence',
            `paste-engine: ${source} sent paste + \\r (1 retry) but agent emitted no signal in ${evidenceMs}ms`,
          );
        }

        const totalMs = Date.now() - start;
        console.log(
          `[paste-engine] ${source}: ${packet.length}b in ${Math.ceil(packet.length / PASTE_CHUNK_SIZE)} chunks (${writeMs}ms) + settle ${settleMs}ms (${settle.reason}, output=${settle.observedOutput}) + evidence=${evidenceResult}${retried ? ' (after 1 retry)' : ''} ${evidenceMs}ms = ${totalMs}ms total`,
        );
      } catch (caughtError) {
        if (timeoutController.signal.aborted && !options.signal?.aborted) {
          throw new PasteSubmitError('timeout', `paste-engine: ${source} exceeded ${totalTimeoutMs}ms`);
        }
        throw caughtError;
      } finally {
        sessionManager.off('data', monitorPasteMode);
        clearTimeout(timeoutTimer);
        disposeLink();
      }
    },
  };
}

/** Compose two AbortSignals into one that aborts when either input does.
 *  Returns a `dispose` callback the caller MUST invoke in `finally` so the
 *  abort listeners are removed from `options.signal` on the success path.
 *  Without this, every `pasteAndSubmit` call leaks one listener on a
 *  long-lived caller-supplied signal. */
function linkSignals(
  a: AbortSignal | undefined,
  b: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  if (!a) return { signal: b, dispose: () => undefined };
  if (a.aborted) return { signal: a, dispose: () => undefined };
  const controller = new AbortController();
  const propagate = (): void => controller.abort();
  a.addEventListener('abort', propagate);
  b.addEventListener('abort', propagate);
  return {
    signal: controller.signal,
    dispose: () => {
      a.removeEventListener('abort', propagate);
      b.removeEventListener('abort', propagate);
    },
  };
}

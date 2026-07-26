import PQueue from 'p-queue';
import { isActive } from '../../../shared/activity-state';
import type { ActivityState } from '../../../shared/types';

/**
 * Agent-to-agent steering: deliver a message into a running agent session.
 *
 * This is the write-side counterpart to the read-only session tools
 * (`kangentic_get_session_events`, `kangentic_get_transcript`, ...). Before it
 * existed, an agent could observe another session perfectly but had no way to
 * hand it a prompt - the only transport was a human copy-pasting into that
 * session's input box.
 *
 * Delivery reuses `TerminalSubmit.submitContent` (bracketed paste -> settle ->
 * `\r` -> submission evidence), the same path the mobile bridge's
 * `send-user-message` verb and the Browser pane's Send affordance use. It is
 * deliberately NOT `sessionManager.write` (no submit semantics) and NOT
 * `submitKeystrokes` (slash-command delivery; a 2KB payload would take ~80s).
 *
 * The guards here are circuit breakers against unattended token spend - two
 * agents ping-ponging overnight - not a permission policy. Deliberate
 * multi-agent orchestration (A -> B -> C -> D -> E) must pass through
 * unobstructed, so the discriminator is send FREQUENCY, not chain depth.
 */

/**
 * Sliding-window ceiling per target session. A genuine orchestration hop costs
 * the receiving agent a whole turn (tens of seconds at minimum), so legitimate
 * traffic never approaches this; only a runaway loop does. Deliberately not
 * modelled on `MAX_TASK_CREATE_PER_LAUNCH`, which is monotonic and never
 * recovers: a create storm corrupts a board that must be cleaned up by hand,
 * whereas a send storm only burns tokens, and a monotonic ceiling would
 * eventually kill a long-running instance doing legitimate work.
 */
const SEND_WINDOW_MS = 5 * 60 * 1000;
const MAX_SENDS_PER_TARGET_PER_WINDOW = 30;

/**
 * Backstop against a true infinite A -> B -> A loop. Intentionally absurd:
 * this is not a policy on how deep an orchestration may nest, it is the depth
 * past which a chain is definitionally a bug. Depth is tracked server-side
 * from the caller's authenticated URL segment, so it cannot be forged by a
 * caller-supplied field.
 */
const MAX_HOP_DEPTH = 25;

/** How the caller wants the message delivered relative to the target's turn. */
export type SessionSendDeliverWhen = 'now' | 'idle';

/**
 * `delivered` - handed to the session's input via the submit path.
 * `queued`    - target was mid-turn and `deliverWhen: 'idle'` was requested;
 *               held in main and flushed on the next idle transition.
 */
export type SessionSendStatus = 'delivered' | 'queued';

export interface SessionSendSuccess {
  status: SessionSendStatus;
  sessionId: string;
  targetActivity: ActivityState | 'unknown';
  hopDepth: number;
}

export interface SessionSendFailure {
  error: string;
}

export type SessionSendOutcome = SessionSendSuccess | SessionSendFailure;

export interface SessionSendRequest {
  /** Resolved live target session. */
  targetSessionId: string;
  /**
   * Message text, delivered verbatim. No attribution prefix is added here or
   * anywhere else in the pipeline - provenance is recorded out-of-band via
   * `recordSentMessage`. See the comment above `const text = message` in
   * `send()` for why the in-band prefix was removed.
   */
  message: string;
  /**
   * Authenticated caller session, from the MCP URL path segment. Absent for a
   * human-driven `claude` run outside Kangentic, or any client using the
   * legacy `/mcp/<projectId>` URL. Absence is never an error.
   */
  callerSessionId?: string;
  deliverWhen: SessionSendDeliverWhen;
  /**
   * Persists the provenance of this message. Called once the text is actually
   * handed to the session (so a refused or failed send leaves no row), and for
   * a deferred send at flush time rather than at queue time.
   */
  recordSentMessage?: SentMessageRecorder;
}

/**
 * The slice of `SessionManager` this module needs. Declared structurally
 * rather than importing the class so unit tests can drive it with a stub
 * instead of booting a PTY.
 */
export interface SessionSendSessionManager {
  isWritable(sessionId: string): boolean;
  getActivityCache(): Record<string, ActivityState>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  off(event: string, listener: (...args: unknown[]) => void): unknown;
}

/** The slice of `TerminalSubmit` this module needs. */
export interface SessionSendTerminalSubmit {
  submitContent(sessionId: string, text: string, opts?: { source?: string }): Promise<void>;
}

export interface SessionSendDependencies {
  sessionManager: SessionSendSessionManager;
  terminalSubmit: SessionSendTerminalSubmit;
}

export interface SessionSendCoordinator {
  send(request: SessionSendRequest): Promise<SessionSendOutcome>;
  /** Detach the SessionManager listeners. Called on server shutdown. */
  dispose(): void;
  /** @internal Test-only view of the tracked-map sizes, to assert they drain. */
  _stateSizesForTesting(): {
    queues: number;
    pending: number;
    hops: number;
    windows: number;
    refusalNotices: number;
  };
}

/**
 * Outcome recorded for one send ATTEMPT, which is a wider set than the two
 * success statuses a caller can receive back:
 *
 * - `delivered` / `queued` - the message reached the session (or is held for
 *   its next idle transition). These are the only two that produce a turn.
 * - `refused`  - a guard rejected it before delivery (self-send, dead session,
 *   hop-depth backstop, rate limit). No turn was produced.
 * - `failed`   - delivery was attempted and threw (e.g. the paste engine's
 *   `no-submission-evidence`). Whether a turn was produced is genuinely
 *   unknown, which is exactly why it is worth a row.
 *
 * Any consumer reconstructing "which turns arrived this way" must filter to
 * `delivered` / `queued`; the other two record an attempt, not a turn.
 */
export type SentMessageStatus = SessionSendStatus | 'refused' | 'failed';

/**
 * Provenance record for one send. The tool layer owns persistence (it
 * holds the project DB); the coordinator stays DB-agnostic so it can be
 * unit-tested without SQLite.
 */
export interface SentMessageRecord {
  targetSessionId: string;
  callerSessionId?: string;
  message: string;
  status: SentMessageStatus;
  /** Refusal or failure detail. Null for a successful delivery. */
  error?: string;
}

export type SentMessageRecorder = (delivery: SentMessageRecord) => void;

export function createSessionSendCoordinator(
  dependencies: SessionSendDependencies,
  options: { maxSendsPerWindow?: number; windowMs?: number; maxHopDepth?: number } = {},
): SessionSendCoordinator {
  const { sessionManager, terminalSubmit } = dependencies;
  const maxSendsPerWindow = options.maxSendsPerWindow ?? MAX_SENDS_PER_TARGET_PER_WINDOW;
  const windowMs = options.windowMs ?? SEND_WINDOW_MS;
  const maxHopDepth = options.maxHopDepth ?? MAX_HOP_DEPTH;

  /** Per-target serialization. Two callers pasting into one session would otherwise
   *  interleave their bracketed-paste packets (writeChunked yields between 1KB chunks). */
  const deliveryQueues = new Map<string, PQueue>();
  /** Send timestamps per target, pruned to the sliding window on each check. */
  const sendWindows = new Map<string, number[]>();
  /**
   * Inbound steer depth per session, so an onward send inherits its chain
   * position.
   *
   * Deliberately ONE scalar per session, not per chain: it holds the depth of
   * the most recent inbound message, which two independent chains converging on
   * the same target will overwrite for each other (a shallow chain's onward hop
   * can inherit a deep chain's depth and vice versa). That is acceptable for a
   * runaway backstop set at 25 - it only ever mis-counts by conflating real
   * traffic, and both directions still terminate - but it is not an accurate
   * per-chain measure, so do not build anything on `hopDepth` that needs to be
   * exact.
   */
  const hopDepths = new Map<string, number>();
  /**
   * Messages held for `deliverWhen: 'idle'`, flushed on the next idle
   * transition. Each entry carries its own recorder so provenance is written
   * when the text actually lands, not when it was queued.
   */
  const pendingDeliveries = new Map<
    string,
    Array<{ text: string; onDelivered: () => void; onFailed: (detail: string) => void }>
  >();
  /** Last time a refusal row was written per `${sessionId}:${reason}`, for dedupe. */
  const refusalNotices = new Map<string, number>();

  function runSerialized(sessionId: string, task: () => Promise<void>): Promise<void> {
    let queue = deliveryQueues.get(sessionId);
    if (!queue) {
      queue = new PQueue({ concurrency: 1 });
      deliveryQueues.set(sessionId, queue);
    }
    const heldQueue = queue;
    const result = heldQueue.add(task) as Promise<void>;
    // Mirror withTaskLock's disposal: drop the entry once the queue drains, so
    // the map does not accumulate one entry per session touched for the life of
    // the process. The catch keeps a rejecting task from producing an
    // unhandledRejection on this derived promise; the caller still sees it.
    result
      .catch(() => {})
      .finally(() => {
        if (heldQueue.size === 0 && heldQueue.pending === 0) {
          deliveryQueues.delete(sessionId);
        }
      });
    return result;
  }

  function deliver(sessionId: string, text: string): Promise<void> {
    return runSerialized(sessionId, () => terminalSubmit.submitContent(sessionId, text, { source: 'mcp' }));
  }

  /**
   * Ready for a fresh prompt: the agent finished its turn. Deliberately
   * excludes `'permission'`, which `isActive` also treats as non-active - a
   * deferred flush into an open permission prompt could have its `\r`
   * interpreted as confirming the prompt.
   */
  function isReadyForPrompt(state: ActivityState | undefined): boolean {
    if (state === undefined) return true;
    // activity-state-ok: granular exclusion of 'permission', not an idle-vs-active
    // bucket - a queued paste must not land on an open permission prompt.
    if (state === 'permission') return false;
    return !isActive(state);
  }

  const onActivity = (...args: unknown[]): void => {
    const sessionId = args[0];
    const state = args[1];
    if (typeof sessionId !== 'string') return;
    if (!pendingDeliveries.has(sessionId)) return;
    if (!isReadyForPrompt(state as ActivityState | undefined)) return;
    const queued = pendingDeliveries.get(sessionId) ?? [];
    pendingDeliveries.delete(sessionId);
    // Checked once for the whole batch rather than per entry. The loop body
    // only ENQUEUES (deliver is not awaited), so writability cannot flip
    // mid-loop, and a per-entry `break` would abandon the remainder with no
    // row at all - the one outcome this table exists to make impossible.
    if (!sessionManager.isWritable(sessionId)) {
      for (const entry of queued) {
        entry.onFailed('target session stopped accepting input before the deferred delivery flushed');
      }
      return;
    }
    for (const entry of queued) {
      void deliver(sessionId, entry.text)
        .then(() => entry.onDelivered())
        .catch((error: unknown) => {
          const detail = error instanceof Error ? error.message : String(error);
          // The tool call that queued this already returned, so a row is the
          // ONLY way the failure ever reaches anyone.
          entry.onFailed(detail);
          console.error(`[session-send] Deferred delivery to ${sessionId} failed: ${detail}`);
        });
    }
  };

  const onExit = (...args: unknown[]): void => {
    const sessionId = args[0];
    if (typeof sessionId !== 'string') return;
    // The caller was already told "queued" and has long since returned, so
    // dropping these silently would leave an attempt with no row anywhere -
    // breaking the "a row exists for every attempt" contract the log is built
    // on. Record each as failed before discarding.
    const abandoned = pendingDeliveries.get(sessionId);
    pendingDeliveries.delete(sessionId);
    if (abandoned) {
      for (const entry of abandoned) {
        entry.onFailed('target session exited before the deferred delivery flushed');
      }
    }
    hopDepths.delete(sessionId);
    sendWindows.delete(sessionId);
    for (const key of [...refusalNotices.keys()]) {
      if (key.startsWith(`${sessionId}:`)) refusalNotices.delete(key);
    }
  };

  sessionManager.on('activity', onActivity);
  sessionManager.on('exit', onExit);

  /**
   * Check-and-record in one synchronous step so a burst of concurrent requests
   * cannot all pass the check before any of them is recorded.
   */
  function reserveSendSlot(sessionId: string): boolean {
    const now = Date.now();
    const cutoff = now - windowMs;
    const recent = (sendWindows.get(sessionId) ?? []).filter((at) => at > cutoff);
    if (recent.length >= maxSendsPerWindow) {
      sendWindows.set(sessionId, recent);
      return false;
    }
    recent.push(now);
    sendWindows.set(sessionId, recent);
    return true;
  }

  /** True at most once per (target, reason) per window. See `refuse`. */
  function shouldRecordRefusal(sessionId: string, reason: string): boolean {
    const key = `${sessionId}:${reason}`;
    const now = Date.now();
    const lastRecordedAt = refusalNotices.get(key);
    if (lastRecordedAt !== undefined && now - lastRecordedAt < windowMs) return false;
    refusalNotices.set(key, now);
    return true;
  }

  return {
    async send(request: SessionSendRequest): Promise<SessionSendOutcome> {
      const { targetSessionId, message, callerSessionId, deliverWhen, recordSentMessage } = request;

      const record = (status: SentMessageStatus, error?: string): void => {
        try {
          recordSentMessage?.({ targetSessionId, callerSessionId, message, status, error });
        } catch (caught) {
          // Provenance is best-effort and must never fail a delivered message.
          // Nothing else can persist this: the store that would hold the record
          // is the thing that just failed, so a loud log is the only recourse.
          const detail = caught instanceof Error ? caught.message : String(caught);
          console.error(`[session-send] Failed to record sent message ${status} for ${targetSessionId}: ${detail}`);
        }
      };

      /**
       * Record a refusal, then return the caller-facing error.
       *
       * Refusals are deduped per (target, reason) per window. Without that, the
       * guards become an amplification vector rather than a circuit breaker: a
       * looping agent whose sends are all refused writes one row per attempt
       * forever, and the self-send / dead-session / hop-depth checks all run
       * BEFORE the rate limiter so they never even consume a slot. One row per reason per
       * window keeps the debugging signal ("it was rate-limited at 14:03")
       * without letting a runaway fill the database instead of the PTY.
       */
      const refuse = (reason: string, error: string): SessionSendFailure => {
        if (shouldRecordRefusal(targetSessionId, reason)) record('refused', error);
        return { error };
      };

      if (callerSessionId && callerSessionId === targetSessionId) {
        return refuse(
          'self-send',
          'Refused: a session cannot send a message to itself. To continue your own work, just keep going - this tool is for steering a DIFFERENT session.',
        );
      }

      if (!sessionManager.isWritable(targetSessionId)) {
        return refuse(
          'not-writable',
          `Session ${targetSessionId} is not accepting input (no live PTY - it has exited, been suspended, or is still queued). ` +
            'Use kangentic_list_sessions to check its status, or move the task back onto the board to resume it.',
        );
      }

      const hopDepth = (callerSessionId ? hopDepths.get(callerSessionId) ?? 0 : 0) + 1;
      if (hopDepth > maxHopDepth) {
        return refuse(
          'hop-depth',
          `Refused: steer chain depth ${hopDepth} exceeds the ${maxHopDepth}-hop backstop, which indicates a send loop rather than an orchestration. Break the chain before sending again.`,
        );
      }

      if (!reserveSendSlot(targetSessionId)) {
        const windowMinutes = Math.round(windowMs / 60000);
        return refuse(
          'rate-limit',
          `Rate limit: session ${targetSessionId} has already received ${maxSendsPerWindow} messages in the last ${windowMinutes} minutes. This ceiling exists to stop runaway send loops; wait for the window to roll off before sending again.`,
        );
      }

      const activityCache = sessionManager.getActivityCache();
      const targetActivity = activityCache[targetSessionId];

      // An open permission prompt is unsafe to deliver into on the IMMEDIATE
      // path too, not just the deferred one: the hazard is the delivery itself,
      // not when it was scheduled. The submit path ends in `\r` (and retries
      // it), which a modal prompt reads as confirming its highlighted option -
      // so a routine steer could silently approve a tool call nobody
      // sanctioned. The paste engine's own modal safety net cannot cover this,
      // because it detects bracketed-paste-mode-off from the 'data' event,
      // which is gated on the session being subscribed - and an MCP send
      // targets a BACKGROUND session by construction, so nobody has its
      // terminal open.
      //
      // Scoped to 'now' deliberately: `deliverWhen: 'idle'` already holds for
      // this state a few lines below (isReadyForPrompt excludes 'permission'),
      // which is the outcome the refusal text points the caller at.
      if (deliverWhen === 'now' && targetActivity === 'permission') {
        return refuse(
          'target-at-prompt',
          `Session ${targetSessionId} is sitting at a permission prompt, where the submit path's Enter would confirm the highlighted option instead of sending your message. ` +
            'Re-send with deliverWhen: "idle" to hold until the prompt clears, or resolve the prompt first.',
        );
      }

      // The message goes in VERBATIM. No attribution prefix: it costs tokens on
      // every send, and empirically (2026-07-25) the receiving agent read it as
      // injected content asserting its own authority - the shape of a prompt
      // injection - and refused to act on messages sent this way. Provenance is
      // recorded out-of-band instead, via recordSentMessage.
      const text = message;

      // Record the chain position BEFORE delivery: a fast target can act on the
      // message (and send onward) before submitContent resolves, and that
      // onward send must already see the correct inbound depth. Rolled back if
      // delivery fails, so repeated failures against one target cannot ratchet
      // it toward the backstop with nothing ever delivered.
      const previousHopDepth = hopDepths.get(targetSessionId);
      const rollBackHopDepth = (): void => {
        if (previousHopDepth === undefined) hopDepths.delete(targetSessionId);
        else hopDepths.set(targetSessionId, previousHopDepth);
      };
      hopDepths.set(targetSessionId, hopDepth);

      // Check the CURRENT state before subscribing. Waiting only for the next
      // idle transition would never fire for a target already parked at
      // idle_hint - which is the whole motivating case for this tool.
      if (deliverWhen === 'idle' && !isReadyForPrompt(targetActivity)) {
        const queued = pendingDeliveries.get(targetSessionId) ?? [];
        queued.push({
          text,
          onDelivered: () => record('queued'),
          // Same rollback the immediate path does in its catch: a target that
          // never received the message must not carry this hop's depth into
          // its own onward sends, or repeated deferred failures ratchet it
          // toward the backstop with nothing ever delivered.
          onFailed: (detail: string) => {
            rollBackHopDepth();
            record('failed', detail);
          },
        });
        pendingDeliveries.set(targetSessionId, queued);
        return {
          status: 'queued',
          sessionId: targetSessionId,
          targetActivity: targetActivity ?? 'unknown',
          hopDepth,
        };
      }

      try {
        await deliver(targetSessionId, text);
      } catch (error) {
        rollBackHopDepth();
        const detail = error instanceof Error ? error.message : String(error);
        // Not deduped: a delivery failure required an actual attempt, which the
        // rate limiter already bounds, and it is the single most useful row
        // when debugging "did my message go through?" - the paste engine can
        // fail with the text half-committed, so the answer is genuinely unknown.
        record('failed', detail);
        return { error: `Delivery to session ${targetSessionId} failed: ${detail}` };
      }

      record('delivered');

      return {
        status: 'delivered',
        sessionId: targetSessionId,
        targetActivity: targetActivity ?? 'unknown',
        hopDepth,
      };
    },

    dispose(): void {
      sessionManager.off('activity', onActivity);
      sessionManager.off('exit', onExit);
      pendingDeliveries.clear();
      hopDepths.clear();
      sendWindows.clear();
      deliveryQueues.clear();
      refusalNotices.clear();
    },

    _stateSizesForTesting() {
      return {
        queues: deliveryQueues.size,
        pending: pendingDeliveries.size,
        hops: hopDepths.size,
        windows: sendWindows.size,
        refusalNotices: refusalNotices.size,
      };
    },
  };
}

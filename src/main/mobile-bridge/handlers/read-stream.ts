import {
  parseCapabilityRequestPayload,
  type CapabilityRequestMessage,
  type CapabilityResponseMessage,
  type ReadStreamResponsePayload,
  type TranscriptWindowResponsePayload,
} from '@kangentic/protocol';
import type { ActivityReason, ActivityState, SessionEvent, SessionUsage, TranscriptEntry } from '../../../shared/types';
import { lastAssistantPreview } from '../message-preview';
import { getProjectDb } from '../../db/database';
import { SessionRepository } from '../../db/repositories/session-repository';
import { resolveTaskTranscript } from '../../agent/transcript-service';
import type { IpcContext } from '../../ipc/ipc-context';
import type { BridgeSession } from '../session/bridge-session';
import type { SubscriptionRegistry } from '../session/subscription-registry';
import { sendEvent } from './send-event';
import { buildPermissionPromptId } from './permission-prompt-id';
import { extractPromptOptions } from '../prompt-options-probe';
import { sliceTranscriptWindow, TranscriptSync } from './transcript-sync';
import {
  toActivityReasonWire,
  toReadStreamSessionStatusWire,
  toSessionEventWire,
  toSessionUsageWire,
  toTerminalDimensionsWire,
  toWireJson,
} from './wire-mappers';

/** Coalesce raw PTY output before pushing, so a burst of small onData chunks does not become a flood of tiny frames. */
const TERMINAL_COALESCE_MS = 16;

/**
 * A pending batch at or under this many chars flushes immediately instead of
 * waiting out the coalesce timer: it is the keystroke-echo fast path (a typed
 * character's echo is a handful of bytes), while real output bursts blow past
 * it on the first chunk and still coalesce.
 */
const TERMINAL_IMMEDIATE_FLUSH_CHARS = 256;

/**
 * When a permission prompt appears and the option-label probe finds no
 * numbered dialog in the frame, retry once after this delay: the activity
 * emission that flips permissionPending can beat the TUI's dialog paint.
 * Prompts are rare, so the (at most one) extra frame read is negligible.
 */
const PROMPT_OPTIONS_RETRY_MS = 400;

/**
 * Wire-coalesce window for token-accounting pushes. Two seconds is far below
 * the rate at which a percentage bar reads as stale, and far above the rate
 * tokens tick at, so it collapses a firehose into a trickle without the phone
 * ever showing a number a user would call wrong.
 */
const USAGE_COALESCE_MS = 2000;

function subscriptionKeyFor(sessionId: string): string {
  return `stream:${sessionId}`;
}

/**
 * Which project owns a session, for a session that may no longer be running.
 *
 * `sessionManager.getSessionProjectId` reads the LIVE registry, so it answers
 * undefined for anything already exited or suspended - including every
 * completed task the phone's Done column reads. The fallback asks each
 * project's own database, which is where the session records outlive the PTY.
 *
 * The scan is per-project but each step is one indexed lookup against an
 * already-cached connection, and it only runs on the fallback path (a live
 * session never reaches it).
 */
function resolveProjectIdForSession(context: IpcContext, sessionId: string): string | null {
  const liveProjectId = context.sessionManager.getSessionProjectId(sessionId);
  if (liveProjectId) return liveProjectId;
  for (const project of context.projectRepo.list()) {
    try {
      if (new SessionRepository(getProjectDb(project.id)).findByAnyId(sessionId)) return project.id;
    } catch {
      // A project whose database will not open cannot own the session as far
      // as this read is concerned; keep looking rather than failing the request.
    }
  }
  return null;
}

function currentAwaitedPromptId(context: IpcContext, sessionId: string): string | null {
  const statsSnapshot = context.sessionManager.getActivityStatsSnapshot(sessionId);
  return statsSnapshot?.permissionPending && statsSnapshot.permissionAwaitedToolId
    ? buildPermissionPromptId(sessionId, statsSnapshot.permissionAwaitedToolId)
    : null;
}

/**
 * Best-effort option-label probe for the awaited prompt: parse the numbered
 * dialog out of the session's serialized frame. Null (no dialog parsed, or
 * the frame read failed) just means the phone falls back to its blind
 * approve/deny keystrokes, exactly as before this field existed.
 */
async function probePromptOptions(context: IpcContext, sessionId: string): Promise<string[] | null> {
  try {
    const frame = await context.sessionManager.getSerializedFrame(sessionId);
    return extractPromptOptions(frame, context.sessionManager.getDimensions(sessionId) ?? undefined);
  } catch {
    return null;
  }
}

function subscribeReadStream(
  sessionId: string,
  taskId: string,
  initialAwaitedPromptId: string | null,
  session: BridgeSession,
  context: IpcContext,
  subscriptions: SubscriptionRegistry,
  wantsTerminal: boolean,
): void {
  const db = getProjectDb(context.sessionManager.getSessionProjectId(sessionId) ?? '');
  const transcriptSync = new TranscriptSync();
  let lastAwaitedPromptId = initialAwaitedPromptId;
  let lastMessagePreview: string | null = null;
  let pendingUsage: SessionUsage | null = null;
  let usageFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const flushUsage = (): void => {
    usageFlushTimer = null;
    if (pendingUsage === null || disposed) return;
    const usage = pendingUsage;
    pendingUsage = null;
    sendEvent(session, { kind: 'activity', sessionId, taskId, payload: { type: 'usage', usage: toSessionUsageWire(usage) } });
  };
  let pendingTerminalChunks: string[] = [];
  let pendingTerminalChars = 0;
  let terminalFlushTimer: ReturnType<typeof setTimeout> | null = null;

  const flushTerminal = (): void => {
    if (terminalFlushTimer) {
      clearTimeout(terminalFlushTimer);
      terminalFlushTimer = null;
    }
    if (pendingTerminalChunks.length === 0) return;
    const data = pendingTerminalChunks.join('');
    pendingTerminalChunks = [];
    pendingTerminalChars = 0;
    sendEvent(session, { kind: 'terminal', sessionId, taskId, payload: { data } });
  };

  const pushTranscriptIfChanged = async (): Promise<void> => {
    try {
      const resolved = await resolveTaskTranscript(db, sessionId);
      if (!resolved) return;
      // Delta chunks stream the moment a turn's content changes - usually
      // just the mutating tail entry, so each frame is small and immediate.
      for (const payload of transcriptSync.diff(resolved)) {
        sendEvent(session, { kind: 'transcript', sessionId, taskId, payload });
      }
      pushMessagePreviewIfChanged(resolved.entries);
    } catch {
      // Best-effort; a transcript-read failure should not tear down the subscription.
    }
  };

  // The one line a phone's session list renders. Derived from the transcript
  // we just resolved anyway, so the list costs no request of its own; sent
  // only when the text actually changes, so an idle session is silent.
  const pushMessagePreviewIfChanged = (entries: TranscriptEntry[]): void => {
    const text = lastAssistantPreview(entries);
    if (text === null || text === lastMessagePreview) return;
    lastMessagePreview = text;
    sendEvent(session, { kind: 'activity', sessionId, taskId, payload: { type: 'message-preview', text } });
  };

  // The snapshot's awaitedPromptId only covers a prompt outstanding AT
  // subscribe time - a prompt that appears (or clears) later must be pushed,
  // or the phone cannot answer it without blindly re-subscribing. Emitted as
  // the `permission` activity payload the protocol defined for exactly this.
  // The pending:true push rides behind an async option-label probe (with one
  // short retry when the frame has not painted the dialog yet); the phone's
  // needs-you state still updates instantly via the activity event this
  // subscription sends first, and a probe miss just omits `options`.
  const pushPermissionIfChanged = (): void => {
    const awaitedPromptId = currentAwaitedPromptId(context, sessionId);
    if (awaitedPromptId === lastAwaitedPromptId) return;
    const previousPromptId = lastAwaitedPromptId;
    lastAwaitedPromptId = awaitedPromptId;
    if (awaitedPromptId) {
      void (async (): Promise<void> => {
        let options = await probePromptOptions(context, sessionId);
        if (options === null && !disposed && lastAwaitedPromptId === awaitedPromptId) {
          await new Promise((resolve) => setTimeout(resolve, PROMPT_OPTIONS_RETRY_MS));
          options = await probePromptOptions(context, sessionId);
        }
        // The prompt may have cleared (or been replaced) while probing; a
        // stale pending:true would strand the phone on an unanswerable card.
        if (disposed || lastAwaitedPromptId !== awaitedPromptId) return;
        sendEvent(session, {
          kind: 'activity',
          sessionId,
          taskId,
          payload: { type: 'permission', promptId: awaitedPromptId, pending: true, ...(options ? { options } : {}) },
        });
      })();
    } else if (previousPromptId) {
      sendEvent(session, { kind: 'activity', sessionId, taskId, payload: { type: 'permission', promptId: previousPromptId, pending: false } });
    }
  };

  const onDataTap = (tappedSessionId: string, data: string): void => {
    if (tappedSessionId !== sessionId) return;
    pendingTerminalChunks.push(data);
    pendingTerminalChars += data.length;
    if (pendingTerminalChars <= TERMINAL_IMMEDIATE_FLUSH_CHARS) {
      flushTerminal();
      return;
    }
    if (!terminalFlushTimer) terminalFlushTimer = setTimeout(flushTerminal, TERMINAL_COALESCE_MS);
  };
  // Grid changes ride the same subscription as the bytes they explain. The
  // pending flush runs FIRST so output drawn for the old grid is delivered
  // before the phone re-sizes its renderer; the TUI's own repaint bytes
  // follow on the terminal stream.
  const onPtyResize = (resizedSessionId: string, cols: number, rows: number): void => {
    if (resizedSessionId !== sessionId) return;
    flushTerminal();
    sendEvent(session, { kind: 'terminal-resize', sessionId, taskId, payload: { cols, rows } });
  };
  const onActivity = (activitySessionId: string, state: ActivityState, reason: ActivityReason): void => {
    if (activitySessionId !== sessionId) return;
    sendEvent(session, {
      kind: 'activity',
      sessionId,
      taskId,
      payload: { type: 'activity', state, reason: toActivityReasonWire(reason) },
    });
    pushPermissionIfChanged();
  };
  /**
   * Usage is token accounting: it ticks on essentially every token, but the
   * phone renders it as a context-percentage bar. Measured on a live board,
   * unthrottled pushes were the single largest ONGOING cost once the terminal
   * stream was removed - 117 events in a few minutes, roughly 1MB an hour of
   * mobile data and relay egress to animate one progress bar.
   *
   * So coalesce on the WIRE, not just in the phone's renderer: keep the newest
   * value and emit at most one per window. The trailing edge always fires, so
   * the bar still settles on the true final number when a turn ends.
   */
  const onUsage = (usageSessionId: string, usage: SessionUsage): void => {
    if (usageSessionId !== sessionId) return;
    pendingUsage = usage;
    if (usageFlushTimer) return;
    usageFlushTimer = setTimeout(flushUsage, USAGE_COALESCE_MS);
  };
  const onSessionEvent = (eventSessionId: string, event: SessionEvent): void => {
    if (eventSessionId !== sessionId) return;
    sendEvent(session, { kind: 'activity', sessionId, taskId, payload: { type: 'event', event: toSessionEventWire(event) } });
    pushPermissionIfChanged();
    void pushTranscriptIfChanged();
  };

  // When the session exits, tear our own subscription down: nothing else
  // removes these listeners until the device disconnects, so without this a
  // long-lived phone connection would leak four listeners per session it ever
  // streamed onto the singleton SessionManager. Before tearing down, tell the
  // phone the session ended (with the deliberate-stop flag the session
  // manager's exit event carries) - the feed's last word, so the phone never
  // has to infer "over" from silence. The queued-removal exit path emits the
  // flag explicitly; the spawn-failure path emits no flag, and a spawn
  // failure is not a deliberate stop, so an absent flag maps to false.
  const onExit = (exitedSessionId: string, _exitCode: number, intentional?: boolean): void => {
    if (exitedSessionId !== sessionId) return;
    flushTerminal(); // push any last coalesced output before we stop listening
    // Same for the coalesced usage: the final token count of a finished turn
    // is the one number a user is most likely to look at.
    if (usageFlushTimer) clearTimeout(usageFlushTimer);
    flushUsage();
    sendEvent(session, {
      kind: 'activity',
      sessionId,
      taskId,
      payload: { type: 'session-ended', intentional: intentional === true },
    });
    subscriptions.remove(subscriptionKeyFor(sessionId));
  };

  // A list-only subscriber (a phone showing its session feed) discards PTY
  // bytes on arrival, so never attach the taps that produce them. Activity,
  // permission and transcript pushes still flow - those are what the list is
  // for. The grid-size event goes too: it only explains bytes we are not
  // sending, and the phone re-subscribes with terminal:true the moment a
  // terminal opens, which delivers a fresh frame and its dimensions together.
  if (wantsTerminal) {
    context.sessionManager.on('data-tap', onDataTap);
    context.sessionManager.on('pty-resize', onPtyResize);
  }
  context.sessionManager.on('activity', onActivity);
  context.sessionManager.on('usage', onUsage);
  context.sessionManager.on('event', onSessionEvent);
  context.sessionManager.on('exit', onExit);

  subscriptions.set(subscriptionKeyFor(sessionId), () => {
    disposed = true; // parks any in-flight prompt-options probe so it never sends after teardown
    context.sessionManager.off('data-tap', onDataTap);
    context.sessionManager.off('pty-resize', onPtyResize);
    context.sessionManager.off('activity', onActivity);
    context.sessionManager.off('usage', onUsage);
    context.sessionManager.off('event', onSessionEvent);
    context.sessionManager.off('exit', onExit);
    if (terminalFlushTimer) clearTimeout(terminalFlushTimer);
    if (usageFlushTimer) clearTimeout(usageFlushTimer);
  });

  // Seed the sync state WITHOUT emitting: the phone bootstraps its view
  // with a transcript-window request right after subscribing (tail first,
  // older pages on demand), so pushing the whole transcript here would be
  // redundant - and for long sessions impossible within the frame cap.
  // Deltas cover only what changes from this point on.
  void (async (): Promise<void> => {
    try {
      const resolved = await resolveTaskTranscript(db, sessionId);
      if (!resolved) return;
      transcriptSync.seed(resolved);
      // The list's one line, delivered at subscribe rather than waiting for
      // the session's next change: an idle session may never change again,
      // and its card would otherwise have nothing to show.
      if (!disposed) pushMessagePreviewIfChanged(resolved.entries);
    } catch {
      // Best-effort: an unseeded sync just means the first post-subscribe
      // change diffs against nothing and streams as plain appends.
    }
  })();
}

export async function handleReadStream(
  request: CapabilityRequestMessage,
  session: BridgeSession,
  context: IpcContext,
  subscriptions: SubscriptionRegistry,
): Promise<CapabilityResponseMessage> {
  const payload = parseCapabilityRequestPayload('read-stream', request.payload);
  const subscriptionKey = subscriptionKeyFor(payload.sessionId);

  if (payload.action === 'unsubscribe') {
    subscriptions.remove(subscriptionKey);
    return { type: 'capability-response', requestId: request.requestId, ok: true };
  }

  // Reading a transcript needs no live session, and must not require one: a
  // completed task's conversation is the whole point of the phone's Done
  // column, and by the time a task is archived its agent is long gone (the
  // move to Done suspends the PTY and nulls task.session_id). The transcript
  // itself outlives all of that - resolveTaskTranscript stitches it from the
  // session RECORDS plus their JSONL on disk, both of which are preserved
  // precisely so the work can be resumed or re-read later.
  //
  // Ordered ahead of the live-session gate rather than relaxing that gate,
  // so every other action still requires a running session exactly as before.
  if (payload.action === 'transcript-window') {
    const projectId = resolveProjectIdForSession(context, payload.sessionId);
    if (!projectId) {
      return { type: 'capability-response', requestId: request.requestId, ok: false, error: `No such session: ${payload.sessionId}` };
    }
    const resolved = await resolveTaskTranscript(getProjectDb(projectId), payload.sessionId);
    const windowPayload: TranscriptWindowResponsePayload = resolved
      ? sliceTranscriptWindow(resolved, payload.beforeIndex, payload.limit)
      : { revision: 0, totalEntries: 0, startIndex: 0, entries: [] };
    return { type: 'capability-response', requestId: request.requestId, ok: true, payload: toWireJson(windowPayload) };
  }

  const liveSession = context.sessionManager.getSession(payload.sessionId);
  if (!liveSession) {
    return { type: 'capability-response', requestId: request.requestId, ok: false, error: `No such session: ${payload.sessionId}` };
  }

  // The mobile seed is the PARSED-grid serialized frame, not the raw byte
  // replay: a raw 512KB replay drops a fullscreen TUI's write-once static cells
  // once their drawing bytes age out of the window, so the phone's cold replay
  // renders them blank. The serialized frame reconstructs every visible cell.
  //
  // A list-only subscriber (terminal:false) has no renderer to seed and drops
  // this on arrival, so skip building it entirely - it is the single largest
  // field in this response, and it was being sent once per live session on
  // every cold start.
  const wantsTerminal = payload.terminal !== false;
  const scrollback = wantsTerminal ? await context.sessionManager.getSerializedFrame(payload.sessionId) : '';
  const activityState = context.sessionManager.getActivityCache()[payload.sessionId] ?? null;
  const activityReason = context.sessionManager.getActivityReason(payload.sessionId);
  const usage = context.sessionManager.getUsageCache()[payload.sessionId] ?? null;
  const awaitedPromptId = currentAwaitedPromptId(context, payload.sessionId);

  const ptyDimensions = toTerminalDimensionsWire(context.sessionManager.getDimensions(payload.sessionId));
  // The prompt was outstanding before this subscribe, so its dialog is
  // already painted into the frame we just serialized - probe that frame
  // directly instead of a second read. Null = no numbered dialog parsed;
  // the phone falls back to its blind approve/deny keystrokes.
  const awaitedPromptOptions = awaitedPromptId ? extractPromptOptions(scrollback, ptyDimensions) : null;
  const responsePayload: ReadStreamResponsePayload = {
    scrollback,
    activity: {
      state: activityState,
      reason: activityReason ? toActivityReasonWire(activityReason) : null,
    },
    usage: usage ? toSessionUsageWire(usage) : null,
    awaitedPromptId,
    ...(awaitedPromptId ? { awaitedPromptOptions } : {}),
    ...(ptyDimensions ? { ptyDimensions } : {}),
    sessionStatus: toReadStreamSessionStatusWire(liveSession.status),
  };

  subscribeReadStream(payload.sessionId, liveSession.taskId, awaitedPromptId, session, context, subscriptions, wantsTerminal);

  return { type: 'capability-response', requestId: request.requestId, ok: true, payload: toWireJson(responsePayload) };
}

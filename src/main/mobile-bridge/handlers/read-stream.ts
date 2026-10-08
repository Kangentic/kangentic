import {
  encodeMessageFailure,
  MAX_DECODED_LENGTH,
  MAX_FRAME_LENGTH,
  parseCapabilityRequestPayload,
  type CapabilityRequestMessage,
  type CapabilityResponseMessage,
  type ReadStreamResponsePayload,
  type TranscriptWindowResponsePayload,
} from '@kangentic/protocol';
import type { ActivityReason, ActivityState, Session, SessionEvent, SessionStatus, SessionUsage } from '../../../shared/types';
import { getProjectDb } from '../../db/database';
import { SessionRepository } from '../../db/repositories/session-repository';
import { getProjectRepos } from '../../ipc/helpers/project-repos';
import { isPausedTaskSession, isResumeOffered, isTaskPaused } from '../../../shared/session-resume-eligibility';
import { agentRegistry } from '../../agent/agent-registry';
import { retrievalClient } from '../../retrieval/retrieval-client';
import { collectRemoteTargets } from '../../retrieval/remote-targets';
import type { IpcContext } from '../../ipc/ipc-context';
import type { BridgeSession } from '../session/bridge-session';
import { SERIALIZED_SCROLLBACK_LINES } from '../../pty/host/protocol';
import type { SubscriptionRegistry } from '../session/subscription-registry';
import { sendEvent } from './send-event';
import { buildPermissionPromptId } from './permission-prompt-id';
import { extractPromptOptions } from '../prompt-options-probe';
import { noteRequestSpan } from '../request-spans';
import {
  toActivityReasonWire,
  toReadStreamSessionStatusWire,
  toSessionEventWire,
  toSessionUsageWire,
  toSpawnProgressLabelWire,
  toTerminalDimensionsWire,
  toWireJson,
} from './wire-mappers';
import { getInFlightSpawnProgress } from '../../transition-engine/spawn-progress';

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

/**
 * Trailing window for transcript pushes. Every hook event used to re-read
 * and diff the task's whole stitched transcript, once per event per phone
 * subscription, and a tool burst fires several a second. A burst now costs one
 * read at its end, a quarter second later, which a phone reading a live turn
 * does not notice.
 */
const TRANSCRIPT_COALESCE_MS = 250;

/** Distinguishes one subscription's transcript sync from another's in the worker. */
let nextSyncNumber = 1;

export function subscriptionKeyFor(sessionId: string): string {
  return `stream:${sessionId}`;
}

/**
 * Marker key present ONLY while a subscription with `terminal: true` is live.
 * `stream:<id>` alone cannot answer "is a phone watching this TERMINAL":
 * the phone holds list-only stream subscriptions for EVERY live session the
 * moment it connects (its activity feed), and gating the resting park on the
 * bare stream key made the park fire for all of them - sessions no phone
 * terminal ever opened were reshaped to the resting grid, and every later
 * panel reveal replayed them at the wrong geometry (the mis-wrapped-panel
 * defect, observed live 2026-08-02). The teardown registered under
 * `stream:<id>` removes this marker, so every release path (replace,
 * unsubscribe, exit, transport drop, dispose) clears both together.
 */
export const TERMINAL_STREAM_KEY_PREFIX = 'stream-terminal:';

export function terminalStreamKeyFor(sessionId: string): string {
  return `${TERMINAL_STREAM_KEY_PREFIX}${sessionId}`;
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

/**
 * Whether the desktop's own task view would offer Resume for this session
 * (`isResumeOffered`). The streamed session's copy of the board row's
 * `resumable`: a pause clears the task's `session_id`, so a phone holds no
 * stream on a paused session for long, and the board row is the copy it
 * gates Resume on. This one keeps an open session screen current through
 * the suspend itself.
 *
 * Reads the task only for a suspended session, so a running feed costs no
 * lookup. A Command Terminal session belongs to no task and is never
 * resumable. A task or project that cannot be read answers false, which hides
 * Resume rather than offering one start-session would refuse.
 */
function isSessionResumable(context: IpcContext, session: Session): boolean {
  // This session first: the stream's copy answers for the session it carries.
  // Decided before any lookup, which it gates.
  if (!isPausedTaskSession(session) || !session.taskId || !session.projectId) return false;
  try {
    const { tasks, swimlanes } = getProjectRepos(context, session.projectId);
    const task = tasks.getById(session.taskId);
    if (!task) return false;
    const lane = swimlanes.getById(task.swimlane_id);
    // Then the board row's own scan, so a paused row whose task already holds
    // a queued or running successor answers false here as it does there.
    const hasPausedSession = isTaskPaused(context.sessionManager.listSessions(), session.taskId);
    return isResumeOffered({ hasPausedSession, task, laneRole: lane?.role });
  } catch (error) {
    // Logged because the false is silent on the phone: Resume just never shows.
    console.warn(`[mobile-bridge] could not read task ${session.taskId.slice(0, 8)} for resumable:`, error);
    return false;
  }
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

/** A tap chunk as the pty host stamped it: the bytes and the cumulative parser offset just past them. */
interface StampedTapChunk {
  data: string;
  endOffset: number | undefined;
}

/**
 * What the seed covers, for exactly-once delivery around it: the parser
 * offset its snapshot holds (getSeedFrame's barrierOffset) and the tap chunks
 * that arrived while it was being taken.
 */
interface SeedCoverage {
  barrierOffset: number;
  racedChunks: StampedTapChunk[];
}

function subscribeReadStream(
  sessionId: string,
  snapshotSession: Session,
  snapshotResumable: boolean,
  initialAwaitedPromptId: string | null,
  session: BridgeSession,
  context: IpcContext,
  subscriptions: SubscriptionRegistry,
  wantsTerminal: boolean,
  seedCoverage: SeedCoverage | null = null,
): void {
  const taskId = snapshotSession.taskId;
  // A session with no owning project (a Command Terminal session carries
  // none) has no transcript to stream. This used to open the database named
  // '' instead, which creates a stray `projects/.db` file.
  const ownerProjectId = resolveProjectIdForSession(context, sessionId);
  // The transcript diff runs in the retrieval worker, which keeps this
  // subscription's sync state under this id (`transcript.mobileSync`).
  const syncId = `${sessionId}:${nextSyncNumber++}`;
  let transcriptReadInFlight = false;
  let transcriptRereadWanted = false;
  let transcriptTimer: ReturnType<typeof setTimeout> | null = null;
  let lastAwaitedPromptId = initialAwaitedPromptId;
  let lastMessagePreview: string | null = null;
  let pendingUsage: SessionUsage | null = null;
  let usageFlushTimer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  // The snapshot already told the phone these; only a change is pushed.
  let lastSentStatus: SessionStatus = snapshotSession.status;
  let lastSentResuming = snapshotSession.resuming;
  let lastSentResumable = snapshotResumable;
  // A Command Terminal session belongs to no task, so no other session can
  // be its successor.
  const tracksSuccessor = taskId !== '' && snapshotSession.transient !== true;

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

  const readTranscriptChanges = async (): Promise<void> => {
    if (!ownerProjectId || disposed) return;
    transcriptReadInFlight = true;
    try {
      const { payloads, preview } = await retrievalClient.call('transcript.mobileSync', {
        syncId,
        projectId: ownerProjectId,
        sessionId,
        mode: 'diff',
        remoteTargets: collectRemoteTargets(agentRegistry),
      });
      if (disposed) return;
      // Delta chunks carry only what changed - usually just the mutating tail
      // entry, so each frame is small.
      for (const payload of payloads) {
        sendEvent(session, { kind: 'transcript', sessionId, taskId, payload });
      }
      pushMessagePreviewIfChanged(preview);
    } catch {
      // Best-effort; a transcript-read failure should not tear down the subscription.
    } finally {
      transcriptReadInFlight = false;
      if (transcriptRereadWanted && !disposed) {
        transcriptRereadWanted = false;
        pushTranscriptIfChanged();
      }
    }
  };

  // Coalesced: a burst of events becomes one read at its end, and an event
  // during a read asks for one more after it.
  const pushTranscriptIfChanged = (): void => {
    if (transcriptReadInFlight) {
      transcriptRereadWanted = true;
      return;
    }
    if (transcriptTimer) return;
    transcriptTimer = setTimeout(() => {
      transcriptTimer = null;
      void readTranscriptChanges();
    }, TRANSCRIPT_COALESCE_MS);
  };

  // The one line a phone's session list renders. Derived from the transcript
  // read anyway, so the list costs no request of its own; sent only when the
  // text actually changes, so an idle session is silent.
  const pushMessagePreviewIfChanged = (text: string | null): void => {
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

  // Exactly-once around the seed: a chunk ending at or before the barrier is
  // already in the seed, the one straddling it is sliced, and the first chunk
  // past it retires the filter (every later chunk is new). The offsets never
  // restart under a held barrier: a session id is minted once per spawn, and
  // the one id reused (a queued placeholder's, at promotion) has no host
  // buffer when it is seeded, so its barrier is 0. A chunk with no offset (a
  // test double, an older host) passes through unfiltered.
  let seedBarrierOffset: number | null = seedCoverage?.barrierOffset ?? null;
  const trimToSeed = (data: string, endOffset: number | undefined): string => {
    if (seedBarrierOffset === null || endOffset === undefined) return data;
    if (endOffset <= seedBarrierOffset) return '';
    const startOffset = endOffset - data.length;
    const fresh = startOffset < seedBarrierOffset ? data.slice(seedBarrierOffset - startOffset) : data;
    seedBarrierOffset = null;
    return fresh;
  };

  const onDataTap = (tappedSessionId: string, rawData: string, endOffset?: number): void => {
    if (tappedSessionId !== sessionId) return;
    const data = trimToSeed(rawData, endOffset);
    if (!data) return;
    // Once suspend()/kill() has begun tearing this session down, drop
    // further bytes instead of queuing them: they are the adapter's own
    // exit sequence (Ctrl+C, `/exit`) and the fullscreen TUI's repaint as it
    // leaves the alternate screen, not agent output a live viewer should
    // see. On the suspend() path desktop's own terminal pane is protected
    // from this by an accidental race (its tab drops on the session-changed
    // status flip, which fires before the exit sequence is even written).
    // kill() has no such race - it deliberately leaves status at 'running'
    // (a hard reset is 'exited', not resumable) and emits no flip before
    // writeExitSequence, so the desktop pane does render kill()'s exit
    // sequence. Either way this tap must check explicitly: the
    // session-changed listener below pushes status only and never stops the
    // tap, and this check covers both paths. Whatever was already queued
    // before teardown began still flushes normally - only NEW bytes are
    // dropped.
    if (context.sessionManager.isSessionTeardownInFlight(sessionId)) return;
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
    pushTranscriptIfChanged();
  };

  // When the session ends, tear our own subscription down: nothing else
  // removes these listeners until the device disconnects, so without this a
  // long-lived phone connection would leak its listeners for every session it
  // ever streamed onto the singleton SessionManager. Before tearing down, tell
  // the phone the session ended (with the deliberate-stop flag the session
  // manager's exit event carries) - the feed's last word, so the phone never
  // has to infer "over" from silence. The queued-removal exit path emits the
  // flag explicitly; the spawn-failure path emits no flag, and a spawn
  // failure is not a deliberate stop, so an absent flag maps to false.
  //
  // `intentional` alone cannot tell a same-column respawn (model/agent/
  // effort switch) from a genuine park: SessionManager.suspend() marks
  // `status = 'suspended'` before the force-kill for every caller, so both
  // reach here as `intentional: true`. Attach the task's in-flight
  // spawn-progress label when one exists - suspendLiveSessionForRespawn
  // (task-move.ts) emits it as the FIRST statement of a respawn, well
  // before the suspend() that produces this exit, and that file's own park
  // branches clear it before suspending. The five parks that do NOT clear it
  // (a manual pause, the idle-timeout suspend, the `kill_session` action,
  // project-relocate, auto-spawn-reconcile - named in
  // docs/session-lifecycle.md) can send a stale label on a real park until
  // the 120s TTL sweeps it, so the label is a strong hint, not proof. See
  // the doc comment on ActivityEventPayload's session-ended variant in
  // @kangentic/protocol.
  //
  // A PTY exit is not the only end. A feed held on a session with no PTY (a
  // paused row, which the phone's session list subscribes to like any other)
  // never sees an 'exit': a resume spawns a NEW session id and the spawn flow
  // drops the paused row without any event, and a removed paused row emits
  // only 'session-removed'. Those paths end the feed here too, so it is not
  // left silent with its listeners attached until the phone disconnects.
  const endFeed = (ending: { intentional: boolean; successorSessionId?: string }): void => {
    if (disposed) return;
    flushTerminal(); // push any last coalesced output before we stop listening
    // Same for the coalesced usage: the final token count of a finished turn
    // is the one number a user is most likely to look at.
    if (usageFlushTimer) clearTimeout(usageFlushTimer);
    flushUsage();
    // Annotated, not inferred: getInFlightSpawnProgress()'s Record<string,
    // string> index signature erases the missing-key case, which is the
    // common one here (a park with no respawn in flight).
    const inFlightLabel: string | undefined = getInFlightSpawnProgress()[taskId];
    const spawnProgressLabel = toSpawnProgressLabelWire(inFlightLabel ?? null);
    sendEvent(session, {
      kind: 'activity',
      sessionId,
      taskId,
      payload: {
        type: 'session-ended',
        intentional: ending.intentional,
        ...(spawnProgressLabel ? { spawnProgressLabel } : {}),
        ...(ending.successorSessionId ? { successorSessionId: ending.successorSessionId } : {}),
      },
    });
    subscriptions.remove(subscriptionKeyFor(sessionId));
  };

  const ownRowGone = (): boolean => context.sessionManager.getSession(sessionId) === undefined;

  const onExit = (exitedSessionId: string, _exitCode: number, intentional?: boolean): void => {
    if (exitedSessionId === sessionId) {
      endFeed({ intentional: intentional === true });
      return;
    }
    // A successor whose own spawn failed after the spawn flow dropped this
    // row reports only 'exit' (spawn-failure-handler.ts), never a
    // 'session-changed'. There is no live successor to name, but this feed's
    // session is gone all the same.
    if (tracksSuccessor && context.sessionManager.getSessionTaskId(exitedSessionId) === taskId && ownRowGone()) {
      endFeed({ intentional: true });
    }
  };

  // `resumable` is recomputed on every edge, so a status edge that changes
  // nothing but it (the task's column was read again after a suspend) still
  // reaches the phone.
  const pushStatusIfChanged = (current: Session): void => {
    const resumable = isSessionResumable(context, current);
    if (current.status === lastSentStatus && current.resuming === lastSentResuming && resumable === lastSentResumable) return;
    lastSentStatus = current.status;
    lastSentResuming = current.resuming;
    lastSentResumable = resumable;
    sendEvent(session, {
      kind: 'activity',
      sessionId,
      taskId,
      payload: { type: 'status', status: toReadStreamSessionStatusWire(current.status), resuming: current.resuming, resumable },
    });
  };

  // 'session-changed' carries every status edge that keeps the session id:
  // a queue promotion, a suspend (pushed before the PTY's exit, which then
  // ends the feed), and the agent-absence sweep's 'exited'. It also fires
  // with no status change (an agent session id captured, suspend's trailing
  // emit), hence the dedupe. An 'exited' status does NOT end the feed: the
  // PTY's 'exit' follows on every path that sets it (the exit handler emits
  // it whatever the status already says), and onExit stays the one place
  // session-ended is sent from for a PTY. The exception is
  // announceSessionEnded after awaitExit gave up waiting, which emits no
  // 'exit'; that feed keeps its listeners until the phone unsubscribes.
  //
  // Another session of the same task arriving while this feed's row is gone
  // is a resume replacing a paused row (the spawn flow drops the paused
  // sibling silently, then announces the new session). Keyed on "this row is
  // gone" rather than on the newcomer's status: with the concurrency limit
  // full, the newcomer first appears as 'queued' while the paused row still
  // exists, and the row is only dropped when the newcomer is promoted.
  const onSessionChanged = (changedSessionId: string, changedSession: Session): void => {
    if (changedSessionId === sessionId) {
      pushStatusIfChanged(changedSession);
      return;
    }
    if (!tracksSuccessor || changedSession.taskId !== taskId || changedSession.transient === true) return;
    if (!ownRowGone()) return;
    endFeed({
      intentional: true,
      ...(changedSession.status !== 'exited' ? { successorSessionId: changedSessionId } : {}),
    });
  };

  // A row removed outright (a paused task moved to To Do) announces itself
  // only here. A running session's removal also lands here before its PTY's
  // asynchronous 'exit', and every removal is a deliberate teardown.
  //
  // Coupling: the successor hop above depends on the spawn flow's sibling
  // drain (session-spawn-flow.ts) dropping the paused row WITHOUT a
  // 'session-removed', and before the new session's 'session-changed'. If
  // that drain starts emitting one, this listener ends the feed before the
  // successor is registered, and the hop silently loses its
  // successorSessionId. session-spawn-flow.test.ts pins the drain's side
  // ("guards the mobile read-stream successor hop: ...").
  const onSessionRemoved = (removedSessionId: string): void => {
    if (removedSessionId !== sessionId) return;
    endFeed({ intentional: true });
  };

  // A list-only subscriber (a phone showing its session feed) discards PTY
  // bytes on arrival, so never attach the taps that produce them. Activity,
  // permission and transcript pushes still flow - those are what the list is
  // for. The grid-size event goes too: it only explains bytes we are not
  // sending, and the phone re-subscribes with terminal:true the moment a
  // terminal opens, which delivers a fresh frame and its dimensions together.
  // The pty host forwards a session's raw bytes to main only while someone
  // holds a tap on it.
  const releaseDataTap = wantsTerminal ? context.sessionManager.subscribeDataTap(sessionId) : null;
  if (wantsTerminal) {
    context.sessionManager.on('data-tap', onDataTap);
    context.sessionManager.on('pty-resize', onPtyResize);
  }
  // Output that raced the seed rides the coalesce timer, never an inline
  // flush: the seed's response is sent after this handler returns, and no
  // terminal byte may reach the phone ahead of it.
  if (wantsTerminal && seedCoverage) {
    for (const chunk of seedCoverage.racedChunks) {
      const fresh = trimToSeed(chunk.data, chunk.endOffset);
      if (!fresh || context.sessionManager.isSessionTeardownInFlight(sessionId)) continue;
      pendingTerminalChunks.push(fresh);
      pendingTerminalChars += fresh.length;
    }
    if (pendingTerminalChunks.length > 0 && !terminalFlushTimer) terminalFlushTimer = setTimeout(flushTerminal, TERMINAL_COALESCE_MS);
  }
  context.sessionManager.on('activity', onActivity);
  context.sessionManager.on('usage', onUsage);
  context.sessionManager.on('event', onSessionEvent);
  context.sessionManager.on('exit', onExit);
  context.sessionManager.on('session-changed', onSessionChanged);
  context.sessionManager.on('session-removed', onSessionRemoved);

  subscriptions.set(subscriptionKeyFor(sessionId), () => {
    disposed = true; // parks any in-flight prompt-options probe so it never sends after teardown
    context.sessionManager.off('data-tap', onDataTap);
    releaseDataTap?.();
    context.sessionManager.off('pty-resize', onPtyResize);
    context.sessionManager.off('activity', onActivity);
    context.sessionManager.off('usage', onUsage);
    context.sessionManager.off('event', onSessionEvent);
    context.sessionManager.off('exit', onExit);
    context.sessionManager.off('session-changed', onSessionChanged);
    context.sessionManager.off('session-removed', onSessionRemoved);
    if (terminalFlushTimer) clearTimeout(terminalFlushTimer);
    if (usageFlushTimer) clearTimeout(usageFlushTimer);
    if (transcriptTimer) clearTimeout(transcriptTimer);
    // The worker's sync state for this subscription goes with it.
    retrievalClient.notifyRunning('transcript.mobileRelease', { syncId });
    // The terminal marker lives and dies with THIS subscription: a list-only
    // re-subscribe replaces this teardown, which runs it, which drops the
    // marker before the new registration decides whether to re-add it.
    subscriptions.remove(terminalStreamKeyFor(sessionId));
  });
  if (wantsTerminal) {
    subscriptions.set(terminalStreamKeyFor(sessionId), () => {
      // Marker only - the real teardown lives under subscriptionKeyFor.
    });
  }

  // Seed the sync state WITHOUT emitting: the phone bootstraps its view
  // with a transcript-window request right after subscribing (tail first,
  // older pages on demand), so pushing the whole transcript here would be
  // redundant - and for long sessions impossible within the frame cap.
  // Deltas cover only what changes from this point on.
  void (async (): Promise<void> => {
    if (!ownerProjectId) return;
    try {
      const { preview } = await retrievalClient.call('transcript.mobileSync', {
        syncId,
        projectId: ownerProjectId,
        sessionId,
        mode: 'seed',
        remoteTargets: collectRemoteTargets(agentRegistry),
      });
      // The list's one line, delivered at subscribe rather than waiting for
      // the session's next change: an idle session may never change again,
      // and its card would otherwise have nothing to show.
      if (!disposed) pushMessagePreviewIfChanged(preview);
    } catch {
      // Best-effort: an unseeded sync just means the first post-subscribe
      // change diffs against nothing and streams as plain appends.
    }
  })();
}

/**
 * A seed shrink keeps this fraction of what a straight proportion allows. The
 * viewport does not shrink with the history, so a frame cut by exactly its
 * overshoot would still be a little over; the margin makes the first retry
 * usually the last. It only has to be close: each rung is verified.
 */
const SEED_SHRINK_FIT_MARGIN = 0.8;

/** Floor on the overshoot a shrink scales by, so a frame barely over the cap still loses history. */
const SEED_SHRINK_MIN_OVERSHOOT = 1.25;

/**
 * History rows to re-take a seed with after `response` (carrying the full
 * seed) did not fit the frame caps. Scaled from how far the response overshot
 * the cap that refused it: the pre-compression cap when the raw JSON is over
 * that one, else the wire cap, which raw JSON approximates from above (deflate
 * only helps), so a compressible frame loses a little more history than it
 * strictly had to. Zero or less means no scaled retry is worth taking.
 */
function scaledSeedHistoryLines(response: CapabilityResponseMessage): number {
  const rawBytes = Buffer.byteLength(JSON.stringify(response), 'utf8');
  const limit = rawBytes > MAX_DECODED_LENGTH ? MAX_DECODED_LENGTH : MAX_FRAME_LENGTH;
  const overshoot = Math.max(rawBytes / limit, SEED_SHRINK_MIN_OVERSHOOT);
  return Math.floor((SERIALIZED_SCROLLBACK_LINES * SEED_SHRINK_FIT_MARGIN) / overshoot);
}

/** One build of the subscribe response, plus the registry reads the subscription is registered with. */
interface BuiltReadStreamResponse {
  response: CapabilityResponseMessage;
  snapshotSession: Session;
  resumable: boolean;
  awaitedPromptId: string | null;
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
    // Parsed, stitched and paged in the retrieval worker.
    const windowPayload: TranscriptWindowResponsePayload = await retrievalClient.call('transcript.window', {
      projectId,
      sessionId: payload.sessionId,
      beforeIndex: payload.beforeIndex,
      limit: payload.limit,
      remoteTargets: collectRemoteTargets(agentRegistry),
    });
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
  // A re-subscribe over a live terminal stream finds the marker already up,
  // and a failed re-subscribe must leave it for that stream.
  const terminalMarkerAlreadyHeld = subscriptions.has(terminalStreamKeyFor(payload.sessionId));
  // A terminal-wanting subscribe IS the mobile interest the resting park
  // exists for: park an unheld session NOW, before the frame below is
  // serialized, so the phone's one seed already carries the resting grid
  // instead of the strip the last desktop surface left (plus a second
  // reflow-and-reseed when the debounced park fired later).
  if (wantsTerminal) {
    context.sessionManager.parkRestingGridForMobileSubscriber(payload.sessionId);
    // The marker goes up BEFORE the awaited serialize below: resize()'s
    // floor refusal consults it, and without it a desktop fit landing inside
    // the settle window (20-400ms) could reshape the grid back under the
    // phone so the one seed carried exactly the sliver the park removed.
    // subscribeReadStream re-registers the same key, which is replace-safe.
    subscriptions.set(terminalStreamKeyFor(payload.sessionId), () => {
      // Marker only - see subscribeReadStream.
    });
  }
  // The frame the response carries. It starts as the full-depth seed and is
  // replaced by a shorter one when that does not fit the wire (see below).
  let scrollback = '';
  // The most recent snapshot taken, kept for the prompt-option probe. The
  // empty-seed rung sends no frame, so the probe still has a grid to read.
  let latestTakenFrame = '';
  let seedCoverage: SeedCoverage | null = null;
  // Tapped BEFORE the seed is asked for, and held until subscribeReadStream
  // holds its own tap. The host forwards a session's bytes only while a tap
  // is held, so without this, output produced while the seed is taken would
  // reach neither the seed nor the stream. Every chunk carries its parser
  // offset, and subscribeReadStream drops what the seed's barrier already
  // covers, so a byte still pending at the snapshot is not sent twice.
  const racedChunks: StampedTapChunk[] = [];
  const captureRacedChunk = (tappedSessionId: string, data: string, endOffset?: number): void => {
    if (tappedSessionId === payload.sessionId) racedChunks.push({ data, endOffset });
  };
  const releaseSeedTap = wantsTerminal ? context.sessionManager.subscribeDataTap(payload.sessionId) : null;
  let subscribed = false;
  try {
    if (wantsTerminal) {
      context.sessionManager.on('data-tap', captureRacedChunk);
      // The seed's own span (the pty host's repaint settle plus the serialize)
      // rides the service's slow-request line, so a slow open says whether the
      // time went here or on the wire.
      const seedStartedAt = performance.now();
      const seed = await context.sessionManager.getSeedFrame(payload.sessionId);
      scrollback = seed.frame;
      latestTakenFrame = seed.frame;
      seedCoverage = { barrierOffset: seed.barrierOffset, racedChunks };
      noteRequestSpan(
        session.deviceId,
        request.requestId,
        `seed ${Math.round(performance.now() - seedStartedAt)} ms (settle ${seed.settleMs} ms, serialize ${seed.serializeMs} ms), ${Math.round(scrollback.length / 1024)}k chars`,
      );
    }

    // The prompt-option probe reads the snapshot that was latest when a build
    // first saw the prompt. That is the full-depth frame when the prompt was
    // already up, and the re-take after it when the prompt rose during a shrink.
    // The probe reads the grid's bottom rows, which every taken frame carries
    // whole. Read once per prompt: a later build reuses it.
    let probedPromptOptions: string[] | null | undefined;
    // Everything in the response but the seed, read fresh from the registry on
    // every build. Null when the session is gone.
    //
    // Re-read the row now rather than trusting `liveSession`. The session can
    // exit DURING the awaits above or below. Registering the subscription then
    // would be post-mortem: its own onExit teardown never fires (the exit
    // already happened), so the listeners and the marker above would leak until
    // the device disconnects - and the dead id would ride the terminal-streamed
    // set into the renderer indefinitely. And a queue promotion inside an await
    // replaces the registry row (session-spawn-flow.ts), so `liveSession` can
    // still say 'queued' while the registry says 'running'. The snapshot's
    // status, and the baseline the live `status` push dedupes against, both
    // come from this read. A list-only subscribe has no await, so this reads
    // the same row it already had. A shrink re-takes the seed, which is another
    // await, so it builds again afterwards.
    const buildResponse = (): BuiltReadStreamResponse | null => {
      const snapshotSession = context.sessionManager.getSession(payload.sessionId);
      if (!snapshotSession) return null;
      const activityState = context.sessionManager.getActivityCache()[payload.sessionId] ?? null;
      const activityReason = context.sessionManager.getActivityReason(payload.sessionId);
      const usage = context.sessionManager.getUsageCache()[payload.sessionId] ?? null;
      const awaitedPromptId = currentAwaitedPromptId(context, payload.sessionId);

      const ptyDimensions = toTerminalDimensionsWire(context.sessionManager.getDimensions(payload.sessionId));
      // The prompt was outstanding before this subscribe, so its dialog is
      // already painted into the frame we serialized - probe that frame
      // directly instead of a second read. Null = no numbered dialog parsed;
      // the phone falls back to its blind approve/deny keystrokes.
      let awaitedPromptOptions: string[] | null = null;
      if (awaitedPromptId) {
        if (probedPromptOptions === undefined) probedPromptOptions = extractPromptOptions(latestTakenFrame, ptyDimensions);
        awaitedPromptOptions = probedPromptOptions;
      }
      const resumable = isSessionResumable(context, snapshotSession);
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
        sessionStatus: toReadStreamSessionStatusWire(snapshotSession.status),
        resuming: snapshotSession.resuming,
        resumable,
      };
      const response: CapabilityResponseMessage = { type: 'capability-response', requestId: request.requestId, ok: true, payload: toWireJson(responsePayload) };
      return { response, snapshotSession, resumable, awaitedPromptId };
    };
    const sessionGone = (): CapabilityResponseMessage =>
      ({ type: 'capability-response', requestId: request.requestId, ok: false, error: `No such session: ${payload.sessionId}` });

    let built = buildResponse();
    if (!built) return sessionGone();

    // A phone always gets a terminal. A response over the frame caps is
    // answered with a shorter seed, never a refusal. A user who opens a session
    // is there to watch or work with an agent, and a refusal reads to the phone
    // as the session being gone. The size is checked BEFORE subscribing for the
    // same reason it is shrunk here and not later. subscribeReadStream's set()
    // runs the prior teardown on this key, which would take the phone's
    // list-only feed down, and nothing after it can put that back.
    //
    // Three rungs, each verified with the exact check: the history scaled down
    // by how far the frame overshot, then the grid alone, then no seed at all.
    // The grid is always whole at the first two, so a shorter seed is a shorter
    // history and never a broken screen. The empty seed cannot overflow, since
    // the rest of the payload is a few hundred bytes. Each re-take is its own
    // snapshot with its own barrier, and the barrier of the frame that is sent
    // is the one subscribeReadStream filters the tap by. The seed tap and the
    // capture listener stay up across every rung, so nothing is lost between
    // snapshots. The empty seed keeps the last snapshot's barrier.
    let encodeFailure = wantsTerminal ? encodeMessageFailure(built.response) : null;
    if (encodeFailure !== null) {
      const shrinkStartedAt = performance.now();
      const originalChars = scrollback.length;
      const scaledLines = scaledSeedHistoryLines(built.response);
      const historyRungs = scaledLines > 0 ? [scaledLines, 0] : [0];
      let heldRung: string | null = null;
      for (const historyLines of historyRungs) {
        const retake = await context.sessionManager.getSeedFrame(payload.sessionId, historyLines);
        scrollback = retake.frame;
        latestTakenFrame = retake.frame;
        seedCoverage = { barrierOffset: retake.barrierOffset, racedChunks };
        built = buildResponse();
        if (!built) return sessionGone();
        encodeFailure = encodeMessageFailure(built.response);
        if (encodeFailure === null) {
          // A re-take comes back empty when the session's buffer went away
          // during it, so the label says what was sent, not what was asked.
          if (scrollback === '') heldRung = 'sent an empty seed';
          else if (historyLines === 0) heldRung = 'sent the grid alone';
          else heldRung = `sent ${historyLines} history lines`;
          break;
        }
      }
      if (encodeFailure !== null) {
        scrollback = '';
        built = buildResponse();
        if (!built) return sessionGone();
        heldRung = 'sent an empty seed';
      }
      noteRequestSpan(session.deviceId, request.requestId, `seed shrink ${Math.round(performance.now() - shrinkStartedAt)} ms`);
      console.warn(
        `[mobile-bridge] read-stream/subscribe ${request.requestId} from ${session.deviceId.slice(0, 8)} shrank its terminal seed to fit the wire: ${Math.round(originalChars / 1024)}k chars to ${Math.round(scrollback.length / 1024)}k chars (${heldRung})`,
      );
    }

    subscribeReadStream(payload.sessionId, built.snapshotSession, built.resumable, built.awaitedPromptId, session, context, subscriptions, wantsTerminal, seedCoverage);
    subscribed = true;
    return built.response;
  } finally {
    // Every exit, a throw included, lets go of the seed capture. On success
    // this runs after subscribeReadStream took its own tap, so the host never
    // sees the session untapped in between. Only a terminal subscribe that
    // did not complete drops the marker, and only one it added: on success
    // subscribeReadStream has re-registered that key for the live stream.
    context.sessionManager.off('data-tap', captureRacedChunk);
    releaseSeedTap?.();
    if (wantsTerminal && !subscribed && !terminalMarkerAlreadyHeld) subscriptions.remove(terminalStreamKeyFor(payload.sessionId));
  }
}

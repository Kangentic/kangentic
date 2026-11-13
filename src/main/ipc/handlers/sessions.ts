import { noteLaunchNotSignedIn } from '../../accounts/account-service';
import { ipcMain, MessageChannelMain, webContents } from 'electron';
import { IPC } from '../../../shared/ipc-channels';
import { withTaskLock } from '../task-lifecycle-lock';
import { supersedeMessageDeliveries } from '../../automations/turn-end/turn-end-passes';
import { isUnderWorkflowRecovery } from '../../workflows/workflow-recovery-state';
import { SessionRepository } from '../../db/repositories/session-repository';
import { resolveOwnSessionRecord } from '../../db/repositories/session-own-record';
import { retrievalClient } from '../../retrieval/retrieval-client';
import { collectRemoteTargets } from '../../retrieval/remote-targets';
import { UsageHistoryRepository } from '../../db/repositories/usage-history-repository';
import { TaskRepository } from '../../db/repositories/task-repository';
import { getProjectDb } from '../../db/database';
import { getProjectRepos, notifySpawnBlocked } from '../helpers';
import { isUserSetupFailureClass, lineTooLongSentence, reportPtyPortFailure } from '../../pty/agent-launch-report';
import { linkPR, autoLinkPRForTask, recordPushedBranchForSession } from '../../pr/pr-linking';
import { listTaskPrChecks, sendFailedPrChecks } from '../../pr/failed-checks-delivery';
import { planExitTargetFor } from '../helpers/plan-exit-target';
import { markResumeMiss } from '../helpers/resume-miss';
import { readTaskLastMessage, readTaskReport, readTaskRoute } from '../helpers/task-report';
import { announceTaskWrite } from '../helpers/task-write-announce';
import { handleTaskMove } from './task-move';
import { trackEvent } from '../../analytics/analytics';
import { trackFeatureUsed, trackMilestone } from '../../analytics/usage';
import { parseModelId } from '../../../shared/model-id';
import { requiresUserInteraction } from '../../../shared/activity-state';
import { isCommandTerminalSession } from '../../../shared/session-owner';
import { captureSessionMetrics, readTranscriptToolResultTokens, refineTranscriptTokens, refineTranscriptToolCounts } from './session-metrics';
import { captureGitChurn, resolveDefaultBaseBranch } from './git-stats-capture';
import { markRecordExited, markRecordSuspended, promoteRecord, recoverStaleSessionId } from '../../transition-engine/session-lifecycle';
import { isShuttingDown } from '../../shutdown-state';
import { reconcileTaskSessionRef } from './session-reconcile';
import { persistPtyGrid } from './session-grid-persistence';
import { forgetTranscriptPath, persistTranscriptPath } from './session-transcript-path';
import { abortInFlightResume, isResumeInFlight, registerResumeController, releaseResumeController } from './session-resume-controllers';
import { resumeTaskSession } from './session-resume';
import { resumeTaskOnOpen } from './session-resume-on-open';
import { pauseTaskSession } from './session-pause';
import { startParkedStop } from '../../stop-script/parked-stop-service';
import { isSessionInOwnCall } from './own-call-turn-wait';
import type { ActivityReason, ActivityState, AssistantMessageTrailEntry, PtyResizeOrigin, Session, StartBlockedReason, TaskResolvePrResult, PRChecks, PrChecksSendResult } from '../../../shared/types';
import type { AgentStartRefusedError } from '../../pty/spawn/pty-spawn';
import { agentRegistry } from '../../agent/agent-registry';
import { parseStoredCliTarget } from '../../agent/shared/cli-target';
import { resolveExecutionTarget } from '../../agent/shared/execution-target';
import { presentLinkPaths, revealLinkPath } from '../../terminal-links/link-path-service';
import type { SessionLinkFacts } from '../../terminal-links/resolve-link-path';
import { MessageTrailTracker } from '../../agent/message-trail-tracker';
import { registerArtifactDetection } from '../../artifacts/artifact-detection';
import type { IpcContext } from '../ipc-context';
import { broadcast } from '../../pop-out/window-broadcast';
import { EMPTY_QUEUE_SNAPSHOT, readQueueSnapshot } from '../helpers/queue-snapshot';
import { RefusalError } from '../../../shared/refusal';
import { createChokepointReporter } from '../../analytics/handled-report';

/**
 * The session handlers' background work that only logged: an idle-timeout pause,
 * the pause after a failed or refused launch, the plan-exit auto-move. The
 * `stage` tag says which.
 */
const sessionHandlersReporter = createChokepointReporter('session_handlers');

/** How long a change to the line for an agent slot waits for the rest of its burst. */
const QUEUE_PUSH_COALESCE_MS = 100;

// Track session start times for duration calculation on exit
const sessionStartTimes = new Map<string, number>();

// Track which session ids have already fired the `session_spawn` analytics
// event so we never double-fire if `session-changed` re-emits running for the
// same id. Cleared on exit alongside `sessionStartTimes`.
const sessionSpawnAnalyticsFired = new Set<string>();

/**
 * The reason a renderer gets with an activity push. An idle that ends the turn
 * in which the session moved its own task or paused its own workflow, while
 * that call is still taking effect, is flagged `inOwnCall`, so the renderer
 * raises no "waiting on you" toast and moves no focus for it. That turn belongs
 * to the column the task left or to a paused workflow. Most such calls end the
 * session moments later. A move that keeps it is flagged as well: the move's
 * own toast already says where the task went.
 */
export function markOwnCallIdle(sessionId: string, state: ActivityState, reason: ActivityReason): ActivityReason {
  // activity-state-ok: granular, only a finished turn is flagged; a permission
  // prompt still needs the user.
  if (state !== 'idle' || reason.kind !== 'idle' || !isSessionInOwnCall(sessionId)) return reason;
  return { ...reason, inOwnCall: true };
}

/**
 * What the link resolver reads about a session, or null for one it should not
 * guess at. A project this session's agent runs on a remote server counts as
 * remote when its config cannot be read, so a failure links nothing.
 */
export function sessionLinkFacts(context: IpcContext, sessionId: string): SessionLinkFacts | null {
  const session = context.sessionManager.getSessionPathContext(sessionId);
  if (!session) return null;
  const projectPath = context.projectRepo.getById(session.projectId)?.path;
  const agentName = context.sessionManager.getSessionAgentName(sessionId);
  let runsOnRemoteServer = false;
  if (agentName) {
    try {
      const config = context.configManager.getEffectiveConfig(projectPath ?? undefined);
      runsOnRemoteServer = resolveExecutionTarget(agentName, config.agent.executionServers, config.agent.execution) !== null;
    } catch {
      runsOnRemoteServer = true;
    }
  }
  return { shell: session.shell, commandCwd: session.commandCwd, cliTarget: session.cliTarget, runsOnRemoteServer };
}

export function registerSessionHandlers(context: IpcContext): void {
  // === Sessions ===
  ipcMain.handle(IPC.SESSION_SPAWN, (_, input, projectId?: string | null) => {
    const resolvedProjectId = projectId ?? context.currentProjectId;
    if (!resolvedProjectId) throw new RefusalError('Cannot spawn session: no project is currently open');
    // Set after the spread: the renderer never names a start path, and never
    // supplies the resume check's evidence, which only a spawn chokepoint reads.
    return context.sessionManager.spawn({ ...input, projectId: resolvedProjectId, startPath: 'board', resumeEvidence: null });
  });
  ipcMain.handle(IPC.SESSION_KILL, (_, id) => {
    // Serialize against suspend/resume/reset for the same task so KILL can't
    // race with an in-flight grace-window suspend or worktree-bound resume.
    // If the session is unknown to the manager (already gone), fall through
    // to the bare kill which is a no-op.
    const taskId = context.sessionManager.getSessionTaskId(id);
    if (!taskId) return context.sessionManager.kill(id);
    return withTaskLock(taskId, async () => context.sessionManager.kill(id));
  });
  // A renderer's keystrokes, output and drain acks do not come through here:
  // each renderer has its own port to the pty host (PTY_PORT_REQUEST below),
  // so typing never waits on this process's event loop. The host tags those
  // keystrokes 'user' for the prompt-draft ledger.
  ipcMain.handle(IPC.SESSION_RESIZE, (_, id, cols, rows) => context.sessionManager.resize(id, cols, rows));
  ipcMain.handle(IPC.SESSION_RESET_TERMINAL, (_, id: string) => context.sessionManager.resetTerminal(id));
  ipcMain.handle(IPC.SESSION_OPEN_HISTORY_VIEW, (_, id: string) => context.sessionManager.openHistoryView(id));
  ipcMain.handle(IPC.SESSION_CLOSE_HISTORY_VIEW, (_, id: string) => context.sessionManager.closeHistoryView(id));
  ipcMain.handle(IPC.SESSION_LIST, () => context.sessionManager.listSessions());
  ipcMain.handle(IPC.SESSION_RESOLVE_LINK_PATHS, (_, sessionId: string, printedPaths: string[]) => {
    const facts = sessionLinkFacts(context, sessionId);
    return facts ? presentLinkPaths(printedPaths, facts) : printedPaths.map(() => false);
  });
  ipcMain.handle(IPC.SESSION_REVEAL_LINK_PATH, (_, sessionId: string, printedPath: string) => {
    const facts = sessionLinkFacts(context, sessionId);
    return facts ? revealLinkPath(printedPath, facts) : false;
  });
  // Targeted self-heal probe: returns the live registry session for a task
  // (or null) and clears any stale task.session_id pointer on the DB row.
  // Used by the task detail dialog to reconcile a 'suspended' renderer view
  // before committing to the resume branch. Cheaper than SESSION_LIST and
  // does not spawn anything (unlike SESSION_RESUME's self-heal). No
  // withTaskLock: this is a read-mostly probe and contention with concurrent
  // suspend/resume is acceptable.
  ipcMain.handle(IPC.SESSION_RECONCILE, (_, taskId: string, projectId?: string | null): Session | null => {
    const resolvedProjectId = projectId ?? context.currentProjectId;
    if (!resolvedProjectId) return null;
    const { liveSession } = reconcileTaskSessionRef(context, resolvedProjectId, taskId);
    return liveSession;
  });
  // A renderer names a request id: the host answers on that renderer's port,
  // after the output flushed before the sample (getScrollbackForRenderer).
  // The request itself still comes through here, behind the resize the same
  // renderer sent first, which this process applies before it asks the host.
  ipcMain.handle(IPC.SESSION_GET_SCROLLBACK, (event, id: string, requestId?: number) =>
    typeof requestId === 'number'
      ? context.sessionManager.getScrollbackForRenderer(id, event.sender.id, requestId)
      : context.sessionManager.getScrollback(id));
  // Unscoped map of sessionId -> true for sessions that have emitted first
  // output. Lets syncSessions rebuild `sessionFirstOutput` after an HMR reload
  // (renderer state resets to {}) so a running session isn't flashed back to
  // its "Starting agent..." boot state.
  ipcMain.handle(IPC.SESSION_GET_FIRST_OUTPUT, () => context.sessionManager.getFirstOutputCache());
  ipcMain.handle(IPC.SESSION_GET_USAGE, (_, projectId?: string) =>
    projectId ? context.sessionManager.getUsageCacheForProject(projectId) : context.sessionManager.getUsageCache());
  ipcMain.handle(IPC.SESSION_GET_ACTIVITY, (_, projectId?: string) =>
    projectId ? context.sessionManager.getActivityCacheForProject(projectId) : context.sessionManager.getActivityCache());
  ipcMain.handle(IPC.SESSION_GET_ACTIVITY_REASON, (_, sessionId: string) => context.sessionManager.getActivityReason(sessionId));
  ipcMain.handle(IPC.SESSION_GET_ACTIVITY_REASONS, (_, projectId?: string) =>
    projectId
      ? context.sessionManager.getActivityReasonsCacheForProject(projectId)
      : context.sessionManager.getActivityReasonsCache());
  ipcMain.handle(IPC.SESSION_GET_ACTIVITY_STATS, (_, sessionId: string) => context.sessionManager.getActivityStatsSnapshot(sessionId));
  ipcMain.handle(IPC.SESSION_GET_EVENTS, (_, sessionId: string) => context.sessionManager.getEventsForSession(sessionId));
  ipcMain.handle(IPC.SESSION_GET_EVENTS_CACHE, (_, projectId?: string) =>
    projectId ? context.sessionManager.getEventsCacheForProject(projectId) : context.sessionManager.getEventsCache());

  // === Session Suspend / Resume ===
  // The Pause button. The whole path lives in pauseTaskSession
  // (session-pause.ts), shared with the phone's pause-session verb and with
  // Pause workflow, so the three cannot drift. A task with no live session is
  // a silent no-op here, as it always was.
  ipcMain.handle(IPC.SESSION_SUSPEND, async (_, taskId: string, projectId?: string | null): Promise<void> => {
    await pauseTaskSession(context, taskId, { projectId });
  });

  // The Resume button. The whole path lives in resumeTaskSession
  // (session-resume.ts), shared with the phone's start-session verb for a
  // paused task and with Resume workflow, so the three cannot drift.
  ipcMain.handle(IPC.SESSION_RESUME, (_, taskId: string, resumePrompt?: string, projectId?: string | null) =>
    resumeTaskSession(context, taskId, { projectId, resumePrompt }));

  // The user opened a task. Main decides whether that resumes it. The renderer
  // hears the outcome by push, so the invoke resolves with nothing.
  ipcMain.handle(IPC.SESSION_RESUME_ON_OPEN, async (_, taskId: string, projectId?: string | null): Promise<void> => {
    await resumeTaskOnOpen(context, taskId, projectId);
  });

  registerSessionRecoveryHandlers(context);
}

/** Reset, reconcile, and the session listeners: the rest of the session handlers. */
function registerSessionRecoveryHandlers(context: IpcContext): void {
  /** Renderers whose focus-set teardown is already wired, so repeated
   *  SESSION_SET_FOCUSED calls do not stack duplicate listeners. */
  const focusTeardownWatched = new Set<number>();

  // === Session Reset (safety-net recovery for unrecoverable sessions) ===
  ipcMain.handle(IPC.SESSION_RESET, (_, taskId: string, projectId?: string | null) => {
    // Cancel any in-flight resume BEFORE queueing on the lock - otherwise
    // we would deadlock waiting for a resume that is stuck in worktree I/O.
    abortInFlightResume(taskId);

    return withTaskLock(taskId, async () => {
      const resolvedProjectId = projectId ?? context.currentProjectId;
      if (!resolvedProjectId) throw new RefusalError('No project is currently open');

      const { tasks } = getProjectRepos(context, resolvedProjectId);
      const task = tasks.getById(taskId);
      if (!task) throw new RefusalError(`Task ${taskId} not found`);

      // Kill PTY if running
      if (task.session_id) {
        context.sessionManager.kill(task.session_id);
      }
      // Also remove any PTY registered by taskId (covers ghost sessions
      // that were never written to the task record)
      context.sessionManager.removeByTaskId(taskId);

      // Atomically mark latest session record as exited in DB
      const db = getProjectDb(resolvedProjectId);
      const sessionRepo = new SessionRepository(db);
      const latest = sessionRepo.getLatestForTask(taskId);
      if (latest) {
        markRecordExited(sessionRepo, latest.id);
      }

      // Clear task's session reference
      tasks.update({ id: taskId, session_id: null });
    });
  });

  // === Session Summaries ===
  ipcMain.handle(IPC.SESSION_GET_SUMMARY, (_, taskId: string) => {
    if (!context.currentProjectId) return null;
    const db = getProjectDb(context.currentProjectId);
    const sessionRepo = new SessionRepository(db);
    return sessionRepo.getSummaryForTask(taskId);
  });

  // Read in the retrieval worker: aggregating every session row took 66 to
  // 71 ms on a long history.
  ipcMain.handle(IPC.SESSION_LIST_SUMMARIES, async () => {
    if (!context.currentProjectId) return {};
    return retrievalClient.call('sessions.summaries', { projectId: context.currentProjectId });
  });

  // The completed task view's report and its last message. Both take the
  // project explicitly: the view can be hosted for another project's task.
  ipcMain.handle(IPC.SESSION_GET_TASK_REPORT, (_, projectId: string, taskId: string) => readTaskReport(context, projectId, taskId));
  ipcMain.handle(IPC.SESSION_GET_TASK_ROUTE, (_, projectId: string, taskId: string) => readTaskRoute(context, projectId, taskId));
  ipcMain.handle(IPC.SESSION_GET_TASK_LAST_MESSAGE, (_, projectId: string, taskId: string) => readTaskLastMessage(projectId, taskId));

  // Per-tool breakdown for an active session's track: its earlier runs' stored
  // rows (one indexed read of the session's records) merged with the live
  // accumulator, which works mid-session and survives the bounded event cache.
  ipcMain.handle(IPC.SESSION_GET_TOOL_BREAKDOWN, (_, sessionId: string) => {
    return context.sessionManager.refreshToolBreakdownAcrossRuns(sessionId);
  });

  // The per-tool result-token estimates for the session's track: the earlier
  // runs' (filled from their transcripts where a record has none) plus the live
  // run's, which the live accumulator cannot have (hook events carry no token
  // data). A separate read so the breakdown above stays instant while the
  // transcripts are read in the retrieval worker. The session's own project
  // resolves its records.
  ipcMain.handle(IPC.SESSION_GET_TOOL_RESULT_TOKENS, (_, sessionId: string) => {
    const projectId = context.sessionManager.getSessionProjectId(sessionId);
    const sessionRepo = projectId ? new SessionRepository(getProjectDb(projectId)) : null;
    return readTranscriptToolResultTokens(context.sessionManager, sessionRepo, sessionId);
  });

  // Set which sessions are visible in the renderer (terminal panel + command bar overlay).
  // Background sessions stop emitting data IPC (accumulate in scrollback only).
  /**
   * A renderer that goes away must not keep sessions pinned as focused (main
   * keeps emitting their data to a window that no longer exists) nor as
   * mounted (main would keep treating their grids as held). One watcher per
   * renderer clears both sets.
   */
  const watchRendererTeardown = (sender: Electron.WebContents): void => {
    if (focusTeardownWatched.has(sender.id)) return;
    focusTeardownWatched.add(sender.id);
    // The id is read now: a destroyed webContents no longer answers for it.
    const rendererId = sender.id;
    const forget = (): void => {
      // Both go, so a renderer that crashes and reloads again and again does
      // not gather one `destroyed` listener per crash.
      sender.removeListener('destroyed', forget);
      sender.removeListener('render-process-gone', forget);
      context.sessionManager.clearFocusedSessionsFor(rendererId);
      context.sessionManager.detachRendererPort(rendererId);
      focusTeardownWatched.delete(rendererId);
    };
    sender.once('destroyed', forget);
    sender.once('render-process-gone', forget);
  };

  /**
   * Give a renderer its own port to the pty host: one end of a
   * `MessageChannelMain` to the host, the other to the renderer's preload. Its
   * keystrokes go to the host and its terminals' output comes back on it, so
   * typing never waits on this process's event loop (a git start, a database
   * write, a burst of IPC). This process brokers the pair and never relays.
   */
  const issueRendererPort = (target: Electron.WebContents): void => {
    if (target.isDestroyed()) return;
    const { port1, port2 } = new MessageChannelMain();
    // The renderer's end goes first: a frame torn down between the check and
    // the post throws here, and the host is then never handed an end nobody
    // holds. Caught so a host restart's loop still reaches every other renderer.
    try {
      target.postMessage(IPC.PTY_PORT, null, [port2]);
    } catch (error) {
      console.warn(`[pty-port] could not hand renderer ${target.id} its port:`, error instanceof Error ? error.message : String(error));
      port1.close();
      // A window going away is the expected case here. One still open is left
      // with terminals that show history and take no keystroke.
      if (!target.isDestroyed()) reportPtyPortFailure();
      return;
    }
    context.sessionManager.attachRendererPort(target.id, port1);
    watchRendererTeardown(target);
  };
  // A preload asks once per page load (a reload asks again).
  ipcMain.on(IPC.PTY_PORT_REQUEST, (event) => issueRendererPort(event.sender));
  // A restarted host has none of the old ports: every renderer gets a new one,
  // before the manager replays what each renderer shows.
  context.sessionManager.on('renderer-ports-lost', (rendererIds: number[]) => {
    for (const rendererId of rendererIds) {
      const target = webContents.fromId(rendererId);
      if (target) issueRendererPort(target);
    }
  });

  ipcMain.handle(IPC.SESSION_SET_FOCUSED, (event, sessionIds: string[]) => {
    // Keyed by the SENDING renderer: the detached Agent Monitor publishes its own
    // visible set, and a single shared set would have the two clobber each other.
    context.sessionManager.setFocusedSessions(sessionIds, event.sender.id);
    watchRendererTeardown(event.sender);
    // Immediately flush any buffered usage/events so the newly focused
    // sessions' data is up-to-date without waiting for the 2s timer.
    flushBackgroundBuffer();
  });

  // Set which sessions this renderer has an xterm MOUNTED for. Broader than
  // the focused set: a parked terminal is unfocused but still holds a grid,
  // and main must not reshape a PTY something is still rendering at its own
  // size (xterm re-sends dimensions only when its OWN size changes, so the
  // mismatch would have no path back).
  ipcMain.handle(IPC.SESSION_SET_MOUNTED, (event, sessionIds: string[]) => {
    context.sessionManager.setMountedSessions(sessionIds, event.sender.id);
    watchRendererTeardown(event.sender);
  });

  // User pressed Ctrl+C in the terminal. Renderer already sent \x03 to
  // the PTY directly; this is a parallel signal so the activity engine
  // can recover quickly when the agent's hooks don't fire.
  ipcMain.handle(IPC.SESSION_NOTIFY_USER_INTERRUPT, (_, sessionId: string) => {
    context.sessionManager.signalUserInterrupt(sessionId);
  });

  // === Background IPC Buffering ===
  // Buffer usage and event IPC for non-focused sessions, flushing every 2 seconds.
  // This reduces IPC churn from O(N*freq) to O(1*freq) + trickle.
  // Activity state is NEVER buffered (drives board card states, sidebar badges, notifications).
  const BACKGROUND_FLUSH_MS = 2000;
  const bufferedUsage = new Map<string, { data: unknown; projectId: string | undefined }>();
  const bufferedEvents: Array<{ sessionId: string; event: unknown; projectId: string | undefined }> = [];
  let backgroundFlushTimer: ReturnType<typeof setTimeout> | null = null;

  function isFocusedSession(sessionId: string): boolean {
    // Default-closed, matching SessionManager's focused-set contract: an empty
    // set means NO session is focused (Backlog view, hidden panel, pre-first-
    // push startup), so usage/events buffer instead of broadcasting per-emit.
    return context.sessionManager.getFocusedSessions().has(sessionId);
  }

  function scheduleBackgroundFlush(): void {
    if (backgroundFlushTimer) return;
    backgroundFlushTimer = setTimeout(flushBackgroundBuffer, BACKGROUND_FLUSH_MS);
  }

  function flushBackgroundBuffer(): void {
    backgroundFlushTimer = null;
    if (context.mainWindow.isDestroyed()) return;

    // Flush buffered usage (last-write-wins per session)
    for (const [sessionId, { data, projectId }] of bufferedUsage) {
      broadcast(context.mainWindow, IPC.SESSION_USAGE, sessionId, data, projectId);
    }
    bufferedUsage.clear();

    // Flush buffered events (in order)
    for (const entry of bufferedEvents) {
      context.mainWindow.webContents.send(IPC.SESSION_EVENT, entry.sessionId, entry.event, entry.projectId);
    }
    bufferedEvents.length = 0;
  }

  // Forward PTY events to renderer (guard against destroyed window during shutdown)
  // Each event includes the session's projectId so the renderer can filter by project.
  // A terminal's output is not among them: the pty host sends it to each
  // renderer that shows the session, on that renderer's own port.

  // Fires only when the PTY's dims actually changed (SessionManager.resize
  // short-circuits no-ops before the emit). Broadcast rather than focus-routed:
  // the mounted owner xterm this echo exists for can be mid-mount (registered
  // in the mounted set only a microtask later), and a missed echo during that
  // window is exactly the divergence with no recovery path. Echoes are rare,
  // so fanning a few no-op sends is the cheaper failure mode.
  context.sessionManager.on(
    'pty-resize',
    (sessionId: string, cols: number, rows: number, origin: PtyResizeOrigin = 'desktop') => {
      if (context.mainWindow.isDestroyed()) return;
      broadcast(context.mainWindow, IPC.SESSION_PTY_RESIZED, sessionId, cols, rows, origin);
    },
  );

  // Persist every grid change to the session record, so a resume after a
  // desktop restart or a pty host crash spawns at the grid the session last had
  // (SpawnSessionInput.restoredGrid). Writing at each change, not at suspend,
  // also covers an OS kill and keeps the synchronous quit path untouched.
  context.sessionManager.on(
    'pty-resize',
    (sessionId: string, cols: number, rows: number, origin: PtyResizeOrigin = 'desktop') => {
      persistPtyGrid(context, sessionId, { cols, rows }, origin);
    },
  );

  // Broadcast to the main window and every pop-out that declares the channel,
  // not focus-routed: it is the only thing that lifts a terminal's launch
  // overlay, and it fires once per session. A window that was not focused on
  // the session when its agent came up (a pop-out held the focus, then closed)
  // would otherwise keep that overlay until a resync.
  context.sessionManager.on('first-output', (sessionId: string) => {
    if (context.mainWindow.isDestroyed()) return;
    const projectId = context.sessionManager.getSessionProjectId(sessionId);
    broadcast(context.mainWindow, IPC.SESSION_FIRST_OUTPUT, sessionId, projectId);
  });

  context.sessionManager.on('usage', (sessionId: string, data: unknown) => {
    // Before the window check: the record needs the path whether or not a
    // window is there to show the usage.
    persistTranscriptPath(context, sessionId, data);
    if (context.mainWindow.isDestroyed()) return;
    const projectId = context.sessionManager.getSessionProjectId(sessionId);
    if (isFocusedSession(sessionId)) {
      broadcast(context.mainWindow, IPC.SESSION_USAGE, sessionId, data, projectId);
    } else {
      // Buffer for background sessions (last-write-wins)
      bufferedUsage.set(sessionId, { data, projectId });
      scheduleBackgroundFlush();
    }
  });

  // A reason-only refresh rides the SAME channel a real transition does: the
  // renderer's reducer stores state and reason together, and the state it
  // re-sends is the unchanged current one, so a second channel would only
  // duplicate that reducer. It is a separate EMITTER, though: the other nine
  // listeners on 'activity' read that event as "the state changed", and several
  // act on it (push notifications, desktop toasts, auto-move on turn
  // completion). See the emit site in `session-manager.ts`.
  context.sessionManager.on(
    'activity-reason',
    (sessionId: string, state: string, reason: unknown) => {
      if (context.mainWindow.isDestroyed()) return;
      const projectId = context.sessionManager.getSessionProjectId(sessionId);
      const taskId = context.sessionManager.getSessionTaskId(sessionId);
      broadcast(context.mainWindow, IPC.SESSION_ACTIVITY, sessionId, state, reason, projectId, taskId);
    },
  );

  context.sessionManager.on('activity', (sessionId: string, state: ActivityState, reason: ActivityReason) => {
    if (!context.mainWindow.isDestroyed()) {
      const projectId = context.sessionManager.getSessionProjectId(sessionId);
      const taskId = context.sessionManager.getSessionTaskId(sessionId);
      broadcast(context.mainWindow, IPC.SESSION_ACTIVITY, sessionId, state, markOwnCallIdle(sessionId, state, reason), projectId, taskId);

      // A session going idle (the agent finished its turn) is the catch-all
      // signal that a PR may have just been created mid-session - the move-time
      // resolve fired before the PR existed, and the gh-command sniffer
      // (`pr-candidate`) misses a PR opened any other way. Re-resolve now so the
      // card links within seconds instead of waiting for the periodic sweep.
      // NON-force via autoLinkPRForTask, so the 60s per-task throttle coalesces
      // the repeated idles a long session emits. Skip transient (Command
      // Terminal) sessions: their synthetic taskId is not a real task row.
      //
      // Deliberately the granular 'idle' state only (turn complete), NOT the
      // idle-vs-active bucket: a 'permission' pause is mid-turn, so it did not
      // just create a PR. Check the literal first so the per-event getSession
      // registry lookup is skipped on the far-more-frequent 'thinking' events.
      // activity-state-ok: granular turn-completion check, not an idle/active bucket.
      if (state === 'idle' && taskId && projectId) {
        const session = context.sessionManager.getSession(sessionId);
        if (session && !session.transient) {
          autoLinkPRForTask(context, taskId, projectId);
        }
      }
    }
  });

  context.sessionManager.on('event', (sessionId: string, event: unknown) => {
    if (context.mainWindow.isDestroyed()) return;
    const projectId = context.sessionManager.getSessionProjectId(sessionId);
    if (isFocusedSession(sessionId)) {
      context.mainWindow.webContents.send(IPC.SESSION_EVENT, sessionId, event, projectId);
    } else {
      bufferedEvents.push({ sessionId, event, projectId });
      scheduleBackgroundFlush();
    }
  });

  // Board-card agent message trail. The tracker subscribes to the session
  // manager itself and reads a bounded transcript tail on the events above; it
  // is NOT buffered like usage/events, because it already coalesces at the
  // source and a background card is exactly where the trail is looked at.
  const messageTrailTracker = new MessageTrailTracker({
    sessionManager: context.sessionManager,
    resolveSessionFacts: (sessionId, projectId) => {
      try {
        const record = new SessionRepository(getProjectDb(projectId)).findByAnyId(sessionId);
        if (!record) return null;
        return {
          sessionType: record.session_type,
          agentSessionId: record.agent_session_id,
          cwd: record.cwd,
          cliTarget: parseStoredCliTarget(record.cli_target),
          transcriptPath: record.transcript_path,
        };
      } catch {
        return null;
      }
    },
    // Parsed in the retrieval worker: main reads no transcript.
    readTrail: (facts, cursor) => retrievalClient.call(
      'transcript.trailRead',
      { facts, cursor, remoteTargets: collectRemoteTargets(agentRegistry) },
    ),
  });
  messageTrailTracker.on('trail', (sessionId: string, entries: AssistantMessageTrailEntry[], projectId: string) => {
    if (context.mainWindow.isDestroyed()) return;
    broadcast(context.mainWindow, IPC.SESSION_MESSAGE_TRAIL, sessionId, entries, projectId);
  });
  ipcMain.handle(IPC.SESSION_GET_MESSAGE_TRAILS, () => messageTrailTracker.snapshot());

  // A task's artifacts, found without anyone asking: an agent's publish, the
  // links in its messages, and a terminal's for an agent with no transcript.
  registerArtifactDetection(context, messageTrailTracker);

  context.sessionManager.on('session-changed', (sessionId: string, session: Session) => {
    if (session.status === 'running') {
      // Stamped once, on the first running emit. 'session-changed' also fires
      // for a running session whose status did not change (an agent session id
      // captured, a Command Terminal named), and re-stamping there would
      // restart the exit's duration mid-session. Session ids are minted once
      // per spawn and the exit below clears the entry, so this is the
      // transition into running.
      if (!sessionStartTimes.has(sessionId)) sessionStartTimes.set(sessionId, Date.now());

      // Analytics: track spawn intent on the first running transition. Model
      // is not known yet (arrives later via status.json) and is omitted here -
      // session_exit / task_complete carry the model. permissionMode (the
      // resolved mode the session spawned under, not the task's raw override)
      // and worktree ride the same event as budget-neutral props.
      // permissionMode is read off the session itself: this event fires
      // inside spawn(), before the caller inserts the session's record, so a
      // record read here found the task's PREVIOUS record, whose mode can be
      // stale or belong to the task's other track (a main and an isolated
      // session).
      // This listener sees EVERY spawn path (board move, create, recovery,
      // transient), which also makes it the one chokepoint for the
      // worktree/profile adoption signals and the first_spawn milestone.
      if (!sessionSpawnAnalyticsFired.has(sessionId)) {
        sessionSpawnAnalyticsFired.add(sessionId);
        const spawnAgentName = context.sessionManager.getSessionAgentName(sessionId);
        if (spawnAgentName) {
          const spawnProps: Record<string, string | number | boolean> = {
            agent: spawnAgentName,
            isTransient: !!session.transient,
          };
          const spawnPermissionMode = context.sessionManager.getSessionPermissionMode(sessionId);
          if (spawnPermissionMode) spawnProps.permissionMode = spawnPermissionMode;
          try {
            const spawnProjectId = context.sessionManager.getSessionProjectId(sessionId);
            // Not during shutdown: getProjectDb silently REOPENS a just-closed
            // project DB (close deletes the cache entry, so the next call
            // constructs a fresh connection nothing ever closes again).
            if (!isShuttingDown() && spawnProjectId && session.taskId) {
              const database = getProjectDb(spawnProjectId);
              const taskRow = new TaskRepository(database).getById(session.taskId);
              if (taskRow) {
                spawnProps.worktree = !!taskRow.worktree_path;
                if (taskRow.worktree_path) trackFeatureUsed('worktree_session');
                if (taskRow.profile_id) trackFeatureUsed('board_profile');
              }
            }
          } catch {
            // Enrichment is best-effort; the base props still send
          }
          trackEvent('session_spawn', spawnProps);
          if (!session.transient) trackMilestone('first_spawn');
        }
      }

      // Atomically promote DB record from 'queued' to 'running'
      const resolvedProjectId = context.sessionManager.getSessionProjectId(sessionId);
      if (resolvedProjectId) {
        try {
          const database = getProjectDb(resolvedProjectId);
          const sessionRepo = new SessionRepository(database);
          const managedSession = context.sessionManager.getSession(sessionId);
          if (managedSession) {
            const record = resolveOwnSessionRecord(sessionRepo, sessionId, managedSession.taskId);
            if (record) {
              promoteRecord(sessionRepo, record.id);
            }
          }
        } catch {
          // DB may be closed during shutdown
        }
      }
    }
    if (!context.mainWindow.isDestroyed()) {
      broadcast(context.mainWindow, IPC.SESSION_STATUS, sessionId, session, session.projectId);
    }
  });

  // A session left the registry for good (SessionManager.remove()). Its own
  // channel, never SESSION_STATUS: the renderer's status handler can only
  // upsert, so a removal announced there re-seeded the row it was reporting
  // gone (#661). The renderer drops the row and its per-session maps by id.
  context.sessionManager.on('session-removed', (sessionId: string, session: Session) => {
    // Drop anything this session left in the background buffers above. A
    // non-focused session's usage and events are held here for up to
    // BACKGROUND_FLUSH_MS, so without this the timer fires AFTER the removal
    // and broadcasts a usage tick for a session the renderer has already
    // dropped, writing `sessionUsage[id]` back under a row that no longer
    // exists. That is the stale context bar of #661 arriving two seconds late,
    // and no amount of renderer-side scrubbing can prevent it: the push is
    // legitimate as far as the renderer can tell. Purging at the source also
    // covers every other consumer of the channel, not just the board store.
    bufferedUsage.delete(sessionId);
    forgetTranscriptPath(sessionId);
    for (let eventIndex = bufferedEvents.length - 1; eventIndex >= 0; eventIndex--) {
      if (bufferedEvents[eventIndex].sessionId === sessionId) bufferedEvents.splice(eventIndex, 1);
    }
    if (!context.mainWindow.isDestroyed()) {
      broadcast(context.mainWindow, IPC.SESSION_REMOVED, sessionId, session, session.projectId);
    }
  });

  // Who is waiting for a slot and why. Coalesced, because a promotion changes
  // several rows at once, and sent only when the line changed, so a board with
  // nothing queued pushes nothing.
  ipcMain.handle(IPC.SESSION_QUEUE_SNAPSHOT, () => readQueueSnapshot(context));
  let lastQueuePush = JSON.stringify(EMPTY_QUEUE_SNAPSHOT);
  let queuePushTimer: NodeJS.Timeout | null = null;
  const scheduleQueuePush = (): void => {
    if (queuePushTimer) return;
    queuePushTimer = setTimeout(() => {
      queuePushTimer = null;
      if (isShuttingDown() || context.mainWindow.isDestroyed()) return;
      try {
        const snapshot = readQueueSnapshot(context);
        const serialized = JSON.stringify(snapshot);
        if (serialized === lastQueuePush) return;
        lastQueuePush = serialized;
        broadcast(context.mainWindow, IPC.SESSION_QUEUE_CHANGED, snapshot);
      } catch (error) {
        console.warn('[SESSION] Could not read the agent queue:', error);
      }
    }, QUEUE_PUSH_COALESCE_MS);
  };
  context.sessionManager.on('session-changed', scheduleQueuePush);
  context.sessionManager.on('session-removed', scheduleQueuePush);
  context.sessionManager.on('queue-changed', scheduleQueuePush);

  // The sweep fires every minute while the agent stays idle and its row stays
  // running, and a task's row stays running until its pause reaches the PTY.
  // A pause still waiting on the task lock is not queued a second time.
  const idlePausesInFlight = new Set<string>();
  context.sessionManager.on('idle-timeout', (sessionId: string, taskId: string, timeoutMinutes: number) => {
    if (idlePausesInFlight.has(sessionId)) return;
    const session = context.sessionManager.getSession(sessionId);
    // A workflow's own agent is no task: there is no task row to write and no
    // card to toast for. Its pane shows it paused, and its own lifecycle
    // (`registerWorkflowAgentLifecycle`) records what it spent.
    if (session?.workflowId) return;
    // A Command Terminal is never paused: a suspend ends it, and its
    // conversation with it. The sweep never times one out
    // (SessionManager's `isIdleTimeoutExempt`); should a report reach here
    // anyway, it is dropped, since announcing it would mark the live terminal
    // suspended in the renderer.
    if (session && isCommandTerminalSession(session)) return;
    const projectId = context.sessionManager.getSessionProjectId(sessionId);
    const announce = (): void => {
      if (!context.mainWindow.isDestroyed()) {
        broadcast(context.mainWindow, IPC.SESSION_IDLE_TIMEOUT, sessionId, taskId, timeoutMinutes, projectId);
      }
    };
    // A task session with no project cannot be recorded, so it is suspended
    // as it always was.
    if (!projectId) {
      void context.sessionManager.suspend(sessionId);
      announce();
      return;
    }

    // A running workflow task under recovery waits on a timer, not on the
    // user: a pause would stop the nudge that moves it on, and kill any work
    // it left running. Once recovery runs out the sweep applies as before.
    if (isUnderWorkflowRecovery(taskId)) return;

    // A task's agent is paused the way the Pause button pauses it, recorded
    // as Kangentic's own (`'auto'`), which holds it paused until the user
    // resumes it or opens the task (`resumeTaskOnOpen`). The record is written
    // before the PTY goes down: the sweep used to suspend the registry first
    // and write the row later, so a quit in between left the record `running`
    // for the next launch to resume.
    idlePausesInFlight.add(sessionId);
    void pauseTaskSession(context, taskId, {
      projectId,
      suspendedBy: 'auto',
      // The agent may have started working, or been moved or resumed onto a
      // new session, while this waited for the task lock. Text the user is
      // typing into its prompt also holds the pause off: the next sweep tries
      // again once the prompt is empty. So does a background job still open. A
      // shell the watcher cannot confirm alive is reclaimed at the five-minute
      // cap, so a long build can read idle while it runs, and a pause ends it.
      // A service the agent marked never opens here, so it does not hold this.
      stillEligible: (liveSession) => liveSession.id === sessionId
        && requiresUserInteraction(context.sessionManager.getActivityCache()[sessionId])
        && (context.sessionManager.getPendingDraft(sessionId) ?? '').trim() === ''
        && context.sessionManager.getOpenWork(sessionId).backgroundShells.length === 0
        && !isUnderWorkflowRecovery(taskId),
      onAccepted: () => {
        context.terminalSubmitScheduler.cancel(taskId);
        // A pasted message is not the scheduler's, so it is stopped on its
        // own, as quietly as the keystrokes above.
        supersedeMessageDeliveries(taskId);
      },
    }).then(
      (outcome) => {
        if (outcome !== 'paused') return;
        announce();
        // Outside the task lock, started and not awaited: a Stop script never
        // holds a pause up, and it reads the record this pause just wrote.
        startParkedStop(context, projectId, taskId);
      },
      (error: unknown) => {
        console.error('[idle-timeout] pause failed:', error);
        sessionHandlersReporter.report(error, { tags: { stage: 'idle_pause' } });
      },
    ).finally(() => {
      idlePausesInFlight.delete(sessionId);
    });
  });

  // Stale session ID recovery: when a resuming session reports a different
  // agent session_id (from status.json), --resume failed silently and Claude
  // created a fresh session. Update the DB so the next resume uses the correct UUID.
  context.sessionManager.on('agent-session-id', (sessionId: string, taskId: string, projectId: string, agentReportedId: string) => {
    try {
      const database = getProjectDb(projectId);
      const sessionRepo = new SessionRepository(database);
      recoverStaleSessionId(sessionRepo, sessionId, taskId, agentReportedId);
    } catch {
      // DB may be closed
    }
  });

  /**
   * A CLI that ended on its own and SAID why did not start; say so. The
   * adapter reads its own CLI's last words (Claude's "No conversation found
   * with session ID" on a `--resume` whose transcript is gone) and the failure
   * rides the same "Agent didn't start" notice a failed worktree or checkout
   * raises. Without it the card simply went quiet: a dead session row was the
   * only trace. Two routes reach this, and both must: the agent-absence sweep
   * (the CLI runs under a shell that outlives it, so the PTY never exits on
   * its own and the sweep's kill arrives INTENTIONAL) and the rare direct PTY
   * exit. Never for a Command Terminal, which has no task to notify about.
   * `fallbackReason` is for a launch known to have failed whose CLI said nothing.
   * That launch also shows the line its adapter identified as the user's own
   * setup, so a person who is signed out reads the CLI's words. Only that launch:
   * a login that lapsed in a session that ran is not an agent that did not start.
   */
  const notifyStartupFailureIfNamed = (exitedSession: Session, exitCode: number, projectId: string, fallbackReason?: string): void => {
    if (exitedSession.transient) return;
    const exitAgentName = context.sessionManager.getSessionAgentName(exitedSession.id);
    const adapter = exitAgentName ? agentRegistry.get(exitAgentName) : undefined;
    const describeStartupFailure = adapter?.describeStartupFailure?.bind(adapter);
    if (!describeStartupFailure && !fallbackReason) return;
    // The ring lives in the pty host. The read is posted now, ahead of any
    // kill that follows, so it sees the CLI's last words.
    void context.sessionManager.getRawScrollback(exitedSession.id).then(async (rawScrollback) => {
      const namedByCli = describeStartupFailure?.(rawScrollback, exitCode);
      // The class, not only the line: a resume's ring starts with the last
      // session's output, and the report does not read a ring that holds only that.
      const outputClass = fallbackReason ? await context.sessionManager.launchOutputClass(exitedSession.id) : undefined;
      // On an account of its own, the CLI did not find the login Kangentic read there.
      noteLaunchNotSignedIn(outputClass, exitedSession.accountId);
      const userSetupLine = outputClass && isUserSetupFailureClass(outputClass)
        ? adapter?.identifyUserSetupFailure?.(rawScrollback)?.line
        : undefined;
      // The shell's own refusal, word for word, as the user's setup line is.
      const shellRefusal = outputClass === 'line_too_long' ? lineTooLongSentence(rawScrollback) : null;
      const startupFailure = namedByCli ?? userSetupLine ?? shellRefusal ?? fallbackReason;
      if (!startupFailure) return;
      // The session's report keeps it to one, if the sweep reported this launch.
      if (namedByCli) context.sessionManager.noteAgentExitedAtStart(exitedSession.id);
      try {
        const failedTask = new TaskRepository(getProjectDb(projectId)).getById(exitedSession.taskId);
        if (failedTask) notifySpawnBlocked(context, failedTask, 'agent', new Error(startupFailure), projectId);
      } catch {
        // DB may be closed during shutdown; the notice is best-effort.
      }
    }).catch(() => {
      // The host is gone (a quit or a crash) and there is nothing to read, or
      // the adapter's parser threw on what was there: the notice is best-effort.
    });
  };

  /** Why a start failed, on the row for the card and on the record for a restart. */
  const recordStartBlocked = (sessionId: string, projectId: string, reason: StartBlockedReason): void => {
    context.sessionManager.markStartBlocked(sessionId, reason);
    try {
      new SessionRepository(getProjectDb(projectId)).setStartBlockedReason(sessionId, reason);
    } catch (error) {
      // The row already says it. A closed database costs the reason after a restart.
      console.warn('[SESSION_START] Could not record why a start failed:', error);
    }
  };

  // The agent-absence sweep found a running session whose CLI is gone and is
  // about to retire it through kill(). That kill is intentional by design, so
  // this is the only moment the CLI's own account of its end can be read.
  context.sessionManager.on('agent-absent', (sessionId: string, session: Session) => {
    const resolvedProjectId = context.sessionManager.getSessionProjectId(sessionId);
    if (!resolvedProjectId) return;
    // The sweep forces the reported exit code to 0 (a normal end); the
    // recognizers read the wording, not the code.
    notifyStartupFailureIfNamed(session, 0, resolvedProjectId);
  });

  // The sweep found a task whose agent never started, which leaves nothing on
  // screen to act on: the shell holds a command that never ran. Pause it, so the
  // Resume every paused task has is there, rather than retire it to an exited row
  // that offers none. 'system' is not a held pause, so a restart resumes it too.
  // The notice waits for the pause: a pause declined for a newer session of the
  // task has no failure to report. The sweep has let this session go, so a pause
  // that does not land retires the row here, or it stays a running phantom.
  //
  // A launch with no sign its agent ran gets one retry on a fresh PTY first, after
  // the pause released the task lock, and the notice waits for that one's outcome.
  // A fresh launch is marked failed under the lock, so this retry and any later
  // Resume start it fresh with its own prompt: `--resume` would find no
  // conversation. A failed resume is unmarked, and its conversation is still there,
  // unless the CLI said it is not and its lineage had no turns (`markResumeMiss`).
  // A resume the CLI said is not there, which `markResumeMiss` left unmarked (its
  // lineage had turns), gets no retry: the same `--resume` would get the same
  // answer. It goes straight to the notice.
  //
  // The retry is Kangentic's own, so a person's gesture beats it. The decision
  // needs the output read and the retry takes the task lock itself, so it cannot
  // be made under the lock. A resume controller held from before the pause stands
  // in: a Pause, a Resume, a reset or a relocation in that gap aborts it, as it
  // aborts any resume, and a phone's Start is a resume in flight.
  context.sessionManager.on('agent-never-started', (sessionId: string, session: Session) => {
    const retire = (): void => context.sessionManager.retireAgentlessSession(sessionId);
    const projectId = context.sessionManager.getSessionProjectId(sessionId);
    if (!projectId) {
      retire();
      return;
    }
    const notifyFailure = (): void => {
      recordStartBlocked(sessionId, projectId, 'never-started');
      notifyStartupFailureIfNamed(session, 0, projectId, 'The agent never reported that it started.');
    };
    const retryWindow = new AbortController();
    registerResumeController(session.taskId, retryWindow);
    void pauseTaskSession(context, session.taskId, {
      projectId,
      suspendedBy: 'system',
      stillEligible: (liveSession) => liveSession.id === sessionId,
      onAccepted: () => {
        if (!session.resuming) new SessionRepository(getProjectDb(projectId)).markLaunchFailed(sessionId);
      },
    }).then(async (outcome) => {
      if (outcome !== 'paused') {
        retire();
        return;
      }
      const missOutcome = await markResumeMiss(context, { sessionId, taskId: session.taskId, projectId });
      // A resume's miss left unmarked would be retried with the same `--resume`
      // (DESKTOP-2M). A fresh launch never runs `--resume`, so it keeps its retry.
      const unmarkedResumeMiss = session.resuming === true && missOutcome === 'left_unmarked';
      const mayRetry = !unmarkedResumeMiss && await context.sessionManager.mayRetryLaunch(sessionId);
      releaseResumeController(session.taskId, retryWindow);
      // Another start owns the task now, so it has no failure to show, and a retry
      // would cancel that start.
      if (isResumeInFlight(session.taskId)) return;
      if (!mayRetry || retryWindow.signal.aborted) {
        notifyFailure();
        return;
      }
      console.warn(`[AGENT-LAUNCH] session=${sessionId.slice(0, 8)} retrying on a fresh PTY`);
      // `onFailed`, not the rejection: a task the user moved to To Do or Done since
      // is refused, and a refusal is their answer rather than a failure to show.
      void resumeTaskSession(context, session.taskId, { projectId, startPath: 'retry', onFailed: notifyFailure }).catch((error: unknown) => {
        console.warn('[AGENT-LAUNCH] The retry could not start:', error);
      });
    }).catch((error: unknown) => {
      console.warn('[AGENT-LAUNCH] Pause after a failed launch failed:', error);
      sessionHandlersReporter.report(error, { tags: { stage: 'launch_failure_pause' } });
      retire();
    }).finally(() => {
      releaseResumeController(session.taskId, retryWindow);
    });
  });

  // A queued session reached the front and could not start. Its folder had gone
  // while it waited (#1003 waited 17 minutes for the Merge slot), or its command
  // is too long for its shell. It pauses, so its card shows Resume, and Resume
  // recreates a worktree. The queue is not the place to run git and a
  // post-worktree script. A fresh launch is marked failed, so that Resume starts
  // it with its own prompt: the id minted for it names no conversation.
  context.sessionManager.on('agent-start-refused', (sessionId: string, session: Session, error: AgentStartRefusedError) => {
    const retire = (): void => context.sessionManager.retireRefusedStart(sessionId);
    const projectId = context.sessionManager.getSessionProjectId(sessionId);
    if (!projectId) {
      retire();
      return;
    }
    void pauseTaskSession(context, session.taskId, {
      projectId,
      suspendedBy: 'system',
      stillEligible: (liveSession) => liveSession.id === sessionId,
      onAccepted: () => {
        if (!session.resuming) new SessionRepository(getProjectDb(projectId)).markLaunchFailed(sessionId);
      },
    }).then((outcome) => {
      if (outcome !== 'paused') {
        retire();
        return;
      }
      recordStartBlocked(sessionId, projectId, error.reason);
      const task = new TaskRepository(getProjectDb(projectId)).getById(session.taskId);
      if (task) notifySpawnBlocked(context, task, 'agent', error, projectId);
    }).catch((pauseError: unknown) => {
      console.warn('[SESSION_QUEUE] Pause after a refused start failed:', pauseError);
      sessionHandlersReporter.report(pauseError, { tags: { stage: 'refused_start_pause' } });
      retire();
    });
  });

  context.sessionManager.on('exit', (sessionId: string, exitCode: number, intentional?: boolean) => {
    const resolvedProjectId = context.sessionManager.getSessionProjectId(sessionId);

    // Analytics: track session exit with duration (skip recovered sessions with no start time)
    const startTime = sessionStartTimes.get(sessionId);
    if (startTime) {
      const durationSeconds = Math.round((Date.now() - startTime) / 1000);
      const exitProps: Record<string, string | number | boolean> = { exitCode, durationSeconds };
      const exitAgentName = context.sessionManager.getSessionAgentName(sessionId);
      if (exitAgentName) exitProps.agent = exitAgentName;
      // Read model/cost from the in-memory usage cache (still populated at
      // this point; captureSessionMetrics below clears it). The DB record's
      // fields are not written until captureSessionMetrics runs, so we
      // cannot read them from the repo here. Token counts are deliberately
      // omitted: the cache's contextWindow figures are a current-context
      // snapshot, not the cumulative lifetime totals (those are covered by
      // task_complete's DB-sourced numbers instead). toolCalls reads the
      // live UsageAccumulator counter directly (same source
      // captureSessionMetrics uses) rather than the cache's stamped
      // toolCallCount, so it never reports staler than the DB.
      const usageForExit = context.sessionManager.getUsageCache()[sessionId];
      if (usageForExit?.model?.id) exitProps.model = parseModelId(usageForExit.model.id).baseId;
      if (usageForExit?.cost?.totalCostUsd != null) {
        exitProps.costUsd = Math.round(usageForExit.cost.totalCostUsd * 10000) / 10000;
      }
      exitProps.toolCalls = context.sessionManager.getToolCallCount(sessionId);
      // Crash-vs-deliberate: kill()/suspend tag the exit intentional (see
      // session-spawn-flow.ts); undefined means a genuine agent-side exit, so
      // compare === true like every other consumer of the flag.
      exitProps.intentional = intentional === true;
      trackEvent('session_exit', exitProps);
      sessionStartTimes.delete(sessionId);
      sessionSpawnAnalyticsFired.delete(sessionId);
    }

    if (!context.mainWindow.isDestroyed()) {
      broadcast(context.mainWindow, IPC.SESSION_EXIT, sessionId, exitCode, resolvedProjectId, intentional);
    }

    // The direct route to the startup-failure notice: the CLI was the PTY's
    // root (or its shell ended with it) and the PTY itself exited. Never for a
    // kill or a suspend, which are intentional and carry no failure. The usual
    // route is the agent-absence sweep's `agent-absent` below, because the CLI
    // normally runs under a shell that outlives it. Read BEFORE the DB writes
    // so the raw ring is still the CLI's output and a DB throw cannot skip it.
    if (intentional !== true && resolvedProjectId) {
      const exitedSession = context.sessionManager.getSession(sessionId);
      if (exitedSession) notifyStartupFailureIfNamed(exitedSession, exitCode, resolvedProjectId);
    }

    // Persist exit status to session DB -- use the session's own projectId
    // so we write to the correct DB even if the user switched projects.
    if (resolvedProjectId) {
      try {
        const db = getProjectDb(resolvedProjectId);
        const sessionRepo = new SessionRepository(db);
        const usageHistoryRepo = new UsageHistoryRepository(db);
        // Atomically mark 'running' or 'queued' records as 'exited'.
        // compareAndUpdateStatus guards against overwriting 'suspended',
        // which is set by TASK_MOVE before the async onExit fires.
        //
        // Shutdown-race hardening: during app quit a PTY exit is NOT a natural
        // exit - the app is tearing down sessions we want resumed next launch.
        // syncShutdownCleanup normally marks running records 'suspended' before
        // killAll, but a PTY can die first and reach this listener before that
        // runs. Recording an abnormal 'exited' here would force startup recovery
        // to reinterpret it via the interrupted-exited gather; marking
        // 'suspended' keeps it on the clean resume path. Only RUNNING records
        // are redirected - a queued row has no CLI to resume here, since
        // settleQueuedRecord decides what it becomes before any kill, and
        // suspended/exited rows CAS-no-op either way.
        // (Power loss / SIGKILL leaves isShuttingDown() false; startup recovery
        // is the real fix there.)
        const shuttingDown = isShuttingDown();
        let updated = false;
        const session = context.sessionManager.getSession(sessionId);
        if (session) {
          // Resolve the EXACT record for the exiting PTY by its id (the DB record
          // id equals the PTY session id), NOT getLatestForTask: a task can hold
          // multiple session records (its main session + per-column isolated
          // sessions), so "latest for task" could mark a newer, still-running
          // session's record exited if this exit arrives out of order after a
          // session switch. The CAS still no-ops on an intentionally 'suspended'
          // record.
          const record = sessionRepo.findByAnyId(sessionId);
          if (record) {
            updated = shuttingDown && record.status === 'running'
              ? markRecordSuspended(sessionRepo, record.id, 'system')
              : markRecordExited(sessionRepo, record.id, {
                  exit_code: exitCode,
                  exited_at: new Date().toISOString(),
                });
          }
        }
        // Fallback: try matching by agent_session_id only if taskId lookup didn't find it
        if (!updated) {
          const byAgentId = db.prepare(
            `SELECT id, status FROM sessions WHERE agent_session_id = ? AND status IN ('running', 'queued') LIMIT 1`
          ).get(sessionId) as { id: string; status: string } | undefined;
          if (byAgentId) {
            if (shuttingDown && byAgentId.status === 'running') {
              markRecordSuspended(sessionRepo, byAgentId.id, 'system');
            } else {
              markRecordExited(sessionRepo, byAgentId.id, {
                exit_code: exitCode,
                exited_at: new Date().toISOString(),
              });
            }
          }
        }

        // Capture session metrics (usage/event caches are still populated at this point).
        // Determine the DB record from whichever lookup path succeeded above.
        const metricsRecord = session
          ? sessionRepo.findByAnyId(sessionId)
          : (updated ? null : (db.prepare(
              `SELECT id, started_at, session_type FROM sessions WHERE agent_session_id = ? ORDER BY started_at DESC LIMIT 1`
            ).get(sessionId) as { id: string; started_at: string; session_type: string } | undefined) ?? null);

        if (metricsRecord) {
          captureSessionMetrics(
            context.sessionManager,
            sessionRepo,
            usageHistoryRepo,
            sessionId,
            metricsRecord.id,
            metricsRecord.started_at,
            metricsRecord.session_type,
          );
          refineTranscriptTokens(context.sessionManager, sessionRepo, sessionId, metricsRecord.id);
          refineTranscriptToolCounts(context.sessionManager, sessionRepo, sessionId, metricsRecord.id);

          // Natural /exit or crash-exit: covers sessions that finalize without
          // ever going through a suspend or move (e.g. the agent exits on its
          // own mid-column). Only possible when `session` was still in the
          // manager at exit time (it carries `taskId` directly); the
          // exit-by-agent-id fallback below has no manager entry to resolve a
          // task from.
          if (session) {
            const taskForChurn = new TaskRepository(db).getById(session.taskId);
            if (taskForChurn) {
              const project = context.projectRepo.getById(resolvedProjectId);
              captureGitChurn(taskForChurn, sessionRepo, usageHistoryRepo, metricsRecord.id, project?.path ?? null, resolveDefaultBaseBranch(context, project?.path));
            }
          }
        }
      } catch {
        // DB may be closed during shutdown
      }
    }
  });

  // Auto-link PR when an agent's `gh pr ...` command finishes (or on session
  // exit if its ToolEnd was lost). The candidate is just the hint; the
  // authoritative branch->PR query runs in linkPR, with the scrollback
  // passed through only as the gh-unavailable degradation fallback. The
  // strongest hint there is, so it skips the 60s coalesce an idle resolve
  // may have stamped after the push (but not the terminal-state skip).
  context.sessionManager.on('pr-candidate', (sessionId: string, scrollback: string) => {
    void linkPR(context, { sessionId, scrollback, bypassThrottle: true }).catch((error) => {
      console.error(`[pr-candidate] Failed to resolve PR for session ${sessionId}:`, error);
    });
  });

  // The agent's own `git push` finished: record its destination branch on the
  // task as the per-task PR anchor. Recorded only, never resolved from here:
  // the push precedes the PR, and a non-force resolve now would burn the 60s
  // per-task throttle that the `pr-candidate` seconds later needs. Transient
  // (Command Terminal) sessions have no task row to anchor.
  context.sessionManager.on('branch-pushed', (sessionId: string, branch: string) => {
    const session = context.sessionManager.getSession(sessionId);
    if (!session || session.transient) return;
    void recordPushedBranchForSession(context, sessionId, branch).catch((error) => {
      console.error(`[branch-pushed] Failed to record pushed branch for session ${sessionId}:`, error);
    });
  });

  // Manual "Link / refresh PR" - on-demand authoritative resolve for a task.
  // Works with no live session (maps by task id, resolves via the confidence ladder).
  ipcMain.handle(IPC.TASK_RESOLVE_PR, async (event, taskId: string, projectId?: string | null): Promise<TaskResolvePrResult> => {
    const resolvedProjectId = projectId ?? context.currentProjectId;
    // Not `no-anchor`: that status means the TASK has nothing to search by,
    // and the header toast says so. No project open is a different failure.
    if (!resolvedProjectId) {
      return { task: null, linked: false, reason: 'resolver-unavailable', message: 'No project is open' };
    }
    // Announced however the resolve settles, like every other task write.
    try {
      const result = await linkPR(context, { projectId: resolvedProjectId, taskId, force: true });
      return {
        task: result.task,
        linked: result.status === 'linked' || result.status === 'unchanged',
        reason: result.status,
        message: result.message,
      };
    } finally {
      // linkPR's onLinked announces a changed or cleared PR link, but not a
      // write of the head SHA or pushed branch alone, so the resolve announces
      // itself. A second emit beside onLinked's costs a phone one more re-read.
      announceTaskWrite(context, event, resolvedProjectId, { change: 'task-updated', ids: [taskId] });
    }
  });

  // The Changes panel's Pull request section: the linked PR's CI checks, read live
  // from its connector. A read, so no announce.
  ipcMain.handle(IPC.TASK_PR_CHECKS, async (_event, taskId: string, projectId?: string | null): Promise<PRChecks | null> => {
    return listTaskPrChecks(context, taskId, projectId);
  });

  // "Send to agent": the failed checks' log tails and any conflict, pasted into
  // the task's running agent or held for its next one. Writes no task row, so
  // nothing to announce; a held message is its own row the next spawn claims.
  ipcMain.handle(IPC.TASK_PR_SEND_CHECKS, async (_event, taskId: string, projectId?: string | null): Promise<PrChecksSendResult> => {
    return sendFailedPrChecks(context, taskId, projectId);
  });

  // Auto-move task once the user APPROVES the plan (ExitPlanMode completes).
  // The upstream gate fires `plan-exit` only on the tool's PostToolUse, which
  // the CLI emits solely on approval; a rejected plan emits no completion, so
  // this handler never runs and the task stays in Planning.
  //
  // When the destination column changes the model or effort (Planning at
  // xhigh, Executing at high, for example), the move suspends the PTY and
  // respawns it with --resume plus the destination's CLI flags. A
  // permission-only move keeps the live session and sends nothing. So does a
  // move that switches session track (into an isolated column, or out of one
  // back to main), lands in an always-new column, or changes agent: that
  // session is a different conversation, which never saw the plan. A bare
  // --resume leaves the CLI idle waiting for input, so the resumed session
  // needs an explicit first message: this continuation. The suspend lands
  // right after approval and the agent's transcript records it as the user
  // interrupting, so the continuation says why the session restarted and
  // names the column whose settings did it. Plain English, agent-agnostic.
  // A destination column message takes precedence over it.
  context.sessionManager.on('plan-exit', async (sessionId: string) => {
    // Use the session's own projectId -- not the singleton, which may have
    // changed if the user switched projects while the agent was running.
    const resolvedProjectId = context.sessionManager.getSessionProjectId(sessionId);
    if (!resolvedProjectId) return;
    try {
      const session = context.sessionManager.getSession(sessionId);
      if (!session) return;

      const project = context.projectRepo.getById(resolvedProjectId);
      const resolvedProjectPath = project?.path ?? null;
      const { tasks, swimlanes } = getProjectRepos(context, resolvedProjectId);
      const task = tasks.getBySessionId(sessionId);
      if (!task) return;

      // Folded through the task's Board Profile: a profile can re-point where
      // this column routes on plan exit, so two tasks leaving plan mode in the
      // same column can legitimately land in different columns. A workflow
      // task's plan approval finishes its step: it moves to the next column on
      // its ROUTE, wherever the column would send an ordinary task.
      const target = planExitTargetFor(context, task, task.swimlane_id, swimlanes, resolvedProjectPath);
      if (!target) return;

      const position = tasks.list(target.id).length;
      // 'auto-move' sends TASK_AUTO_MOVED, emits the board-changed event this
      // path never used to, and resolves the PR for the new lane - all inside
      // handleTaskMove now. The push in particular used to be a raw
      // webContents.send here, which bypassed sendToRenderer and so never
      // reached the IPC recorder: a plan-exit auto-move was invisible in the
      // dev IPC log, which is exactly the blind spot that made this class of
      // staleness bug hard to attribute.
      await handleTaskMove(
        context,
        { taskId: task.id, targetSwimlaneId: target.id, targetPosition: position },
        'auto-move',
        resolvedProjectId,
        resolvedProjectPath,
        { continuationPrompt: buildPlanExitContinuationPrompt(target.name) },
      );

      console.log(`[plan-exit] Auto-moved "${task.title}" -> "${target.name}"`);
    } catch (error) {
      console.error('[plan-exit] Auto-move failed:', error);
      sessionHandlersReporter.report(error, { tags: { stage: 'plan_exit_move' } });
    }
  });
}

/**
 * The first message of a session resumed by a plan-exit auto-move. Names the
 * DESTINATION column, whose settings forced the restart. The column
 * name stays bare: the command builder rewrites double quotes to single
 * quotes on PowerShell and cmd, so a quoted name would differ by platform.
 */
function buildPlanExitContinuationPrompt(targetColumnName: string): string {
  return `The session restarted to apply the ${targetColumnName} column's settings. Proceed with implementing the approved plan.`;
}

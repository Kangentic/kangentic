import * as pty from 'node-pty';
import * as path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import * as traceRecorder from '../../activity-engine/trace-recorder';
import type { Session, SessionContext, SpawnSessionInput } from '../../../shared/types';
import type { SessionRegistry, ManagedSession } from '../session-registry';
import { toSession } from '../session-registry';
import type { PtyBufferManager } from '../buffer/pty-buffer-manager';
import type { SessionTelemetry } from '../../activity-engine/session-telemetry';
import type { SessionIdManager } from './session-id-manager';
import type { SessionFileManager } from './session-file-manager';
import type { ResizeManager } from './resize-manager';
import type { StatusFileReader } from '../readers/status-file-reader';
import type { SessionHistoryReader } from '../readers/session-history-reader';
import type { SessionQueue } from '../session-queue';
import type { TranscriptWriter } from '../buffer/transcript-writer';
import { attachAdapter, disposeAdapterAttachment, removeAdapterHooks } from './adapter-lifecycle';
import { safeKillPty } from './pty-kill';
import { resolveShellArgs, buildSpawnEnv, resolveSpawnCwd } from '../spawn/pty-spawn';
import { handleSpawnFailure } from '../spawn/spawn-failure-handler';
import { isShuttingDown } from '../../shutdown-state';
import { adaptCommandForShell } from '../../../shared/paths';

/**
 * Default PTY dimensions a session is spawned at, before any renderer-driven
 * resize. A background (never-opened) session keeps this size for its whole
 * life; the terminal mount resizes to the real viewport when a card is opened.
 * Exported so SessionManager.getDimensions can report the same grid for a
 * queued/suspended session with no PTY and no stashed resize.
 */
export const DEFAULT_PTY_COLS = 120;
export const DEFAULT_PTY_ROWS = 30;

/**
 * Collaborators that the spawn flow reads and mutates. Grouped into a
 * single object so the signature stays readable as new modules get
 * wired into the lifecycle.
 *
 * Callbacks (`getShell`, `getTranscriptWriter`, `emit`) use getters
 * instead of value snapshots because the underlying state can change
 * after spawn (transcript writer is installed lazily; shell config
 * is mutable; emit is the session manager's inherited method).
 */
export interface SpawnFlowContext {
  registry: SessionRegistry;
  bufferManager: PtyBufferManager;
  telemetry: SessionTelemetry;
  sessionIdManager: SessionIdManager;
  sessionFiles: SessionFileManager;
  resizeManager: ResizeManager;
  statusFileReader: StatusFileReader;
  sessionHistoryReader: SessionHistoryReader;
  sessionQueue: SessionQueue;
  getTranscriptWriter: () => TranscriptWriter | null;
  getShell: () => Promise<string>;
  /**
   * Consume any resize that arrived before this session's PTY existed (see
   * SessionManager.pendingResizes). Returns the stashed dims and clears the
   * entry, or undefined if none. Lets the spawn use the real fitted size.
   */
  takePendingResize: (sessionId: string) => { cols: number; rows: number } | undefined;
  emit: (event: string, ...args: unknown[]) => void;
}

/**
 * Execute a PTY spawn for a SpawnSessionInput.
 *
 * Orchestrates the full lifecycle of turning a spawn request into a
 * running ManagedSession:
 *
 *   1. Shutdown guard (refuses spawn during `before-quit`).
 *   2. Existing-session cleanup: if a prior session exists for the
 *      taskId, kill its PTY, detach watchers while preserving files
 *      (so the new session inherits them), remove from caches.
 *   3. Scrollback carry-over: the previous session's raw scrollback
 *      is preserved so resumes show unbroken history.
 *   4. Shell resolution + env + cwd fixup resolution (see spawn/pty-spawn.ts).
 *   5. pty.spawn() with structured failure handling (a failed spawn
 *      still registers a placeholder so the renderer doesn't crash).
 *   6. Module initialization: buffer, session files, usage tracker,
 *      status file reader, session-ID capture, adapter attachment.
 *   7. Attach PTY handlers (see pty-data-handler, pty-exit-handler).
 *   8. Emit session-changed, write any Windows cwd fixup (cmd.exe UNC
 *      `pushd` / PowerShell bracket `Set-Location`), and optionally send
 *      the initial command.
 *
 * All state lives in the SpawnFlowContext; this function is stateless
 * and can be unit-tested with mocks.
 */
export async function performSpawn(
  input: SpawnSessionInput,
  context: SpawnFlowContext,
): Promise<Session> {
  if (isShuttingDown()) {
    throw new Error('Cannot spawn session during shutdown');
  }

  const shell = await context.getShell();
  const existing = input.taskId ? context.registry.findByTaskId(input.taskId) : null;

  // Use the caller-provided ID, or generate a fresh one as fallback.
  // For queue promotions, the ID was set on the input when the placeholder
  // was created in spawn(), so it matches the task's DB reference.
  // For respawns without a caller ID, a fresh UUID forces the renderer to
  // remount (TerminalTab is keyed by session ID).
  const id = input.id ?? uuidv4();

  // Kill any existing PTY for this task to prevent orphaned processes
  // that would emit data with the same session ID (double output).
  if (existing?.pty) {
    const ptyRef = existing.pty;
    existing.pty = null;
    safeKillPty(ptyRef);
  }

  if (existing) {
    // Detach watchers and readers but preserve files on disk and
    // nullify paths so the old session's onExit handler cannot
    // race-delete files the new spawn is about to reuse. See
    // SessionFileManager.detachPreservingFiles.
    context.sessionFiles.detachPreservingFiles(existing.id);
    // Cancel the old session's diagnostic timer and drop its scanner
    // so a spurious "session ID not captured" warning cannot fire
    // 30s after respawn.
    context.sessionIdManager.removeSession(existing.id);
    // Tear down any adapter-attached work from the previous spawn.
    disposeAdapterAttachment(existing);
  }

  // Carry over previous scrollback BEFORE removing state so scroll history
  // is preserved across respawns (including resume). Claude CLI's TUI uses
  // full-screen draws that overwrite the active viewport without corrupting
  // scroll history.
  const previousScrollback = existing ? context.bufferManager.getRawScrollback(existing.id) : '';

  // Remove old session from map and caches so findByTaskId returns
  // the new session, and stale usage/activity data doesn't persist.
  if (existing) {
    context.registry.delete(existing.id);
    context.telemetry.removeSession(existing.id);
    context.bufferManager.removeSession(existing.id);
    context.sessionFiles.removeSession(existing.id);
  }

  // Shell invocation (exe + args) and spawn env. See pty-spawn.ts.
  const shellName = shell.toLowerCase();
  const { exe: shellExe, args: shellArgs } = resolveShellArgs(shell);
  // Export KANGENTIC_EVENTS_PATH whenever the session has an events
  // output path. Adapters whose hooks shell out to event-bridge.js read
  // the path from their hook command line, but adapters whose hooks run
  // inline in the agent process (OpenCode plugins) need the path on
  // process.env. Setting it universally is harmless: hook-bridge-based
  // adapters ignore the env var.
  const spawnEnv: Record<string, string> = { ...(input.env ?? {}) };
  if (input.eventsOutputPath) {
    spawnEnv.KANGENTIC_EVENTS_PATH = input.eventsOutputPath;
  }
  const cleanEnv = buildSpawnEnv(spawnEnv);

  // Validate cwd + resolve any Windows cwd fixup command. See pty-spawn.ts.
  const { effectiveCwd, cwdFixupCommand } = resolveSpawnCwd({
    requestedCwd: input.cwd,
    shellName,
    platform: process.platform,
  });

  // Spawn at the real fitted dimensions if a resize arrived before the PTY
  // existed (auto-resume / queued / suspended-resume race) - takePendingResize
  // wins even when the caller also passed input.cols/rows, since it reflects a
  // resize that happened AFTER the caller computed its own grid. Next,
  // input.cols/rows: a caller-known grid (e.g. a Command Terminal branch
  // respawn reusing its still-mounted xterm's current size). Otherwise the
  // default: a background session that is never opened keeps this size, and an
  // opened one is resized to its container on mount. Spawning at the fitted
  // size means that mount-time resize is a no-op, avoiding the stale-width
  // repaint window entirely. takePendingResize is called unconditionally so
  // its entry is always consumed, even when input.cols/rows also apply.
  const pendingResize = context.takePendingResize(id);
  // A caller-supplied grid is clamped here exactly the way SessionManager.resize
  // clamps before it stashes a pendingResize: node-pty throws on 0 or negative,
  // and a non-finite value (a layout edge case yielding parseInt -> NaN) must
  // never reach pty.spawn. pendingResize is already clamped at its source;
  // input.cols/rows arrives straight off the IPC boundary, so it is clamped here.
  const requestedCols = input.cols !== undefined && Number.isFinite(input.cols)
    ? Math.max(2, Math.floor(input.cols))
    : undefined;
  const requestedRows = input.rows !== undefined && Number.isFinite(input.rows)
    ? Math.max(1, Math.floor(input.rows))
    : undefined;
  const spawnCols = pendingResize?.cols ?? requestedCols ?? DEFAULT_PTY_COLS;
  const spawnRows = pendingResize?.rows ?? requestedRows ?? DEFAULT_PTY_ROWS;

  let ptyProcess: pty.IPty;
  try {
    ptyProcess = pty.spawn(shellExe, shellArgs, {
      name: 'xterm-256color',
      cols: spawnCols,
      rows: spawnRows,
      cwd: effectiveCwd,
      env: cleanEnv,
    });
  } catch (err) {
    return handleSpawnFailure(err, {
      id,
      input,
      shell,
      shellExe,
      shellArgs,
      effectiveCwd,
      previousScrollback,
    }, {
      registry: context.registry,
      bufferManager: context.bufferManager,
      emit: context.emit,
    });
  }

  const session: ManagedSession = {
    id,
    taskId: input.taskId,
    projectId: existing?.projectId || input.projectId,
    pty: ptyProcess,
    status: 'running',
    shell,
    cwd: effectiveCwd,
    startedAt: new Date().toISOString(),
    exitCode: null,
    resuming: input.resuming ?? false,
    transient: input.transient ?? false,
    commandTerminalSlot: input.commandTerminalSlot ?? null,
    commandTerminalBranch: input.commandTerminalBranch ?? null,
    isolatedSwimlaneId: input.isolatedSwimlaneId,
    exitSequence: input.exitSequence ?? ['\x03'],
    agentParser: input.agentParser,
    agentName: input.agentName ?? 'agent',
  };

  context.registry.set(id, session);

  // Initialize extracted modules for this session. Seed the buffer manager with
  // the ACTUAL spawn cols so the first renderer resize reports colsChanged
  // truthfully: an unchanged width (PTY spawned at the fitted size) reports
  // false and skips the repaint-settle, while the cold-launch 120-to-fitted
  // change reports true and arms it. See PtyBufferManager.onResize.
  context.bufferManager.initSession(id, previousScrollback, spawnCols, spawnRows);
  context.sessionFiles.register({
    sessionId: id,
    statusOutputPath: input.statusOutputPath || null,
  });
  // Seed a fresh task spawn as thinking - it is already processing its initial
  // prompt - so the indicator does not flash idle during boot. Resumes and
  // transient command terminals start idle: they wait for the user.
  context.telemetry.initSession(id, input.agentParser, !input.resuming && !input.transient);

  // Dev-only trace recorder: register the session directory so passive
  // PTY-chunk and status-delta recording can target the right files.
  // The recorder's body is dead-code-eliminated in production via
  // __KANGENTIC_DEV__, so this call becomes a no-op in shipped builds.
  if (input.statusOutputPath) {
    traceRecorder.setSessionDir(id, path.dirname(input.statusOutputPath));
  }

  // Attach the status-file telemetry reader for sessions that provide
  // status/events file paths (today only Claude). The reader owns the
  // FileWatcher instances and dispatches parsed telemetry via the
  // generic SessionTelemetry primitives wired in StatusFileReader's
  // callbacks. When the session has no parser, the reader still runs
  // startup file cleanup (delete stale status.json, truncate stale
  // events.jsonl) but skips watcher setup.
  if (input.statusOutputPath || input.eventsOutputPath) {
    context.statusFileReader.attach({
      sessionId: id,
      statusOutputPath: input.statusOutputPath || null,
      eventsOutputPath: input.eventsOutputPath || null,
      statusFileHook: input.agentParser?.runtime?.statusFile ?? null,
    });
  }

  // Session-ID capture: arm the diagnostic timer and kick off the
  // filesystem-based pathway. See SessionIdManager for the
  // full capture strategy. Skip the diagnostic timer when the agent
  // session ID is caller-owned (already set at spawn time) - the
  // 30s "not captured" warning would be a false positive since we
  // never expected the agent to report it.
  context.sessionIdManager.init(
    id,
    input.agentParser,
    effectiveCwd,
    session.agentName ?? 'agent',
    !!input.agentSessionId,
  );

  // Caller-owned session ID short-circuit: when the adapter declares
  // `supportsCallerSessionId = true` the spawn pipeline pre-generates
  // a UUID and passes it on the CLI (--session-id / --session). For
  // adapters that ALSO declare `runtime.sessionHistory` we attach the
  // reader immediately so model + token telemetry starts streaming
  // without waiting for capture pathways to round-trip.
  //
  // Why not call `usageTracker.notifyAgentSessionId` instead: that
  // path also fires the `agent-session-id` event which dispatches to
  // `recoverStaleSessionId(sessionRepo, ...)`. The DB record is
  // inserted by the caller AFTER spawn() returns, so during the
  // notify the latest session record is still the previous (retired)
  // one. recoverStaleSessionId would then misattribute the new ID to
  // the old record. Calling attach() directly skips that chain.
  // sessionHistoryReader.attach is idempotent; a later capture
  // pathway firing the full notify chain is harmless.
  //
  // No "status already flowed" guard is needed here (unlike the
  // onAgentSessionId re-attach path in session-manager): this fires at
  // spawn, and StatusFileReader.attach deletes any stale status.json first,
  // so status.json cannot have flowed yet. For Claude this is the sole
  // trigger that starts the transcript fallback for a background session.
  const callerOwnedSessionHistory = input.agentParser?.runtime?.sessionHistory;
  if (input.agentSessionId && callerOwnedSessionHistory) {
    context.sessionHistoryReader.attach({
      sessionId: id,
      agentSessionId: input.agentSessionId,
      cwd: effectiveCwd,
      hook: callerOwnedSessionHistory,
      agentName: session.agentName,
      // On a resume the transcript already exists and its tail is PRE-suspend
      // (stale) occupancy - start at EOF so only fresh post-resume entries
      // produce usage. The spawn-time model seed still shows the model name.
      startAtEnd: input.resuming === true,
    }).catch((err) => {
      console.warn(`[session-history] attach failed for session=${id.slice(0, 8)}:`, err);
    });
  }

  // Generic adapter lifecycle hook. See adapter-lifecycle.ts for the
  // contract. The attachment is disposed on PTY exit and on remove()
  // so adapter fire-and-forget work is cancelled cleanly.
  const adapterContext: SessionContext = {
    sessionId: id,
    applyUsage: (usage) => {
      if (!context.registry.has(id)) return;
      context.telemetry.setSessionUsage(id, usage);
    },
  };
  attachAdapter(session, adapterContext);

  // Eagerly seed the card's model name from the spawn command so a background
  // (never-opened) session shows its model (e.g. "Opus 4.8") IMMEDIATELY,
  // instead of a "Starting agent..." spinner while it waits for status.json -
  // which a background PTY may never write on its own (it only paints its
  // statusline in a foreground/tall terminal). The agent's own telemetry
  // overrides this via a full usage replace, so a later in-session /model
  // change is reflected accurately. Only agents that encode a model on the
  // command (Claude --model) and implement the hook seed; others are unaffected.
  // `input.command` is the raw pre-shell-adaptation command; the parser reads the
  // model only from the flag region (before the end-of-options `--`), never the
  // prompt, so the input shape is stable regardless of the target shell.
  const configuredModel = input.agentParser?.configuredModelFromCommand?.(input.command);
  if (configuredModel) {
    context.telemetry.setSessionUsage(id, {
      model: { id: configuredModel.id, displayName: configuredModel.displayName },
    });
  }

  // Batched data output (~60Hz hot path). Fans out to:
  //   - PtyBufferManager: ring buffer + IPC batching for focused sessions.
  //   - TranscriptWriter: raw bytes to DB (skipped for transient sessions).
  //   - SessionIdManager: chunk-boundary-safe scanner for the agent's
  //     self-reported session ID (ANSI-stripped for ConPTY).
  //   - Stream telemetry parser (adapter-specific, lazy init on first chunk).
  //   - PTY activity detection (yields to hook-based for 'hooks_and_pty').
  const ptyDataDisposable = ptyProcess.onData((data: string) => {
    context.bufferManager.onData(id, data);

    // Dev-only: record chunk arrival for the trace replay pipeline.
    // Length-only (no content) keeps the file small and privacy-safe.
    traceRecorder.recordPtyChunk(id, data.length);

    // Per-session in-memory ring of bucketed PTY chunk arrivals for
    // the debug overlay's timeline. Cheap (one map lookup + array
    // push) and bounded (~1200 entries for the 120s window). Body is
    // dead-code-eliminated in production via __KANGENTIC_DEV__.
    context.telemetry.activityEngine.markPtyChunk(id);

    // Production stuck-pending-tools signal: a single timestamp write so a
    // long quiet foreground tool (a test run streaming output with no hook
    // event or status heartbeat for >5 min) is not force-idled. Unconditional
    // and independent of the PtyActivityTracker suppression below, which
    // silences PTY activity detection for hooks-based agents but must not
    // silence this watchdog refresh.
    context.telemetry.activityEngine.markPtyOutput(id);

    // Transient sessions (command terminal) have no DB row - the
    // TranscriptWriter's lazy init will fail silently on first flush
    // (caught by try/catch in flush()), so we skip them entirely.
    if (!session.transient) {
      context.getTranscriptWriter()?.onData(id, data);
    }

    // Per-adapter session ID capture from PTY output. Handles chunk-
    // boundary safety (rolling buffer) and ANSI stripping (Windows
    // ConPTY cursor positioning that defeats raw regexes).
    context.sessionIdManager.onData(id, data, session.agentParser);

    // Per-adapter stream telemetry (e.g. Cursor stream-json: model from
    // the init event, ToolStart/ToolEnd events for activity tracking).
    // Each adapter owns whatever carry-over state it needs across PTY
    // chunks (the parser is constructed lazily on first chunk).
    const streamFactory = input.agentParser?.runtime?.streamOutput;
    if (streamFactory) {
      if (!session.streamParser) {
        session.streamParser = streamFactory.createParser();
      }
      const result = session.streamParser.parseTelemetry(data);
      if (result?.usage) {
        context.telemetry.setSessionUsage(id, result.usage);
      }
      if (result?.events && result.events.length > 0) {
        context.telemetry.ingestEvents(id, result.events);
      }
    }

    // PTY-based activity detection for agents using 'pty' or 'hooks_and_pty'
    // strategies. For 'hooks_and_pty', yields to hook-based detection once
    // hooks deliver a thinking event.
    const strategy = input.agentParser?.runtime?.activity;
    if (strategy && strategy.kind !== 'hooks') {
      if (strategy.detectIdle?.(data)) {
        context.telemetry.notifyPtyIdle(id);
      } else if (data.length > 0) {
        const currentActivity = context.telemetry.getSessionActivity(id);
        if (context.resizeManager.shouldNotifyOnData(id, data, currentActivity)) {
          context.telemetry.notifyPtyData(id);
        }
      }
    }
  });

  // PTY exit cleanup sequence. Don't overwrite 'suspended' - suspend()
  // sets that before killing the PTY, and the new status must survive.
  const ptyExitDisposable = ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
    // Captured BEFORE the status mutation below. `intentional` means Kangentic
    // ended this session deliberately, so a non-zero force-kill exit must not be
    // misclassified as a crash. Two deliberate-end mechanisms set it:
    //   - suspend() sets status='suspended' before the force-kill (move-to-Done,
    //     isolated-session switch, settings restart, idle auto-suspend, user
    //     Suspend).
    //   - kill(sessionId, true) sets session.intentionalExit before the
    //     force-kill for hard-reset teardown that does NOT suspend (move-to-To-Do
    //     reset, task delete, move-to-Backlog via cleanupTaskSession).
    // The flag rides the 'exit' event so App.tsx can suppress the false crash
    // notification without depending on cross-channel store-status ordering.
    const intentional = session.status === 'suspended' || session.intentionalExit === true;
    if (session.status !== 'suspended') {
      session.status = 'exited';
      // Synthetic session_end - Claude Code's hook won't fire on kill
      context.telemetry.emitSessionEnd(id);
    }
    session.exitCode = exitCode;
    session.pty = null;

    // Cancel the session-ID diagnostic timer but keep the scanner so
    // the scrollback fallback in suspend() can still use its buffer.
    context.sessionIdManager.clearDiagnostic(id);
    disposeAdapterAttachment(session);

    // Flush transcript to DB before closing out the session
    context.getTranscriptWriter()?.finalize(id);

    // Final flush: process any unread events written before PTY exited.
    // Catches the common race where the agent writes ToolEnd just before
    // the PTY exits, but fs.watch hasn't fired the callback yet.
    context.statusFileReader.flushPendingEvents(id);

    // Strip agent hooks from the project's settings file so they don't
    // accumulate across sessions. See adapter-lifecycle.removeAdapterHooks.
    removeAdapterHooks(session);

    // Close watchers but preserve session files on disk - they are
    // needed for crash recovery. Files are cleaned up by
    // pruneStaleResources(), remove(), or killAll(). See
    // SessionFileManager.detachOnPtyExit.
    context.sessionFiles.detachOnPtyExit(id);

    // Fallback PR resolution: if a PR command was flagged (ToolStart seen) but
    // ToolEnd was never processed (event lost or never written), fire the
    // candidate now as a last resort before the session is fully closed. The
    // IPC listener runs the authoritative branch->PR query (with the scrollback
    // as a degradation fallback).
    if (context.telemetry.hasPendingPRCommand(id)) {
      context.telemetry.clearPendingPRCommand(id);
      const scrollback = context.bufferManager.getRawScrollback(id);
      context.emit('pr-candidate', id, scrollback);
    }

    // Dev-only: stop trace recording for this session. Files persist
    // on disk so a "Capture trace" devtool call after exit still
    // bundles them. The next attach() with the same sessionId
    // reattaches.
    traceRecorder.clearSessionDir(id);

    context.emit('exit', id, exitCode, intentional);
    context.sessionQueue.notifySlotFreed();
  });

  // Retain the listener disposables so the synchronous shutdown path
  // (killAllSessions) can detach them at kill, stopping node-pty from
  // invoking our callbacks on a later tick after the session dir is deleted.
  session.ptyDisposables = [ptyDataDisposable, ptyExitDisposable];

  context.emit('session-changed', id, toSession(session));
  // Announce the grid the PTY actually spawned at. A mobile-bridge
  // subscriber that snapshotted this session while it was still queued
  // reported the pending/default dims; this closes that gap the same way
  // a live resize does (read-stream forwards it as a terminal-resize event).
  // The 'spawn' origin lets a mounted xterm treat a respawn under it like any
  // desktop reshape: re-assertable if the spawn grid disagrees with its fit.
  context.emit('pty-resize', id, spawnCols, spawnRows, 'spawn');

  // After a brief delay, write any Windows cwd fixup (so the session lands
  // in the real project directory) and then the initial command. The fixup
  // is written even when there is no command so a bare shell also lands
  // correctly. It is written RAW (not through adaptCommandForShell, which
  // would add a spurious `& ` prefix): cmd.exe `pushd "<unc>"` maps the UNC
  // path to a temporary drive letter, PowerShell `Set-Location -LiteralPath`
  // corrects its wildcard-mangled provider location for bracketed paths.
  if (input.command || cwdFixupCommand) {
    setTimeout(() => {
      if (cwdFixupCommand) {
        ptyProcess.write(cwdFixupCommand + '\r');
      }
      if (input.command) {
        const cmd = adaptCommandForShell(input.command, shellName);
        if (cwdFixupCommand) {
          setTimeout(() => ptyProcess.write(cmd + '\r'), 200);
        } else {
          ptyProcess.write(cmd + '\r');
        }
      }
    }, 100);
  }

  return toSession(session);
}

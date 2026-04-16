import * as pty from 'node-pty';
import { v4 as uuidv4 } from 'uuid';
import type { Session, SessionContext, SpawnSessionInput } from '../../../shared/types';
import type { SessionRegistry, ManagedSession } from '../session-registry';
import { toSession } from '../session-registry';
import type { PtyBufferManager } from '../buffer/pty-buffer-manager';
import type { UsageTracker } from '../activity/usage-tracker';
import type { SessionIdManager } from './session-id-manager';
import type { SessionFileManager } from './session-file-manager';
import type { ResizeManager } from './resize-manager';
import type { StatusFileReader } from '../readers/status-file-reader';
import type { SessionQueue } from '../session-queue';
import type { TranscriptWriter } from '../buffer/transcript-writer';
import { attachAdapter, disposeAdapterAttachment, removeAdapterHooks } from './adapter-lifecycle';
import { safeKillPty } from './pty-kill';
import { resolveShellArgs, buildSpawnEnv, resolveSpawnCwd } from '../spawn/pty-spawn';
import { handleSpawnFailure } from '../spawn/spawn-failure-handler';
import { detectPR } from '../pr/pr-connectors';
import { isShuttingDown } from '../../shutdown-state';
import { adaptCommandForShell } from '../../../shared/paths';

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
  usageTracker: UsageTracker;
  sessionIdManager: SessionIdManager;
  sessionFiles: SessionFileManager;
  resizeManager: ResizeManager;
  statusFileReader: StatusFileReader;
  sessionQueue: SessionQueue;
  getTranscriptWriter: () => TranscriptWriter | null;
  getShell: () => Promise<string>;
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
 *   4. Shell resolution + env + UNC-safe cwd (see spawn/pty-spawn.ts).
 *   5. pty.spawn() with structured failure handling (a failed spawn
 *      still registers a placeholder so the renderer doesn't crash).
 *   6. Module initialization: buffer, session files, usage tracker,
 *      status file reader, session-ID capture, adapter attachment.
 *   7. Attach PTY handlers (see pty-data-handler, pty-exit-handler).
 *   8. Emit session-changed and optionally send an initial command
 *      (with Windows UNC `pushd` workaround for cmd.exe).
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
    context.usageTracker.removeSession(existing.id);
    context.bufferManager.removeSession(existing.id);
    context.sessionFiles.removeSession(existing.id);
  }

  // Shell invocation (exe + args) and spawn env. See pty-spawn.ts.
  const shellName = shell.toLowerCase();
  const { exe: shellExe, args: shellArgs } = resolveShellArgs(shell);
  const cleanEnv = buildSpawnEnv(input.env);

  // Validate cwd + apply Windows UNC fallback for cmd.exe. See pty-spawn.ts.
  const { effectiveCwd, uncPushdPrefix } = resolveSpawnCwd({
    requestedCwd: input.cwd,
    shellName,
    platform: process.platform,
  });

  let ptyProcess: pty.IPty;
  try {
    ptyProcess = pty.spawn(shellExe, shellArgs, {
      name: 'xterm-256color',
      cols: 120,
      rows: 30,
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
    exitSequence: input.exitSequence ?? ['\x03'],
    agentParser: input.agentParser,
    agentName: input.agentName ?? 'agent',
  };

  context.registry.set(id, session);

  // Initialize extracted modules for this session
  context.bufferManager.initSession(id, previousScrollback, 0);
  context.sessionFiles.register({
    sessionId: id,
    statusOutputPath: input.statusOutputPath || null,
  });
  context.usageTracker.initSession(id, input.agentParser);
  // Attach the status-file telemetry reader for sessions that provide
  // status/events file paths (today only Claude). The reader owns the
  // FileWatcher instances and dispatches parsed telemetry via the
  // generic UsageTracker primitives wired in StatusFileReader's
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
  // full capture strategy.
  context.sessionIdManager.init(id, input.agentParser, effectiveCwd, session.agentName ?? 'agent');

  // Generic adapter lifecycle hook. See adapter-lifecycle.ts for the
  // contract. The attachment is disposed on PTY exit and on remove()
  // so adapter fire-and-forget work is cancelled cleanly.
  const adapterContext: SessionContext = {
    sessionId: id,
    applyUsage: (usage) => {
      if (!context.registry.has(id)) return;
      context.usageTracker.setSessionUsage(id, usage);
    },
  };
  attachAdapter(session, adapterContext);

  // Batched data output (~60Hz hot path). Fans out to:
  //   - PtyBufferManager: ring buffer + IPC batching for focused sessions.
  //   - TranscriptWriter: raw bytes to DB (skipped for transient sessions).
  //   - SessionIdManager: chunk-boundary-safe scanner for the agent's
  //     self-reported session ID (ANSI-stripped for ConPTY).
  //   - Stream telemetry parser (adapter-specific, lazy init on first chunk).
  //   - PTY activity detection (yields to hook-based for 'hooks_and_pty').
  ptyProcess.onData((data: string) => {
    context.bufferManager.onData(id, data);

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
        context.usageTracker.setSessionUsage(id, result.usage);
      }
      if (result?.events && result.events.length > 0) {
        context.usageTracker.ingestEvents(id, result.events);
      }
    }

    // PTY-based activity detection for agents using 'pty' or 'hooks_and_pty'
    // strategies. For 'hooks_and_pty', yields to hook-based detection once
    // hooks deliver a thinking event.
    const strategy = input.agentParser?.runtime?.activity;
    if (strategy && strategy.kind !== 'hooks') {
      if (strategy.detectIdle?.(data)) {
        context.usageTracker.notifyPtyIdle(id);
      } else if (data.length > 0) {
        const currentActivity = context.usageTracker.getSessionActivity(id);
        if (context.resizeManager.shouldNotifyOnData(id, data, currentActivity)) {
          context.usageTracker.notifyPtyData(id);
        }
      }
    }
  });

  // PTY exit cleanup sequence. Don't overwrite 'suspended' - suspend()
  // sets that before killing the PTY, and the new status must survive.
  ptyProcess.onExit(({ exitCode }: { exitCode: number }) => {
    if (session.status !== 'suspended') {
      session.status = 'exited';
      // Synthetic session_end - Claude Code's hook won't fire on kill
      context.usageTracker.emitSessionEnd(id);
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

    // Fallback PR scan: if a PR command was flagged (ToolStart seen) but
    // ToolEnd was never processed (event lost or never written), scan the
    // scrollback now as a last resort before the session is fully closed.
    if (context.usageTracker.hasPendingPRCommand(id)) {
      context.usageTracker.clearPendingPRCommand(id);
      const scrollback = context.bufferManager.getRawScrollback(id);
      const detected = detectPR(scrollback);
      if (detected) {
        context.emit('pr-detected', id, detected.url, detected.number);
      }
    }

    context.emit('exit', id, exitCode);
    context.sessionQueue.notifySlotFreed();
  });

  context.emit('session-changed', id, toSession(session));

  // If there's a command to run, send it after a brief delay
  if (input.command) {
    setTimeout(() => {
      const cmd = adaptCommandForShell(input.command!, shellName);
      if (uncPushdPrefix) {
        // pushd maps UNC path to a temporary drive letter, then run the command
        ptyProcess.write(uncPushdPrefix + '\r');
        setTimeout(() => ptyProcess.write(cmd + '\r'), 200);
      } else {
        ptyProcess.write(cmd + '\r');
      }
    }, 100);
  }

  return toSession(session);
}

import * as path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import * as traceRecorder from '../../activity-engine/trace-recorder';
import type { AgentParser, Session, SessionContext, SpawnSessionInput } from '../../../shared/types';
import type { SessionRegistry, ManagedSession } from '../session-registry';
import { toSession } from '../session-registry';
import type { SessionTelemetry } from '../../activity-engine/session-telemetry';
import type { SessionIdManager } from './session-id-manager';
import type { SessionFileManager } from './session-file-manager';
import type { StatusFileReader } from '../readers/status-file-reader';
import type { SessionHistoryReader } from '../readers/session-history-reader';
import type { SessionQueue } from '../session-queue';
import type { FirstOutputTracker } from './first-output-tracker';
import type { PtyHandle, PtyHostClient } from '../host/pty-host-client';
import { attachAdapter, disposeAdapterAttachment, removeAdapterHooks } from './adapter-lifecycle';
import { safeKillPty } from './pty-kill';
import { resolveShellArgs, buildSpawnEnv, resolveSpawnCwd } from '../spawn/pty-spawn';
import { handleSpawnFailure } from '../spawn/spawn-failure-handler';
import { isShuttingDown } from '../../shutdown-state';
import { traceTerminal } from '../terminal-trace';
import { adaptCommandForShell, buildSpawnClearPrelude } from '../../../shared/paths';

/**
 * Default PTY dimensions a session is spawned at, before any renderer-driven
 * resize, when there is no better grid (a respawn starts at its predecessor's,
 * see SpawnFlowContext.inheritedGrid, and a resume with no in-memory
 * predecessor at its record's, see SpawnSessionInput.restoredGrid). A
 * background (never-opened) session
 * keeps this size until something shows it or a phone's resting-grid park
 * reshapes it; the terminal mount resizes to the real viewport when a card is
 * opened.
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
 * Callbacks (`getShell`, `emit`) use getters instead of value snapshots
 * because the underlying state can change after spawn (shell config is
 * mutable; emit is the session manager's inherited method).
 */
export interface SpawnFlowContext {
  registry: SessionRegistry;
  /** The pty host: spawns the PTY and owns its output pipeline (buffer,
   *  transcript, detectors). */
  host: PtyHostClient;
  telemetry: SessionTelemetry;
  sessionIdManager: SessionIdManager;
  sessionFiles: SessionFileManager;
  statusFileReader: StatusFileReader;
  sessionHistoryReader: SessionHistoryReader;
  sessionQueue: SessionQueue;
  firstOutputTracker: FirstOutputTracker;
  /** Record the column count a session's ring was seeded at (main's mirror
   *  for `resize()`'s colsChanged report). */
  setBufferCols: (sessionId: string, cols: number) => void;
  getShell: () => Promise<string>;
  /**
   * Consume any resize that arrived before this session's PTY existed (see
   * SessionManager.pendingResizes). Returns the stashed dims and clears the
   * entry, or undefined if none. Lets the spawn use the real fitted size.
   */
  takePendingResize: (sessionId: string) => { cols: number; rows: number } | undefined;
  /**
   * Drop every grid kept for a row this spawn replaces under a different id
   * (a stashed resize, the desktop restore target, a pending park), once
   * `inheritedGrid` has read what it needs. Nothing reads them again: the
   * successor has its own id. A context built without this keeps them.
   */
  forgetSessionGrid?: (sessionId: string) => void;
  /**
   * Drop a resize stashed under this spawn's own id after `takePendingResize`
   * read it: one that reached a promotion's placeholder during the host round
   * trip. A context built without this keeps it.
   */
  discardPendingResize?: (sessionId: string) => void;
  /**
   * The grid a successor spawned under a new id should start at, from the row
   * it replaces (the scrollback carry-over source), or undefined for the
   * default. The policy (which predecessors qualify, the strip-grid guard)
   * lives with the caller. A context built without this never inherits.
   */
  inheritedGrid?: (predecessor: ManagedSession) => { cols: number; rows: number } | undefined;
  /**
   * Vet a grid read from the replaced session record (`input.restoredGrid`):
   * the grid to spawn at, or undefined to fall through to the default. A
   * context built without this never restores.
   */
  restoredGrid?: (grid: { cols: number; rows: number }) => { cols: number; rows: number } | undefined;
  emit: (event: string, ...args: unknown[]) => void;
  /**
   * True once a teardown aimed at this session or its task (a kill, remove or
   * suspend, by id or task-wide) has landed while it spawns. SessionManager
   * tracks every spawn it starts; a context built without this never cancels.
   */
  isSpawnCancelled?: (sessionId: string) => boolean;
  /**
   * A cancelled spawn whose PTY the host had already started: `ptyExited`
   * settles once that PTY has exited. It holds the session's working directory
   * until then, so a teardown that removes the directory waits on it.
   */
  onSpawnAbandoned?: (sessionId: string, ptyExited: Promise<void>) => void;
}

/**
 * Give up a spawn a teardown overtook (`SpawnFlowContext.isSpawnCancelled`).
 * The host round trip is a window in which a To Do move, a reset or a suspend
 * can tear the session down; registering it after that would bring back a
 * running session the teardown already ended, with a PTY nothing stops.
 *
 * Stops the PTY the host started, if it got that far, registers nothing, and
 * fails as an abort: the board's spawn paths read that as "the task was taken
 * over", not as a failed spawn, so it is not counted, reported or notified.
 * kill() already marked a cancelled promotion's placeholder exited and emitted
 * its intentional exit; the placeholder branch here is the fallback for a
 * teardown that did not go through kill().
 */
function abandonCancelledSpawn(id: string, startedPty: PtyHandle | null, context: SpawnFlowContext): never {
  if (startedPty) {
    // Listened for before the kill, so the exit cannot land unheard.
    const ptyExited = new Promise<void>((resolve) => {
      context.host.onPtyExit(startedPty.ptyId, () => resolve());
    });
    context.onSpawnAbandoned?.(id, ptyExited);
    // No exit sequence and no grace, as in the quit branch below: the host
    // started it one round trip ago, before the agent reaches its boot canary.
    safeKillPty(startedPty);
    // The host made state for the session; with its row gone, nothing else
    // will remove it. A row the teardown kept is removed with that row.
    if (!context.registry.get(id)) context.host.post({ type: 'removeSession', sessionId: id });
  }
  const placeholder = context.registry.get(id);
  if (placeholder && placeholder.status === 'queued') {
    placeholder.status = 'exited';
    placeholder.exitCode = -1;
    context.emit('exit', id, -1, true);
  }
  throw new DOMException('The session was ended while it was being spawned', 'AbortError');
}

/**
 * Which drained sibling's scrollback and geometry the new session inherits.
 *
 * The most recently started row that is not the id being reused: a queued
 * placeholder being promoted reuses its own id and has no scrollback, while
 * the row it queued behind (a suspended-in-place session) does. Among the
 * rest, the latest `startedAt` is the session the user last saw. Compared as
 * ISO strings; a missing value sorts oldest. Falls back to any sibling so a
 * lone placeholder keeps the (empty) carry-over it always had.
 */
function pickCarryoverSource(siblings: ManagedSession[], reusedId: string): ManagedSession | null {
  let source: ManagedSession | null = null;
  for (const sibling of siblings) {
    if (sibling.id === reusedId) continue;
    if (!source || (sibling.startedAt || '') > (source.startedAt || '')) source = sibling;
  }
  return source ?? siblings[0] ?? null;
}

/**
 * The registry name of the adapter behind an `AgentParser`. The parser is the
 * full `AgentAdapter` instance at runtime (see ManagedSession.agentParser), so
 * its `name` is the key the pty host resolves the detectors by.
 */
function adapterNameOf(parser: AgentParser): string | null {
  const name = (parser as { name?: unknown }).name;
  return typeof name === 'string' ? name : null;
}

/**
 * Execute a PTY spawn for a SpawnSessionInput.
 *
 * Orchestrates the full lifecycle of turning a spawn request into a
 * running ManagedSession:
 *
 *   1. Shutdown guard (refuses spawn during `before-quit`).
 *   2. Existing-session cleanup: for EVERY prior registry row of the
 *      taskId, kill its PTY, detach watchers while preserving files
 *      (so the new session inherits them), remove from caches. Draining
 *      all of them is what keeps the registry at one row per task.
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
  // EVERY registry row for the task, not the first match. The registry holds
  // one row per task by contract, but a stale suspended placeholder (a repeat
  // project open) or a suspended-in-place row (a settings restart) could
  // accumulate ahead of the spawn, and a spawn that drained only the first of
  // them left the survivor listed ahead of the live PTY: the renderer's
  // first-wins consumers painted "Resume session" over a running agent.
  const siblings = input.taskId ? context.registry.listByTaskId(input.taskId) : [];

  // Use the caller-provided ID, or generate a fresh one as fallback.
  // For queue promotions, the ID was set on the input when the placeholder
  // was created in spawn(), so it matches the task's DB reference.
  // For respawns without a caller ID, a fresh UUID forces the renderer to
  // remount (TerminalTab is keyed by session ID).
  const id = input.id ?? uuidv4();

  // Torn down while the shell resolved: nothing of it or its siblings has been
  // touched yet, and the host has started nothing.
  if (context.isSpawnCancelled?.(id)) abandonCancelledSpawn(id, null, context);

  for (const sibling of siblings) {
    // Kill any existing PTY for this task to prevent orphaned processes
    // that would emit data with the same session ID (double output).
    if (sibling.pty) {
      const ptyRef = sibling.pty;
      sibling.pty = null;
      safeKillPty(ptyRef);
    }
    // Detach watchers and readers but preserve files on disk and
    // nullify paths so the old session's onExit handler cannot
    // race-delete files the new spawn is about to reuse. See
    // SessionFileManager.detachPreservingFiles.
    context.sessionFiles.detachPreservingFiles(sibling.id);
    // Cancel the old session's diagnostic timer and drop its scanner
    // so a spurious "session ID not captured" warning cannot fire
    // 30s after respawn.
    context.sessionIdManager.removeSession(sibling.id);
    // Drop the old session's first-output latch. A queue promotion reuses
    // its placeholder's id, and a latched entry under the reused id would
    // permanently suppress 'first-output' for the new session - and with it
    // the post-first-output geometry re-assert.
    context.firstOutputTracker.removeSession(sibling.id);
    // Tear down any adapter-attached work from the previous spawn.
    disposeAdapterAttachment(sibling);
  }

  // Carry over previous scrollback so scroll history is preserved across
  // respawns (including resume). Claude CLI's TUI uses full-screen draws that
  // overwrite the active viewport without corrupting scroll history. The host
  // holds the rings: it reads the source's bytes and the geometry they were
  // drawn for before it drops the old sessions, so initSession can keep the
  // replay's geometry gate accurate instead of frame-routing every respawn.
  const carryoverSource = pickCarryoverSource(siblings, id);

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
  // existed under THIS id (a queue promotion: a renderer fit, or the resting-grid
  // park, stashed while the placeholder waited) - takePendingResize wins even
  // when the caller also passed input.cols/rows, since it reflects a resize
  // that happened AFTER the caller computed its own grid. Next,
  // input.cols/rows: a caller-known grid (e.g. a Command Terminal branch
  // respawn reusing its still-mounted xterm's current size). Next, the grid of
  // the row this spawn replaces: every board respawn (a column move, a model
  // switch, a resume) mints a new id, so the predecessor's last grid is the
  // best guess at what the successor will be shown at - the surface that
  // showed the old session, or the phone's resting grid. Otherwise the
  // default: a background session that is never opened keeps this size, and an
  // opened one is resized to its container on mount. Spawning at the fitted
  // size means that mount-time resize is a no-op, avoiding the stale-width
  // repaint window and the boot-time geometry re-asserts entirely.
  // takePendingResize is called unconditionally so its entry is always
  // consumed, even when input.cols/rows also apply.
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
  // A queue promotion's fallback carry-over source is its own placeholder,
  // which has no grid of its own to hand on.
  const inheritedGrid = carryoverSource && carryoverSource.id !== id
    ? context.inheritedGrid?.(carryoverSource)
    : undefined;
  // Last before the default: the grid recorded on the session record this
  // spawn replaces, for the resumes no in-memory row can speak for (after a
  // desktop restart the registry is empty; after a pty host crash the lost row
  // is exited, which inheritedGrid refuses).
  const restoredGrid = input.restoredGrid ? context.restoredGrid?.(input.restoredGrid) : undefined;
  const spawnCols = pendingResize?.cols ?? requestedCols ?? inheritedGrid?.cols ?? restoredGrid?.cols ?? DEFAULT_PTY_COLS;
  const spawnRows = pendingResize?.rows ?? requestedRows ?? inheritedGrid?.rows ?? restoredGrid?.rows ?? DEFAULT_PTY_ROWS;

  // The host spawns the PTY (CreateProcess runs on its thread, not main's: 36
  // to 47 ms a spawn on Windows) and seeds the new ring. The adapter's name
  // lets it run the output detectors; a session with no adapter has none.
  const spawnOutcome = await context.host.spawn({
    sessionId: id,
    projectId: carryoverSource?.projectId || input.projectId,
    agentName: input.agentParser ? (input.agentName ?? adapterNameOf(input.agentParser)) : null,
    transient: input.transient === true,
    file: shellExe,
    args: shellArgs,
    cwd: effectiveCwd,
    env: cleanEnv,
    cols: spawnCols,
    rows: spawnRows,
    carryoverFromSessionId: carryoverSource?.id ?? null,
    agentSessionIdKnown: !!input.agentSessionId,
  });

  // Torn down during the host round trip. Ahead of every outcome branch: a
  // failed spawn's placeholder would bring back a row a remove() announced gone.
  if (context.isSpawnCancelled?.(id)) abandonCancelledSpawn(id, spawnOutcome.ok ? spawnOutcome.pty : null, context);

  // The quit can begin during the host round trip. killAll found no row for
  // this session, so nothing else would stop the PTY the host just started,
  // and the host's own shutdown kills no session PTY. Started milliseconds
  // ago, the agent has not reached its boot canary, so no grace is owed.
  if (spawnOutcome.ok && isShuttingDown()) {
    safeKillPty(spawnOutcome.pty);
    throw new Error('Cannot spawn session during shutdown');
  }

  // Remove the old rows from the map and caches so the task's only registry
  // row is the new session, and stale usage/activity data doesn't persist.
  // After the spawn, so the task is never without a row while it is in flight.
  // The host drops their rings here too, not with the spawn: a spawn cancelled
  // in the round trip leaves its siblings' host rings and registry rows, a
  // suspended session's scrollback included, where they were (their PTYs and
  // file watchers were already stopped above). The reused id is the new
  // session's own.
  for (const sibling of siblings) {
    context.registry.delete(sibling.id);
    context.telemetry.removeSession(sibling.id);
    context.sessionFiles.removeSession(sibling.id);
    if (sibling.id !== id) {
      context.host.post({ type: 'removeSession', sessionId: sibling.id });
      context.forgetSessionGrid?.(sibling.id);
    }
  }

  if (!spawnOutcome.ok) {
    return handleSpawnFailure(spawnOutcome.error, {
      id,
      input,
      shell,
      shellExe,
      shellArgs,
      effectiveCwd,
      previousScrollback: spawnOutcome.previousScrollback,
    }, {
      registry: context.registry,
      host: context.host,
      setBufferCols: context.setBufferCols,
      emit: context.emit,
    });
  }
  const ptyProcess = spawnOutcome.pty;

  const session: ManagedSession = {
    id,
    taskId: input.taskId,
    projectId: carryoverSource?.projectId || input.projectId,
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
    lastPtyGrid: { cols: spawnCols, rows: spawnRows },
  };

  context.registry.set(id, session);
  // A queue promotion keeps its id, and its row stayed 'queued' through the
  // host round trip, so a resize that reached it meanwhile (a renderer fit, or
  // a phone's subscribe-time park) was stashed for a spawn that had already
  // read its stash. Drop it. Left in place it would outlive this PTY and,
  // after a later suspend, outrank the grid the PTY really had
  // (successorGridFor). Neither intent is lost: the 'spawn' pty-resize below
  // lets a mounted xterm re-assert its fit, and SessionManager reconsiders the
  // park once this spawn resolves.
  context.discardPendingResize?.(id);

  // The host seeded the ring at the ACTUAL spawn cols, so the first renderer
  // resize reports colsChanged truthfully: an unchanged width (PTY spawned at
  // the fitted size) reports false and skips the repaint-settle, while a
  // change from the spawn grid to the fitted one (a cold launch at the 120x30
  // default, say) reports true and arms it. Main keeps the
  // same number for that report. See PtyBufferManager.onResize.
  context.setBufferCols(id, spawnCols);
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

  // The PTY's output never reaches this process. The host runs the per-chunk
  // pipeline (the ring and headless parser, the transcript, the session-id
  // scan, stream telemetry, the redraw filter, idle detection) and sends main
  // what it needs as events; SessionManager.handleHostEvent applies them.

  // PTY exit cleanup sequence. Don't overwrite 'suspended' - suspend()
  // sets that before killing the PTY, and the new status must survive.
  const ptyExitDisposable = context.host.onPtyExit(ptyProcess.ptyId, (exitCode: number) => {
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
    // The OS code is deliberately MASKED when an override is set. Today only the
    // agent-absence sweep sets one (always 0): it force-kills a shell whose agent
    // had already exited normally, and every platform reports a force-kill as
    // abnormal - which `SessionRepository.getInterruptedExited` would then resume
    // on the next launch, resurrecting the conversation the user ended. See
    // ManagedSession.overrideExitCode.
    const resolvedExitCode = session.overrideExitCode ?? exitCode;
    session.exitCode = resolvedExitCode;
    session.pty = null;

    // Cancel the session-ID diagnostic timer but keep the scanner so
    // the scrollback fallback in suspend() can still use its buffer.
    context.sessionIdManager.clearDiagnostic(id);
    disposeAdapterAttachment(session);

    // The host flushed this session's transcript before it reported the exit.

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

    // Fallback push capture, ahead of the PR fallback below on purpose: when
    // it fires, both land on the same per-task queue, so the branch is on the
    // row before the ladder that reads it runs.
    //
    // "When it fires" is the real bound. A caller that reaches
    // `SessionManager.remove()` without awaiting exit first (the Backlog sweep,
    // project delete, MCP task delete) wipes the detector's pending entry
    // synchronously, so this reads null and emits nothing. The everyday paths
    // are unaffected: a natural `tool_end` reports the push directly, suspend
    // leaves the detector alone, and `cleanupTaskSession` awaits exit before
    // removing. `PRCommandDetector` below has the same bound.
    const pendingPushedBranch = context.telemetry.takePendingPushedBranch(id);
    if (pendingPushedBranch) {
      context.emit('branch-pushed', id, pendingPushedBranch);
    }

    // Fallback PR resolution: if a PR command was flagged (ToolStart seen) but
    // ToolEnd was never processed (event lost or never written), fire the
    // candidate now as a last resort before the session is fully closed. The
    // IPC listener runs the authoritative branch->PR query (with the scrollback
    // as a degradation fallback).
    if (context.telemetry.hasPendingPRCommand(id)) {
      context.telemetry.clearPendingPRCommand(id);
      // The ring is in the host and outlives the exit (it goes with remove()).
      void context.host.getRawScrollback(id).then(
        (scrollback) => context.emit('pr-candidate', id, scrollback),
        () => context.emit('pr-candidate', id, ''),
      );
    }

    // Dev-only: stop trace recording for this session. Files persist
    // on disk so a "Capture trace" devtool call after exit still
    // bundles them. The next attach() with the same sessionId
    // reattaches.
    traceRecorder.clearSessionDir(id);

    context.emit('exit', id, resolvedExitCode, intentional);
    context.sessionQueue.notifySlotFreed();
  });

  // Retain the exit listener's disposable so the synchronous shutdown path
  // (killAllSessions) can detach it at kill: a late exit must not run the
  // handling above after the session dir is deleted.
  session.ptyDisposables = [ptyExitDisposable];

  context.emit('session-changed', id, toSession(session));
  // Announce the grid the PTY actually spawned at. A mobile-bridge
  // subscriber that snapshotted this session while it was still queued
  // reported the pending/default dims (its subscribe parked the placeholder,
  // so normally the stashed resting grid this spawn just used); this closes
  // any gap the same way a live resize does (read-stream forwards it as a
  // terminal-resize event).
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
  //
  // These timers hold the raw ptyProcess, not session.pty, so they would
  // outlive the kill / respawn / exit paths that null session.pty (each in
  // its own tick before the 100ms fires). Every write therefore re-checks
  // that the session still owns THIS pty and tolerates node-pty throwing on
  // a just-died child; the exit path owns the cleanup either way.
  const writeIfStillOwned = (text: string): void => {
    if (session.pty !== ptyProcess) {
      traceTerminal(id, 'deferred-write-skipped', { bytes: text.length });
      return;
    }
    try {
      ptyProcess.write(text);
    } catch (error) {
      // PTY died between the timer arming and firing; nothing to deliver to.
      traceTerminal(id, 'deferred-write-failed', { bytes: text.length, message: String(error) });
    }
  };
  if (input.command || cwdFixupCommand) {
    setTimeout(() => {
      if (cwdFixupCommand) {
        writeIfStillOwned(cwdFixupCommand + '\r');
      }
      if (input.command) {
        // Non-transient (agent) spawns get the shell's own clear prefixed
        // onto the typed line, so the shell erases its startup preamble and
        // command echo at execution time - see buildSpawnClearPrelude for why
        // this beats every marker heuristic. Transient Command Terminals stay
        // a normal shell experience and skip it.
        const prelude = input.transient ? '' : buildSpawnClearPrelude(shellName);
        const cmd = prelude + adaptCommandForShell(input.command, shellName);
        if (cwdFixupCommand) {
          setTimeout(() => writeIfStillOwned(cmd + '\r'), 200);
        } else {
          writeIfStillOwned(cmd + '\r');
        }
      }
    }, 100);
  }

  return toSession(session);
}

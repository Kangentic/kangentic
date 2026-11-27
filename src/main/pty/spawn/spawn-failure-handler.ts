import type { Session, SpawnSessionInput } from '../../../shared/types';
import type { SessionRegistry, ManagedSession } from '../session-registry';
import type { PtyHostClient } from '../host/pty-host-client';
import { toSession } from '../session-registry';
import { diagnoseSpawnFailure, recordSpawnFailure, type RemoteSpawnStep } from './pty-spawn';
import { isRemoteLinkRefusal, placeTagOf, preflightTagsOf, type LaunchPlace } from '../agent-launch-report';

/**
 * Snapshot of the inputs that went into a spawn attempt - everything
 * needed to build a "failed" placeholder session and diagnose why
 * pty.spawn threw.
 */
export interface SpawnAttempt {
  id: string;
  input: SpawnSessionInput;
  shell: string;
  shellExe: string;
  effectiveCwd: string;
  /** Scrollback carried over from the previous session (or empty). */
  previousScrollback: string;
  /** For a spawn on an SSH host, the call that failed there (DESKTOP-5T). Absent for a local spawn. */
  remoteStep?: RemoteSpawnStep;
}

/**
 * Where the spawn was to run: the failed session never had a row. `shell` is the resolved one,
 * since an input that takes the default shell names none and a default WSL shell is still WSL.
 */
function placeOfAttempt(input: SpawnSessionInput, shell: string, remote: boolean): LaunchPlace {
  if (remote) return 'ssh';
  return placeTagOf({ hostId: null, cliTarget: input.cliTarget ?? null, shell });
}

export interface SpawnFailureContext {
  registry: SessionRegistry;
  host: PtyHostClient;
  /** Record the column count the failed session's ring was seeded at. */
  setBufferCols: (sessionId: string, cols: number) => void;
  emit: (event: string, ...args: unknown[]) => void;
}

/** Columns a failed session's ring is seeded at; it has no PTY to fit. */
const FAILED_SESSION_COLS = 120;

/**
 * Handle a thrown `pty.spawn()` call. The platform-specific failure
 * modes (missing shell binary, invalid cwd, posix_spawnp permission
 * issues on the embedded spawn-helper binary, a ConPTY whose output never
 * connected) are classified by `diagnoseSpawnFailure`; this module wraps
 * that with:
 *
 *   - structured log line
 *   - metric emission via recordSpawnFailure
 *   - the raw error appended to scrollback, so the terminal panel
 *     shows it instead of a blank screen
 *   - an "exited" placeholder ManagedSession registered in the
 *     session registry so the renderer renders a failed session
 *     instead of the main process crashing
 *   - a 'session-changed' announcing that row, then a synthetic
 *     'exit' event with code -1
 *
 * Returns the failed Session DTO so the caller can forward it to the
 * original spawn() promise resolution.
 */
export function handleSpawnFailure(
  err: unknown,
  attempt: SpawnAttempt,
  context: SpawnFailureContext,
): Session {
  const { id, input, shell, shellExe, effectiveCwd, previousScrollback } = attempt;
  const remote = input.remote !== undefined;
  // A remote attempt always names its step; one built without it reads as the PTY spawn.
  const remoteStep = remote ? (attempt.remoteStep ?? 'spawn') : undefined;

  const diagnostic = diagnoseSpawnFailure({
    err,
    shellExe,
    effectiveCwd,
    originalCwd: input.cwd,
    remote,
  });
  const existence = remote ? `remote_step=${remoteStep}` : `cwdExists=${diagnostic.cwdExists} shellExists=${diagnostic.shellExists}`;
  console.error(`[PTY] spawn failed session=${id.slice(0, 8)} task=${input.taskId.slice(0, 8)} shell=${shellExe} error=${diagnostic.errorMessage} errno=${diagnostic.errno} ${existence}`);
  recordSpawnFailure({
    diagnostic,
    shellExe,
    launchTags: preflightTagsOf({
      agent: input.agentName,
      agentCliVersion: input.agentCliVersion,
      startPath: input.startPath,
      place: placeOfAttempt(input, shell, remote),
    }),
    remoteLinkRefusal: isRemoteLinkRefusal(err),
    ...(remoteStep ? { remoteStep } : {}),
  });

  // Print the raw error in the terminal, whatever its shape.
  const diagnosticScrollback = previousScrollback + diagnostic.scrollbackSuffix;
  if (diagnostic.kind === 'posix-spawnp') {
    console.error(`[PTY] posix_spawnp failed for shell "${shellExe}" in "${effectiveCwd}". Likely missing +x on spawn-helper.`);
  }

  const failedSession: ManagedSession = {
    id,
    taskId: input.taskId,
    projectId: input.projectId,
    pty: null,
    status: 'exited',
    shell,
    cwd: effectiveCwd,
    commandCwd: input.cwd,
    startedAt: new Date().toISOString(),
    exitCode: -1,
    resuming: input.resuming ?? false,
    transient: input.transient ?? false,
    workflowId: input.workflowId ?? null,
    commandTerminalSlot: input.commandTerminalSlot ?? null,
    commandTerminalBranch: input.commandTerminalBranch ?? null,
    isolatedSwimlaneId: input.isolatedSwimlaneId,
    exitSequence: input.exitSequence ?? ['\x03'],
    agentParser: input.agentParser,
    permissionMode: input.permissionMode ?? null,
    startBlockedReason: input.agentParser ? 'spawn-failed' : null,
  };
  context.registry.set(id, failedSession);
  // Seed the host's ring with the diagnostic scrollback, so the failed
  // session's terminal shows it.
  context.host.post({ type: 'initSession', sessionId: id, scrollback: diagnosticScrollback, cols: FAILED_SESSION_COLS });
  context.setBufferCols(id, FAILED_SESSION_COLS);
  // Announce the row before its exit, as a spawn that started does. Both
  // arrive before the spawn call returns, so without this the renderer's
  // replica met an exit for a row it did not hold: it could not see a
  // Command Terminal was transient and toasted a crash under the raw session
  // id, and the siblings the spawn drained stayed in the replica.
  context.emit('session-changed', id, toSession(failedSession));
  context.emit('exit', id, -1);
  return toSession(failedSession);
}

import type { Session, SpawnSessionInput } from '../../../shared/types';
import type { SessionRegistry, ManagedSession } from '../session-registry';
import type { PtyBufferManager } from '../buffer/pty-buffer-manager';
import { toSession } from '../session-registry';
import { diagnoseSpawnFailure, recordSpawnFailure } from './pty-spawn';

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
  shellArgs: string[];
  effectiveCwd: string;
  /** Scrollback carried over from the previous session (or empty). */
  previousScrollback: string;
}

export interface SpawnFailureContext {
  registry: SessionRegistry;
  bufferManager: PtyBufferManager;
  emit: (event: string, ...args: unknown[]) => void;
}

/**
 * Handle a thrown `pty.spawn()` call. The platform-specific failure
 * modes (missing shell binary, invalid cwd, posix_spawnp permission
 * issues on the embedded spawn-helper binary) are classified by
 * `diagnoseSpawnFailure`; this module wraps that with:
 *
 *   - structured log line
 *   - metric emission via recordSpawnFailure
 *   - diagnostic suffix appended to scrollback so the user sees
 *     actionable guidance in the terminal panel
 *   - an "exited" placeholder ManagedSession registered in the
 *     session registry so the renderer renders a failed session
 *     instead of the main process crashing
 *   - synthetic 'exit' event with code -1
 *
 * Returns the failed Session DTO so the caller can forward it to the
 * original spawn() promise resolution.
 */
export function handleSpawnFailure(
  err: unknown,
  attempt: SpawnAttempt,
  context: SpawnFailureContext,
): Session {
  const { id, input, shell, shellExe, shellArgs, effectiveCwd, previousScrollback } = attempt;

  const diagnostic = diagnoseSpawnFailure({
    err,
    shellExe,
    effectiveCwd,
    originalCwd: input.cwd,
  });
  console.error(`[PTY] spawn failed session=${id.slice(0, 8)} task=${input.taskId.slice(0, 8)} shell=${shellExe} error=${diagnostic.errorMessage} errno=${diagnostic.errno} cwdExists=${diagnostic.cwdExists} shellExists=${diagnostic.shellExists}`);
  recordSpawnFailure({ diagnostic, shellExe, shellArgs });

  // Append actionable guidance to scrollback (empty suffix if no
  // known recipe for this error shape).
  let diagnosticScrollback = previousScrollback;
  if (diagnostic.scrollbackSuffix) {
    diagnosticScrollback += diagnostic.scrollbackSuffix;
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
    startedAt: new Date().toISOString(),
    exitCode: -1,
    resuming: input.resuming ?? false,
    transient: input.transient ?? false,
    exitSequence: input.exitSequence ?? ['\x03'],
    agentParser: input.agentParser,
  };
  context.registry.set(id, failedSession);
  // Initialize buffer manager with diagnostic scrollback for failed sessions
  context.bufferManager.initSession(id, diagnosticScrollback, 120);
  context.emit('exit', id, -1);
  return toSession(failedSession);
}

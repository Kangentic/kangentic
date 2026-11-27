/**
 * What an update of an SSH host's program (`remote/program-update.ts`) needs of this app's sessions on the
 * host: which they are, whether each is between turns, and the normal paths that stop and bring them back.
 * Kept out of `register-all.ts`, which only hands it the context.
 *
 * - A task agent is paused through `pauseTaskSession` as the system's (`suspendedBy: 'system'`, not a held
 *   pause), re-checked under its task lock, and resumed by startup recovery scoped to its record.
 * - A Command Terminal ends for a restart in its slot (`endCommandTerminalForRestart`, the account move's
 *   end), holding its slot and conversation until the new program runs, then resumes it there.
 * - A workflow's own agent is never stopped: the updater waits for it to end.
 */

import type { Session } from '../../../shared/types';
import { isCommandTerminalSession, isWorkflowAgentSession } from '../../../shared/session-owner';
import { hasMoveFollowUp, hasPendingMessageDelivery, hasTurnEndGroup } from '../../automations/turn-end/turn-end-passes';
import { hasHeldDeliveryPending } from '../../held-messages/held-messages';
import { getInFlightSpawnProgress } from '../../transition-engine/spawn-progress';
import { isUnderWorkflowRecovery } from '../../workflows/workflow-recovery-state';
import { quickSafePoint } from '../../pty/agent-safe-point';
import type { EndedTerminal, HeldRemoteSession, ProgramUpdaterDeps } from '../../remote/program-update';
import { resumeSessionsAfterProgramUpdate } from '../handlers/projects';
import { pauseTaskSession } from '../handlers/session-pause';
import { commandTerminalRestartability, endCommandTerminalForRestart } from '../handlers/transient-sessions';
import type { IpcContext } from '../ipc-context';

export type ProgramUpdateSessionDeps = Pick<
  ProgramUpdaterDeps,
  'heldSessions' | 'isAtSafePoint' | 'hasStartInFlight' | 'hasFreshDraft' | 'suspendTask' | 'terminalRestartability' | 'endTerminal' | 'endUnusedTerminal' | 'resumeTasks'
>;

function kindOf(session: Session): HeldRemoteSession['kind'] {
  if (isCommandTerminalSession(session)) return 'command-terminal';
  if (isWorkflowAgentSession(session)) return 'workflow';
  return 'task';
}

export function programUpdateSessionDeps(requireContext: () => IpcContext): ProgramUpdateSessionDeps {
  return {
    heldSessions: (hostId) => {
      const { sessionManager } = requireContext();
      return sessionManager.liveRemotePtys(hostId).flatMap((route) => {
        const session = sessionManager.getSession(route.sessionId);
        if (!session) return [];
        return [{ sessionId: session.id, taskId: session.taskId ?? null, projectId: session.projectId, kind: kindOf(session) }];
      });
    },
    isAtSafePoint: (held) => {
      const context = requireContext();
      if (quickSafePoint(context.sessionManager, held.sessionId) !== 'idle') return false;
      if (hasHeldDeliveryPending(held.sessionId, held.kind === 'task' ? held.taskId : null)) return false;
      if (held.kind !== 'task' || !held.taskId) return true;
      const taskId = held.taskId;
      // A message, a keystroke burst or a moved task's follow-up on its way; turn-end automations still
      // running (a script on the host, a Move to column); a start in flight; or a workflow recovering it.
      return !hasPendingMessageDelivery(taskId)
        && !context.terminalSubmitScheduler.hasPending(taskId)
        && !hasMoveFollowUp(taskId)
        && !hasTurnEndGroup(taskId)
        && !(taskId in getInFlightSpawnProgress())
        && !isUnderWorkflowRecovery(taskId);
    },
    // Any start on its way, here or on a host: one that passed the launch check before the hold would land
    // on the program about to exit. A start's progress label clears when it lands.
    hasStartInFlight: () => Object.keys(getInFlightSpawnProgress()).length > 0,
    hasFreshDraft: async (sessionId) => ((await requireContext().sessionManager.readPendingDraft(sessionId)) ?? '').trim() !== '',
    suspendTask: (held, stillEligible) => {
      if (!held.taskId) return Promise.resolve('not-live');
      return pauseTaskSession(requireContext(), held.taskId, {
        projectId: held.projectId,
        suspendedBy: 'system',
        // The same session, still at its safe point, once the task lock is taken.
        stillEligible: (liveSession) => liveSession.id === held.sessionId && stillEligible(),
      });
    },
    terminalRestartability: (held) => commandTerminalRestartability(requireContext(), held.sessionId),
    endUnusedTerminal: (held) => { requireContext().sessionManager.endCommandTerminal(held.sessionId); },
    endTerminal: (held, stillEligible) => {
      const ended = endCommandTerminalForRestart(requireContext(), held.sessionId, stillEligible);
      if (typeof ended === 'string') return ended;
      const terminal: EndedTerminal = {
        // On the account it ran on, resuming its conversation with nothing typed into it.
        startAgain: async () => {
          await ended.startAgain(ended.accountId ? { accountId: ended.accountId } : {});
        },
        giveUp: () => ended.giveUp(),
      };
      return terminal;
    },
    resumeTasks: (sessionIdsByProject) => resumeSessionsAfterProgramUpdate(requireContext(), sessionIdsByProject),
  };
}

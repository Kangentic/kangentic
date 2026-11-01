/**
 * Wires the low-memory pause (idle-agent-pause.ts) to the app: the live
 * sessions it chooses from, the Pause button's own path it pauses through,
 * the setting that turns it off, and the push that tells the renderer.
 *
 * Every read goes through `getContext()` at tick time, never a captured
 * context: the sampler is armed before the IPC context exists.
 */

import { IPC } from '../../shared/ipc-channels';
import type { HostMemoryAgentPausedEvent, HostMemorySample } from '../../shared/types';
import { hasPendingMessageDelivery } from '../automations/turn-end/turn-end-passes';
import { pauseTaskSession } from '../ipc/handlers/session-pause';
import { getProjectRepos } from '../ipc/helpers';
import type { IpcContext } from '../ipc/ipc-context';
import { noteWorkflowTaskPaused } from '../workflows/workflow-recovery';
import { isInWorkingWait } from '../workflows/workflow-recovery-state';
import type { OpenWork } from '../activity-engine/open-work-ledger';
import {
  createIdleAgentPauser,
  isPauseEligible,
  type IdleAgentFacts,
  type IdleAgentPaused,
  type IdleAgentPauser,
} from './idle-agent-pause';

/** Every live session's facts, as the pause decision reads them. */
export function collectIdleAgentFacts(context: IpcContext): IdleAgentFacts[] {
  const sessionManager = context.sessionManager;
  const activity = sessionManager.getActivityCache();
  const reasons = sessionManager.getActivityReasonsCache();
  const focused = sessionManager.getFocusedSessions();
  return sessionManager.listManagedSummaries().map((summary) => {
    const reason = reasons[summary.id];
    // `since` is when the agent parked: it survives a permission prompt that
    // resolves into idle, so it measures the whole wait on the user.
    const waitingSince = reason && (reason.kind === 'idle' || reason.kind === 'permission') ? reason.since : null;
    return {
      sessionId: summary.id,
      taskId: summary.taskId,
      projectId: summary.projectId,
      status: summary.status,
      transient: summary.transient,
      workflowId: summary.workflowId,
      activity: activity[summary.id],
      waitingSince,
      hasDraft: (sessionManager.getPendingDraft(summary.id) ?? '').trim() !== '',
      focused: focused.has(summary.id),
      hasPendingSubmit: context.terminalSubmitScheduler.hasPending(summary.taskId),
      hasPendingDelivery: hasPendingMessageDelivery(summary.taskId),
      hasOpenBackgroundWork: hasOpenBackgroundWork(sessionManager.getOpenWork(summary.id)),
      inWorkingWait: isInWorkingWait(summary.taskId),
    };
  });
}

/** Work the agent left running that it will come back to: a held shell, a background subagent. */
function hasOpenBackgroundWork(openWork: OpenWork): boolean {
  return openWork.backgroundShells.length > 0 || openWork.backgroundSubagents.length > 0;
}

/** The push the renderer's toast and Review list read, with the names resolved here. */
export function buildAgentPausedEvent(context: IpcContext, paused: IdleAgentPaused): HostMemoryAgentPausedEvent {
  const { taskId, projectId } = paused.facts;
  let taskTitle: string | null = null;
  try {
    taskTitle = getProjectRepos(context, projectId).tasks.getById(taskId)?.title ?? null;
  } catch {
    // A project closed in the meantime; the toast still counts the pause.
  }
  return {
    pausedAt: new Date(paused.pausedAt).toISOString(),
    taskId,
    projectId,
    taskTitle,
    projectName: context.projectRepo.getById(projectId)?.name ?? null,
    waitedMs: paused.waitedMs,
  };
}

let simulatedLowMemory = false;

/**
 * Dev only (`/preview`): read every sample as low memory, so the pause can be
 * watched without exhausting the machine. Set through `dev.simulateLowMemory`.
 */
export function setSimulatedLowMemory(on: boolean): void {
  simulatedLowMemory = on;
}

/**
 * The sample as every low-memory reader sees it: forced low while dev's
 * `dev.simulateLowMemory` is on, so the pause and the workflow's memory gate
 * read the same. Production builds drop the simulation (`__KANGENTIC_DEV__`).
 */
export function sampleAsRead(sample: HostMemorySample): HostMemorySample {
  return __KANGENTIC_DEV__ && simulatedLowMemory ? simulateLowMemorySample(sample) : sample;
}

/** The sample with this platform's reading forced low. */
export function simulateLowMemorySample(sample: HostMemorySample): HostMemorySample {
  return {
    ...sample,
    commitRemainingBytes: sample.commitLimitBytes === null ? null : 0,
    physicalAvailableBytes: sample.physicalAvailableBytes === null ? null : 0,
    swapFreeBytes: sample.swapFreeBytes === null || sample.swapFreeBytes === undefined ? sample.swapFreeBytes : 0,
    memoryPressureLevel: sample.platform === 'darwin' ? 4 : sample.memoryPressureLevel,
  };
}

export function createLowMemoryAgentPauser(getContext: () => IpcContext | null): IdleAgentPauser {
  const pauser = createIdleAgentPauser({
    isEnabled: () => getContext()?.configManager.load().agent.pauseIdleAgentsOnLowMemory ?? false,
    listCandidates: () => {
      const context = getContext();
      return context ? collectIdleAgentFacts(context) : [];
    },
    pause: async (facts) => {
      const context = getContext();
      if (!context) return false;
      const outcome = await pauseTaskSession(context, facts.taskId, {
        projectId: facts.projectId,
        // Its own source, so a restart still knows which running workflow's
        // tasks come back by themselves once memory recovers.
        suspendedBy: 'low_memory',
        // The agent may have started working, the user may have typed into
        // it, resumed it onto a new session or moved it, while this waited
        // for the task lock. Decide again on what holds now.
        stillEligible: (liveSession) => {
          if (liveSession.id !== facts.sessionId) return false;
          const current = collectIdleAgentFacts(context).find((candidate) => candidate.sessionId === facts.sessionId);
          return current !== undefined && isPauseEligible(current, Date.now());
        },
      });
      return outcome === 'paused';
    },
    onPaused: (paused) => {
      const context = getContext();
      if (!context) return;
      // A running workflow task under recovery has nobody left to nudge it:
      // its recovery stops and the user is told, window or not.
      noteWorkflowTaskPaused(context, paused.facts.taskId);
      if (context.mainWindow.isDestroyed()) return;
      context.mainWindow.webContents.send(IPC.HOST_MEMORY_AGENT_PAUSED, buildAgentPausedEvent(context, paused));
    },
  });
  return {
    onSample(sample) {
      pauser.onSample(sampleAsRead(sample));
    },
  };
}

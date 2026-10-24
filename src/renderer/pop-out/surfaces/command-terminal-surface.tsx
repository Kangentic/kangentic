import { enqueueSessionUpdate, enqueueUsage } from '../../lib/session-update-coalescer';
import { useConfigStore } from '../../stores/config-store';
import { useSessionStore } from '../../stores/session-store';
import { PopOutCommandTerminalRoot } from '../roots/PopOutCommandTerminalRoot';
import type { SurfaceDescriptor } from '../surface-registry';

/**
 * The Command Terminal panel for one project, in a window of its own.
 *
 * This renderer runs no App.tsx, so the session pushes its terminals read are
 * wired here, mapped the way App.tsx maps them for the main window: a status
 * push only upserts and a removal push only removes
 * (session-replica-contract.md). Each channel is declared in the surface's
 * `channels`, or main never fans it out to this window. The project, the first
 * session list and the agent list are loaded by the root, which mounts the
 * terminals only once all of them have landed.
 */
export const commandTerminalSurface: SurfaceDescriptor<'command-terminal'> = {
  kind: 'command-terminal',
  Root: PopOutCommandTerminalRoot,

  bootstrap: (_params, { signal }) => {
    const sessions = window.electronAPI.sessions;
    const unsubscribers = [
      sessions.onStatus((_sessionId, session) => {
        enqueueSessionUpdate(() => useSessionStore.getState().upsertSession(session));
      }),
      sessions.onRemoved((sessionId) => {
        enqueueSessionUpdate(() => useSessionStore.getState().removeSession(sessionId));
      }),
      sessions.onExit((sessionId, exitCode, _projectId, intentional) => {
        // As App.tsx: a deliberate end is followed by the push that says what
        // happened, so only an exit of its own marks the row.
        const current = useSessionStore.getState().sessions.find((session) => session.id === sessionId);
        if (intentional || current?.status === 'suspended') return;
        useSessionStore.getState().updateSessionStatus(sessionId, { status: 'exited', exitCode });
      }),
      sessions.onFirstOutput((sessionId) => {
        enqueueSessionUpdate(() => useSessionStore.getState().markFirstOutput(sessionId));
      }),
      sessions.onUsage((sessionId, data) => enqueueUsage(sessionId, data)),
      sessions.onActivity((sessionId, state, reason) => {
        enqueueSessionUpdate(() => useSessionStore.getState().updateActivity(sessionId, state, reason));
      }),
    ];
    for (const unsubscribe of unsubscribers) signal.addEventListener('abort', unsubscribe);
  },

  hmrResync: () => {
    void useSessionStore.getState().syncSessions();
    void useConfigStore.getState().loadAgentList();
  },

  inAppSurface: 'command-terminal-panel',
};

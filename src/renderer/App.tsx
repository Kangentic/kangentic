import React, { useEffect } from 'react';
import { AppLayout } from './components/layout/AppLayout';
import { useProjectStore } from './stores/project-store';
import { useBoardStore } from './stores/board-store';
import { useConfigStore } from './stores/config-store';
import { useSessionStore } from './stores/session-store';
import { useToastStore } from './stores/toast-store';
import { resolveAutoFocusTarget } from './utils/auto-focus';

export function App() {
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const loadCurrent = useProjectStore((s) => s.loadCurrent);
  const currentProject = useProjectStore((s) => s.currentProject);
  const loadBoard = useBoardStore((s) => s.loadBoard);
  const loadConfig = useConfigStore((s) => s.loadConfig);
  const detectClaude = useConfigStore((s) => s.detectClaude);
  const updateSessionStatus = useSessionStore((s) => s.updateSessionStatus);
  const updateUsage = useSessionStore((s) => s.updateUsage);
  const updateActivity = useSessionStore((s) => s.updateActivity);
  const addEvent = useSessionStore((s) => s.addEvent);

  useEffect(() => {
    loadConfig();
    detectClaude();
    loadProjects();
    // Restore the current project after a page reload (e.g. Vite HMR).
    // The main process retains currentProjectId across renderer reloads.
    loadCurrent();

    // Listen for auto-opened project (from --cwd CLI arg)
    const cleanup = window.electronAPI.projects.onAutoOpened((project) => {
      useProjectStore.setState({ currentProject: project });
      // Refresh the project list to include the auto-opened project
      loadProjects();
    });
    return cleanup;
  }, []);

  useEffect(() => {
    if (currentProject) {
      loadBoard();
      useSessionStore.getState().syncSessions().then(() => {
        useSessionStore.getState().markIdleSessionsSeen(currentProject.id);
      });
    } else {
      useBoardStore.setState({ tasks: [], swimlanes: [], archivedTasks: [] });
      useSessionStore.setState({ activeSessionId: null });
    }
  }, [currentProject]);

  // Listen for IPC session events.
  // Guard with optional chaining: during Vite HMR full reloads, the preload
  // bridge may not be fully re-injected when useEffect fires.
  useEffect(() => {
    const cleanups: (() => void)[] = [];
    const sessions = window.electronAPI?.sessions;
    if (!sessions) return;

    // Session status transitions (queued → running)
    if (sessions.onStatus) {
      cleanups.push(sessions.onStatus((sessionId, status) => {
        updateSessionStatus(sessionId, { status });
      }));
    }

    // Session exit events
    if (sessions.onExit) {
      cleanups.push(sessions.onExit((sessionId, exitCode) => {
        const currentSession = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
        if (currentSession?.status === 'suspended') return;

        updateSessionStatus(sessionId, { status: 'exited', exitCode });

        // Only show toast if exited session belongs to current project
        const activeProjectId = useProjectStore.getState().currentProject?.id;
        if (currentSession?.projectId === activeProjectId) {
          const task = useBoardStore.getState().tasks.find((t) => t.session_id === sessionId);
          const label = task ? `"${task.title}"` : sessionId.slice(0, 8);
          useToastStore.getState().addToast({
            message: `Session ended for ${label} (exit ${exitCode})`,
            variant: exitCode === 0 ? 'info' : 'warning',
          });
        }
      }));
    }

    // Session usage data
    if (sessions.onUsage) {
      cleanups.push(sessions.onUsage((sessionId, data) => {
        updateUsage(sessionId, data);
      }));
    }

    // Session activity state (thinking/idle)
    if (sessions.onActivity) {
      cleanups.push(sessions.onActivity((sessionId, state) => {
        updateActivity(sessionId, state);

        const config = useConfigStore.getState().config;
        const sessionStore = useSessionStore.getState();
        const activeProjectId = useProjectStore.getState().currentProject?.id;

        // Auto-focus: switch the bottom panel to the most recently idle session
        if (config.autoFocusIdleSession) {
          const projectSessions = sessionStore.sessions.filter((s) => s.projectId === activeProjectId);
          const target = resolveAutoFocusTarget({
            sessionId,
            newState: state,
            currentActiveSessionId: sessionStore.activeSessionId,
            sessionActivity: sessionStore.sessionActivity,
            sessions: projectSessions,
          });
          if (target !== null) {
            sessionStore.setActiveSession(target);
          }
        }

        // OS notification + taskbar flash for idle on non-active projects
        if (state === 'idle' && config.notifyIdleOnInactiveProject) {
          const session = sessionStore.sessions.find((s) => s.id === sessionId);
          if (session && session.projectId !== activeProjectId) {
            const project = useProjectStore.getState().projects.find((p) => p.id === session.projectId);
            const projectName = project?.name ?? 'A project';
            const task = useBoardStore.getState().tasks.find((t) => t.session_id === sessionId);
            const taskLabel = task?.title ?? 'A task';
            new Notification(`${projectName} — Idle`, {
              body: `${taskLabel} needs attention`,
            });
            window.electronAPI.window.flashFrame(true);
          }
        }
      }));
    }

    // Session events (tool calls, idle, prompt — activity log)
    if (sessions.onEvent) {
      cleanups.push(sessions.onEvent((sessionId, event) => {
        addEvent(sessionId, event);
      }));
    }

    // Task auto-moved (plan exit → next column)
    const tasks = window.electronAPI?.tasks;
    if (tasks?.onAutoMoved) {
      cleanups.push(tasks.onAutoMoved((_taskId, _targetSwimlaneId, taskTitle) => {
        useBoardStore.getState().loadBoard();
        useSessionStore.getState().syncSessions();
        useToastStore.getState().addToast({
          message: `Plan complete — moved "${taskTitle}" to next column`,
          variant: 'success',
        });
      }));
    }

    return () => cleanups.forEach((fn) => fn());
  }, []);

  return <AppLayout />;
}

// Dev-only: re-sync session caches after Vite HMR updates.
// When HMR replaces renderer modules, IPC listeners may briefly disconnect.
// The main process still caches all events — this re-fetches them.
// @ts-expect-error — Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
if (import.meta.hot) {
  // @ts-expect-error
  import.meta.hot.on('vite:afterUpdate', () => {
    useSessionStore.getState().syncSessions();
  });
}

// Dev-only: expose Zustand stores for UI test automation (Playwright page.evaluate).
// @ts-expect-error — Vite defines import.meta.env; tsc doesn't support it
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__zustandStores = {
    board: useBoardStore,
    session: useSessionStore,
  };
}

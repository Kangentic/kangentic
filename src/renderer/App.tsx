import React, { useEffect, useRef } from 'react';
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

  const debouncedSyncRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      // Cancel any pending debounced sync from the previous project
      if (debouncedSyncRef.current) {
        clearTimeout(debouncedSyncRef.current);
        debouncedSyncRef.current = null;
      }

      loadBoard();
      loadConfig(); // Re-fetch effective config (global + project overrides)

      // Invalidate any in-flight syncSessions() calls from the previous project
      useSessionStore.getState()._bumpSyncGeneration();

      // Clear all per-project view state before syncing -- prevents stale data
      // from the previous project leaking into the new project's terminal/events.
      // Do NOT clear sessionActivity or sessions -- sidebar badges need cross-project data.
      useSessionStore.setState({
        activeSessionId: null,
        dialogSessionId: null,
        openTaskId: null,
        sessionUsage: {},
        sessionEvents: {},
      });

      const generationBeforeSync = useSessionStore.getState()._syncGeneration;
      useSessionStore.getState().syncSessions().then(() => {
        // If project switched again while syncing, don't mark sessions seen
        if (useSessionStore.getState()._syncGeneration !== generationBeforeSync) {
          useSessionStore.getState().setPendingOpenTaskId(null);
          return;
        }
        useSessionStore.getState().markIdleSessionsSeen(currentProject.id);

        // Open task detail dialog if a notification click set a pending task ID
        const pendingTaskId = useSessionStore.getState()._pendingOpenTaskId;
        if (pendingTaskId) {
          useSessionStore.getState().setPendingOpenTaskId(null);
          useSessionStore.getState().setOpenTaskId(pendingTaskId);
        }
      });
    } else {
      useBoardStore.setState({ tasks: [], swimlanes: [], archivedTasks: [] });
      useSessionStore.setState({
        activeSessionId: null,
        dialogSessionId: null,
        openTaskId: null,
      });
    }
  }, [currentProject]);

  // Listen for IPC session events.
  // Guard with optional chaining: during Vite HMR full reloads, the preload
  // bridge may not be fully re-injected when useEffect fires.
  useEffect(() => {
    const cleanups: (() => void)[] = [];
    const sessions = window.electronAPI?.sessions;
    if (!sessions) return;

    // Debounced re-sync: when an IPC event arrives for a session ID not yet in
    // the store (e.g. background sessions spawned by activateAllProjects before
    // the renderer had a chance to sync), schedule a full syncSessions() call.
    // Not project-scoped: syncSessions() fetches all sessions cross-project,
    // and sidebar badges need background project sessions to appear immediately.
    const scheduleSyncIfUnknown = (sessionId: string) => {
      const exists = useSessionStore.getState().sessions.some((s) => s.id === sessionId);
      if (exists) return;
      if (debouncedSyncRef.current) clearTimeout(debouncedSyncRef.current);
      debouncedSyncRef.current = setTimeout(() => {
        useSessionStore.getState().syncSessions();
        debouncedSyncRef.current = null;
      }, 300);
    };

    // Session status transitions (queued → running)
    if (sessions.onStatus) {
      cleanups.push(sessions.onStatus((sessionId, status) => {
        scheduleSyncIfUnknown(sessionId);
        updateSessionStatus(sessionId, { status });
      }));
    }

    // Session exit events
    if (sessions.onExit) {
      cleanups.push(sessions.onExit((sessionId, exitCode, projectId) => {
        const currentSession = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
        if (currentSession?.status === 'suspended') return;

        updateSessionStatus(sessionId, { status: 'exited', exitCode });

        // Only show toast if exited session belongs to current project
        const activeProjectId = useProjectStore.getState().currentProject?.id;
        if ((projectId ?? currentSession?.projectId) === activeProjectId) {
          const task = useBoardStore.getState().tasks.find((t) => t.session_id === sessionId)
            ?? useBoardStore.getState().tasks.find((t) => t.id === currentSession?.taskId);
          const label = task ? `"${task.title}"` : sessionId.slice(0, 8);
          useToastStore.getState().addToast({
            message: `Session ended for ${label} (exit ${exitCode})`,
            variant: exitCode === 0 ? 'info' : 'warning',
          });
        }
      }));
    }

    // Session usage data -- only update store for current project sessions
    if (sessions.onUsage) {
      cleanups.push(sessions.onUsage((sessionId, data, projectId) => {
        const activeProjectId = useProjectStore.getState().currentProject?.id;
        if (!projectId || !activeProjectId || projectId === activeProjectId) {
          updateUsage(sessionId, data);
        }
      }));
    }

    // Session activity state (thinking/idle)
    // ALWAYS update activity (sidebar badges need cross-project data),
    // but only run auto-focus for current project.
    if (sessions.onActivity) {
      cleanups.push(sessions.onActivity((sessionId, state, projectId, taskId, taskTitle) => {
        updateActivity(sessionId, state);

        const activeProjectId = useProjectStore.getState().currentProject?.id;
        const isCurrentProject = !projectId || !activeProjectId || projectId === activeProjectId;

        scheduleSyncIfUnknown(sessionId);

        const config = useConfigStore.getState().config;
        const sessionStore = useSessionStore.getState();

        // Auto-focus: switch the bottom panel to the most recently idle session
        // (only for current project sessions)
        if (isCurrentProject && config.autoFocusIdleSession) {
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
            const notificationTaskTitle = taskTitle ?? 'A task';
            window.electronAPI.notifications.show({
              title: `${projectName} -- Idle`,
              body: `${notificationTaskTitle} needs attention`,
              projectId: session.projectId,
              taskId: taskId ?? '',
            });
            window.electronAPI.window.flashFrame(true);
          }
        }
      }));
    }

    // Session events (tool calls, idle, prompt -- activity log)
    // Only add events for current project sessions
    if (sessions.onEvent) {
      cleanups.push(sessions.onEvent((sessionId, event, projectId) => {
        const activeProjectId = useProjectStore.getState().currentProject?.id;
        if (!projectId || !activeProjectId || projectId === activeProjectId) {
          addEvent(sessionId, event);
        }
      }));
    }

    // Notification clicked -- switch project and open task detail
    const notifications = window.electronAPI?.notifications;
    if (notifications?.onClicked) {
      cleanups.push(notifications.onClicked((projectId, taskId) => {
        const alreadyActive = useProjectStore.getState().currentProject?.id === projectId;
        if (taskId && alreadyActive) {
          useSessionStore.getState().setOpenTaskId(taskId);
        } else {
          if (taskId) {
            useSessionStore.getState().setPendingOpenTaskId(taskId);
          }
          useProjectStore.getState().openProject(projectId);
        }
      }));
    }

    // Task auto-moved (plan exit → next column)
    const tasks = window.electronAPI?.tasks;
    if (tasks?.onAutoMoved) {
      cleanups.push(tasks.onAutoMoved((_taskId, _targetSwimlaneId, taskTitle) => {
        useBoardStore.getState().loadBoard();
        useSessionStore.getState().syncSessions();
        useToastStore.getState().addToast({
          message: `Plan complete -- moved "${taskTitle}" to next column`,
          variant: 'success',
        });
      }));
    }

    return () => {
      cleanups.forEach((fn) => fn());
      if (debouncedSyncRef.current) clearTimeout(debouncedSyncRef.current);
    };
  }, []);

  return <AppLayout />;
}

// Dev-only: re-sync session caches after Vite HMR updates.
// When HMR replaces renderer modules, IPC listeners may briefly disconnect.
// The main process still caches all events -- this re-fetches them.
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
if (import.meta.hot) {
  // @ts-expect-error
  import.meta.hot.on('vite:afterUpdate', () => {
    useSessionStore.getState().syncSessions();
  });
}

// Dev-only: expose Zustand stores for UI test automation (Playwright page.evaluate).
// @ts-expect-error -- Vite defines import.meta.env; tsc doesn't support it
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__zustandStores = {
    board: useBoardStore,
    session: useSessionStore,
  };
}

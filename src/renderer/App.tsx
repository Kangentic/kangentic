import { useEffect } from 'react';
import { AppLayout } from './components/layout/AppLayout';
import { useProjectStore } from './stores/project-store';
import { useBoardStore } from './stores/board-store';
import { useConfigStore } from './stores/config-store';
import { useSessionStore, cancelSync } from './stores/session-store';
import { useBacklogStore } from './stores/backlog-store';
import { useToastStore } from './stores/toast-store';
import { resolveAutoFocusTarget } from './utils/auto-focus';
import type { SessionEvent } from '../shared/types';

export function App() {
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const loadCurrent = useProjectStore((s) => s.loadCurrent);
  const currentProject = useProjectStore((s) => s.currentProject);
  const loadBoard = useBoardStore((s) => s.loadBoard);
  const loadConfig = useConfigStore((s) => s.loadConfig);
  const loadAppVersion = useConfigStore((s) => s.loadAppVersion);
  const detectClaude = useConfigStore((s) => s.detectClaude);
  const detectGit = useConfigStore((s) => s.detectGit);
  const upsertSession = useSessionStore((s) => s.upsertSession);
  const updateSessionStatus = useSessionStore((s) => s.updateSessionStatus);
  const updateUsage = useSessionStore((s) => s.updateUsage);
  const updateActivity = useSessionStore((s) => s.updateActivity);
  const addEvent = useSessionStore((s) => s.addEvent);

  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') {
      performance.mark('renderer-mount-start');
    }
    loadConfig();
    loadAppVersion();
    detectClaude();
    detectGit();
    loadProjects();
    useProjectStore.getState().loadGroups();
    // Restore the current project after a page reload (e.g. Vite HMR).
    // The main process retains currentProjectId across renderer reloads.
    loadCurrent();

    // Measure after first paint via requestAnimationFrame
    let mountTimerRafId: number | undefined;
    if (process.env.NODE_ENV !== 'production') {
      mountTimerRafId = requestAnimationFrame(() => {
        performance.mark('renderer-mount-end');
        const measure = performance.measure('[renderer] mount', 'renderer-mount-start', 'renderer-mount-end');
        console.log(`[renderer] mount: ${measure.duration.toFixed(0)}ms`);
      });
    }

    // Listen for auto-opened project (from --cwd CLI arg)
    const cleanupAutoOpen = window.electronAPI.projects.onAutoOpened((project) => {
      useProjectStore.setState({ currentProject: project });
      // Refresh the project list to include the auto-opened project
      loadProjects();
    });

    // Listen for auto-update downloaded notification
    const cleanupUpdateListener = window.electronAPI.updater?.onUpdateDownloaded((info) => {
      useToastStore.getState().addToast({
        message: `Version ${info.version} is ready to install`,
        variant: 'info',
        duration: 0, // persistent -- user must act or dismiss
        action: {
          label: 'Restart to update',
          onClick: () => window.electronAPI.updater.installUpdate(),
        },
      });
    });

    return () => {
      if (mountTimerRafId !== undefined) cancelAnimationFrame(mountTimerRafId);
      cleanupAutoOpen();
      cleanupUpdateListener?.();
    };
  }, []);

  useEffect(() => {
    if (currentProject) {
      loadBoard();
      useBacklogStore.getState().loadBacklog();
      loadConfig(); // Re-fetch effective config (global + project overrides)
      useBoardStore.getState().setSearchQuery(''); // Clear search on project switch

      // Invalidate any in-flight syncSessions() calls from the previous project
      cancelSync();

      // Clear all per-project view state before syncing -- prevents stale data
      // from the previous project leaking into the new project's terminal/events.
      // Do NOT clear sessionActivity or sessions -- sidebar badges need cross-project data.
      // Do NOT clear sessionUsage -- eagerly clearing causes a flash-to-0% on HMR
      // remount. Stale keys from the old project are harmless (components only
      // render current-project sessions) and get replaced by syncSessions().
      // Preserve sessionEvents for stashed transient sessions (they have no DB backup).
      const currentSessionState = useSessionStore.getState();
      const stashedTransientSessionIds = new Set(
        Object.values(currentSessionState.transientSessions)
          .map((entry) => entry.sessionId),
      );
      const preservedEvents: Record<string, SessionEvent[]> = {};
      for (const [sessionId, events] of Object.entries(currentSessionState.sessionEvents)) {
        if (stashedTransientSessionIds.has(sessionId)) {
          preservedEvents[sessionId] = events;
        }
      }
      useSessionStore.setState({
        activeSessionId: null,
        dialogSessionId: null,
        detailTaskId: null,
        sessionEvents: preservedEvents,
      });

      useSessionStore.getState().syncSessions().then((applied) => {
        // If project switched again while syncing, don't mark sessions seen
        if (!applied) {
          useSessionStore.getState().setPendingOpenTaskId(null);
          return;
        }
        useSessionStore.getState().markIdleSessionsSeen(currentProject.id);

        // Open task detail dialog if a notification click set a pending task ID
        const pendingTaskId = useSessionStore.getState()._pendingOpenTaskId;
        if (pendingTaskId) {
          useSessionStore.getState().setPendingOpenTaskId(null);
          useSessionStore.getState().setDetailTaskId(pendingTaskId);
        }
      });
    } else {
      useBoardStore.setState({ tasks: [], swimlanes: [], archivedTasks: [] });
      useSessionStore.setState({
        activeSessionId: null,
        dialogSessionId: null,
        detailTaskId: null,
      });
      loadConfig(); // Reset effective config to global defaults (no project overrides)
    }
  }, [currentProject]);

  // Listen for IPC session events.
  // Guard with optional chaining: during Vite HMR full reloads, the preload
  // bridge may not be fully re-injected when useEffect fires.
  useEffect(() => {
    const cleanups: (() => void)[] = [];
    const sessions = window.electronAPI?.sessions;
    if (!sessions) return;

    // Session changed (queued, running, suspended) - push full Session object
    if (sessions.onStatus) {
      cleanups.push(sessions.onStatus((sessionId, session) => {
        upsertSession(session);
      }));
    }

    // Notification helpers -- shared by idle, exit, and auto-move handlers.
    const notificationCooldowns = new Map<string, number>();

    async function shouldNotify(key: string, sessionProjectId: string): Promise<boolean> {
      const notifyConfig = useConfigStore.getState().config;
      const cooldownMs = notifyConfig.notifications.cooldownSeconds * 1000;

      const lastNotified = notificationCooldowns.get(key) ?? 0;
      if (Date.now() - lastNotified < cooldownMs) return false;

      const focused = await window.electronAPI.window.isFocused();
      const activeProjectId = useProjectStore.getState().currentProject?.id;
      // Skip if window focused AND viewing the session's project
      if (focused && sessionProjectId === activeProjectId) return false;

      return true;
    }

    function sendNotification(key: string, title: string, body: string, notifyProjectId: string, notifyTaskId: string) {
      notificationCooldowns.set(key, Date.now());
      window.electronAPI.notifications.show({ title, body, projectId: notifyProjectId, taskId: notifyTaskId });
      window.electronAPI.window.flashFrame(true);
    }

    // Session exit events
    if (sessions.onExit) {
      cleanups.push(sessions.onExit((sessionId, exitCode, projectId) => {
        const currentSession = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
        if (currentSession?.status === 'suspended') return;

        // Transient sessions (command terminal) are ephemeral - skip toasts and notifications
        if (currentSession?.transient) {
          updateSessionStatus(sessionId, { status: 'exited', exitCode });
          const sessionState = useSessionStore.getState();
          if (sessionState.transientSessionId === sessionId) {
            // Current project's transient session - use existing clear
            sessionState.clearTransientSession();
          } else {
            // Stashed transient session from another project - remove from map
            const updatedTransientSessions = { ...sessionState.transientSessions };
            for (const [entryProjectId, entry] of Object.entries(updatedTransientSessions)) {
              if (entry.sessionId === sessionId) {
                delete updatedTransientSessions[entryProjectId];
                break;
              }
            }
            useSessionStore.setState({ transientSessions: updatedTransientSessions });
          }
          return;
        }

        updateSessionStatus(sessionId, { status: 'exited', exitCode });

        const notifyConfig = useConfigStore.getState().config.notifications;

        // Only show toast if exited session belongs to current project
        const activeProjectId = useProjectStore.getState().currentProject?.id;
        if ((projectId ?? currentSession?.projectId) === activeProjectId) {
          if (notifyConfig.toasts.onAgentCrash) {
            const task = useBoardStore.getState().tasks.find((t) => t.session_id === sessionId)
              ?? useBoardStore.getState().tasks.find((t) => t.id === currentSession?.taskId);
            const label = task ? `"${task.title}"` : sessionId.slice(0, 8);
            useToastStore.getState().addToast({
              message: `Session ended for ${label} (exit ${exitCode})`,
              variant: exitCode === 0 ? 'info' : 'warning',
            });
          }
        }

        // Desktop notification for non-zero exit on non-visible projects
        if (exitCode !== 0 && notifyConfig.desktop.onAgentCrash) {
          const resolvedProjectId = projectId ?? currentSession?.projectId;
          if (resolvedProjectId) {
            shouldNotify(sessionId, resolvedProjectId).then((notify) => {
              if (!notify) return;
              const project = useProjectStore.getState().projects.find((p) => p.id === resolvedProjectId);
              const task = useBoardStore.getState().tasks.find((t) => t.session_id === sessionId)
                ?? useBoardStore.getState().tasks.find((t) => t.id === currentSession?.taskId);
              const label = task?.title ?? sessionId.slice(0, 8);
              sendNotification(sessionId, `Session crashed: ${label}`, project?.name ?? 'A project', resolvedProjectId, task?.id ?? '');
            });
          }
        }
      }));
    }

    // Session first output (alternate screen buffer detected) -- lifts shimmer early
    if (sessions.onFirstOutput) {
      cleanups.push(sessions.onFirstOutput((sessionId) => {
        useSessionStore.getState().markFirstOutput(sessionId);
      }));
    }

    // Session usage data -- only update store for current project sessions
    // Transient sessions (command terminal) always pass through regardless of projectId
    if (sessions.onUsage) {
      cleanups.push(sessions.onUsage((sessionId, data, projectId) => {
        const activeProjectId = useProjectStore.getState().currentProject?.id;
        const sessionState = useSessionStore.getState();
        // Accept usage from the current transient session or any stashed transient session
        const isTransient = sessionId === sessionState.transientSessionId
          || Object.values(sessionState.transientSessions).some((entry) => entry.sessionId === sessionId);
        if (isTransient || !projectId || !activeProjectId || projectId === activeProjectId) {
          updateUsage(sessionId, data);
        }
      }));
    }

    // Session activity state (thinking/idle)
    // ALWAYS update activity (sidebar badges need cross-project data),
    // but only run auto-focus for current project.
    if (sessions.onActivity) {
      cleanups.push(sessions.onActivity((sessionId, state, projectId, taskId, taskTitle, isPermission) => {
        updateActivity(sessionId, state);

        const activeProjectId = useProjectStore.getState().currentProject?.id;
        const isCurrentProject = !projectId || !activeProjectId || projectId === activeProjectId;

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
            dialogSessionId: sessionStore.dialogSessionId,
            sessionActivity: sessionStore.sessionActivity,
            sessions: projectSessions,
          });
          if (target !== null) {
            sessionStore.setActiveSession(target);
          }
        }

        // OS notification + taskbar flash for idle sessions not visible to the user
        if (state === 'idle') {
          const notifyConfig = useConfigStore.getState().config.notifications;
          if (notifyConfig.desktop.onAgentIdle) {
            const session = sessionStore.sessions.find((s) => s.id === sessionId);
            if (session) {
              shouldNotify(sessionId, session.projectId).then((notify) => {
                if (!notify) return;
                const project = useProjectStore.getState().projects.find((p) => p.id === session.projectId);
                const projectName = project?.name ?? 'A project';
                const label = taskTitle ?? 'A task';
                const body = isPermission ? `Needs permission: ${projectName}` : projectName;
                sendNotification(sessionId, label, body, session.projectId, taskId ?? '');
              });
            }
          }
        }
      }));
    }

    // Idle timeout -- session auto-suspended after N minutes idle
    if (sessions.onIdleTimeout) {
      cleanups.push(sessions.onIdleTimeout((sessionId, timeoutTaskId, timeoutMinutes, timeoutProjectId) => {
        updateSessionStatus(sessionId, { status: 'suspended' });
        const activeProjectId = useProjectStore.getState().currentProject?.id;
        if ((timeoutProjectId ?? '') === activeProjectId) {
          const task = useBoardStore.getState().tasks.find((t) => t.id === timeoutTaskId);
          const label = task ? `"${task.title}"` : sessionId.slice(0, 8);
          useToastStore.getState().addToast({
            message: `Session suspended after ${timeoutMinutes} minutes idle: ${label}`,
            variant: 'info',
          });
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
          useSessionStore.getState().setDetailTaskId(taskId);
        } else {
          if (taskId) {
            useSessionStore.getState().setPendingOpenTaskId(taskId);
          }
          useProjectStore.getState().openProject(projectId);
        }
      }));
    }

    // Board config changed (kangentic.json file watch -- active project only)
    const boardConfig = window.electronAPI?.boardConfig;
    if (boardConfig?.onChanged) {
      cleanups.push(boardConfig.onChanged((changedProjectId) => {
        if (useConfigStore.getState().config.skipBoardConfigConfirm) {
          useBoardStore.getState().setPendingConfigChange(changedProjectId);
          useBoardStore.getState().applyConfigChange();
        } else {
          useBoardStore.getState().setPendingConfigChange(changedProjectId);
        }
      }));
    }
    if (boardConfig?.onShortcutsChanged) {
      cleanups.push(boardConfig.onShortcutsChanged(() => {
        useBoardStore.getState().loadShortcuts();
      }));
    }

    // Task created by agent (MCP server)
    const tasks = window.electronAPI?.tasks;
    if (tasks?.onCreatedByAgent) {
      cleanups.push(tasks.onCreatedByAgent((_taskId, taskTitle, columnName, createdByAgentProjectId) => {
        const activeProjectId = useProjectStore.getState().currentProject?.id;
        if (!createdByAgentProjectId || createdByAgentProjectId === activeProjectId) {
          useBoardStore.getState().loadBoard();
          useBacklogStore.getState().loadBacklog();
        }
        useToastStore.getState().addToast({
          message: `Task created by agent: "${taskTitle}" in ${columnName}`,
          variant: 'success',
        });
      }));
    }

    // Task updated by agent (MCP server)
    if (tasks?.onUpdatedByAgent) {
      cleanups.push(tasks.onUpdatedByAgent((_taskId, taskTitle, updatedByAgentProjectId) => {
        const activeProjectId = useProjectStore.getState().currentProject?.id;
        if (!updatedByAgentProjectId || updatedByAgentProjectId === activeProjectId) {
          useBoardStore.getState().loadBoard();
        }
        useToastStore.getState().addToast({
          message: `Task updated by agent: "${taskTitle}"`,
          variant: 'info',
        });
      }));
    }

    // Backlog changed by agent (MCP server created/promoted backlog tasks)
    const backlog = window.electronAPI?.backlog;
    if (backlog?.onChangedByAgent) {
      cleanups.push(backlog.onChangedByAgent((changedProjectId) => {
        const activeProjectId = useProjectStore.getState().currentProject?.id;
        if (!changedProjectId || changedProjectId === activeProjectId) {
          useBacklogStore.getState().loadBacklog();
        }
      }));
    }

    // Label colors changed by agent (MCP server created labels with colors)
    if (backlog?.onLabelColorsChanged) {
      cleanups.push(backlog.onLabelColorsChanged(() => {
        useConfigStore.getState().loadConfig();
      }));
    }

    // Task auto-moved (plan exit → next column)
    if (tasks?.onAutoMoved) {
      cleanups.push(tasks.onAutoMoved((autoMovedTaskId, _targetSwimlaneId, taskTitle, autoMoveProjectId) => {
        useBoardStore.getState().loadBoard();

        const notifyConfig = useConfigStore.getState().config.notifications;
        if (notifyConfig.toasts.onPlanComplete) {
          useToastStore.getState().addToast({
            message: `Plan complete. Moved "${taskTitle}" to next column`,
            variant: 'success',
          });
        }

        // Desktop notification for auto-moves on non-visible projects
        if (autoMoveProjectId && notifyConfig.desktop.onPlanComplete) {
          shouldNotify(`automove:${autoMovedTaskId}`, autoMoveProjectId).then((notify) => {
            if (!notify) return;
            const project = useProjectStore.getState().projects.find((p) => p.id === autoMoveProjectId);
            sendNotification(`automove:${autoMovedTaskId}`, `Plan complete: ${taskTitle}`, project?.name ?? 'A project', autoMoveProjectId, autoMovedTaskId);
          });
        }
      }));
    }

    return () => {
      cleanups.forEach((fn) => fn());
    };
  }, [upsertSession, updateSessionStatus, updateUsage, updateActivity, addEvent]);

  return <AppLayout />;
}

// Dev-only: re-sync all IPC-backed Zustand stores after Vite HMR updates.
// When HMR replaces a module, its Zustand store reverts to defaults (e.g.
// config resets to DEFAULT_CONFIG, projects list empties). Re-fetching from the
// main process restores the correct state.
//
// IMPORTANT: If you add a new IPC-backed store, add its load/sync call here.
// The unit test "hmr-resync.test.ts" will fail if you forget.
//
// Order matters: projects first (restores currentProject), then config/board
// (which depend on having a current project), then sessions last.
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
if (import.meta.hot) {
  // @ts-expect-error Vite HMR API not typed under commonjs module resolution
  import.meta.hot.on('vite:afterUpdate', () => {
    useProjectStore.getState().loadProjects();
    useProjectStore.getState().loadGroups();
    useProjectStore.getState().loadCurrent();
    useConfigStore.getState().loadConfig();
    useBoardStore.getState().loadBoard();
    useBacklogStore.getState().loadBacklog();
    useSessionStore.getState().syncSessions();
  });
}

// Dev-only: expose Zustand stores for UI test automation (Playwright page.evaluate).
// @ts-expect-error -- Vite defines import.meta.env; tsc doesn't support it
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__zustandStores = {
    board: useBoardStore,
    config: useConfigStore,
    project: useProjectStore,
    session: useSessionStore,
  };
}

import { useEffect } from 'react';
import { AppLayout } from './components/layout/AppLayout';
import { ActivityDebugOverlay } from './components/debug/ActivityDebugOverlay';
import { DevtoolsBootstrap } from '../devtools/renderer/install';
import { TestHarness } from '../devtools/renderer/TestHarness';
import { useProjectStore } from './stores/project-store';
import { useBoardStore } from './stores/board-store';
import { useConfigStore } from './stores/config-store';
import { useSessionStore } from './stores/session-store';
import { useBacklogStore } from './stores/backlog-store';
import { useToastStore } from './stores/toast-store';
import { useProjectSwitchEffect } from './hooks/useProjectSwitchEffect';
import { useAgentDrivenInvalidation } from './hooks/useAgentDrivenInvalidation';
import { invalidateProject } from './stores/project-cache';
import { resolveAutoFocusTarget } from './utils/auto-focus';
import { requiresUserInteraction } from '../shared/activity-state';
import { bumpHmrGeneration } from './utils/hmr-generation';
import { clearSnapPreviewDom } from './window-manager';
import {
  autoNameTimers,
  scheduleAutoNameSuggestion,
  maybeLabelTransientSession,
} from './lib/auto-name-scheduler';
import {
  enqueueUsage,
  enqueueEvent,
  enqueueSessionUpdate,
  enqueueReload,
  resetCoalescerForHmr,
} from './lib/session-update-coalescer';

/** Sentinel taskId used in notification round-trips for transient (Command Terminal)
 *  sessions, which have no associated task. The click handler routes this value
 *  through `setPendingOpenCommandTerminal` instead of opening a task detail dialog. */
const COMMAND_TERMINAL_NOTIFICATION_TASK_ID = '__command_terminal__';

export function App() {
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const loadCurrent = useProjectStore((s) => s.loadCurrent);
  const currentProject = useProjectStore((s) => s.currentProject);
  const loadConfig = useConfigStore((s) => s.loadConfig);
  const loadAppVersion = useConfigStore((s) => s.loadAppVersion);
  const detectAgent = useConfigStore((s) => s.detectAgent);
  const loadAgentList = useConfigStore((s) => s.loadAgentList);
  const detectGit = useConfigStore((s) => s.detectGit);
  const upsertSession = useSessionStore((s) => s.upsertSession);
  const updateSessionStatus = useSessionStore((s) => s.updateSessionStatus);
  const updateActivity = useSessionStore((s) => s.updateActivity);

  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') {
      performance.mark('renderer-mount-start');
    }
    loadConfig();
    loadAppVersion();
    detectAgent();
    loadAgentList();
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

    // Last-opened project's folder vanished at startup (moved or renamed on
    // disk): show the "Project Folder Not Found" dialog. Optional chaining:
    // during Vite HMR full reloads the preload bridge may predate this method.
    const cleanupPathMissing = window.electronAPI.projects.onPathMissing?.((project) => {
      useProjectStore.setState({ missingPathProject: project });
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
      cleanupPathMissing?.();
      cleanupUpdateListener?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only bootstrap: every callee is a stable Zustand action or an IPC listener registered exactly once
  }, []);

  // Owns the warm-switch cache lifecycle. See
  // hooks/useProjectSwitchEffect.ts and stores/project-cache.ts.
  useProjectSwitchEffect(currentProject);

  // Subscribes to agent-driven board/backlog/swimlane/label-color
  // pushes. Each listener either schedules a debounced reload (current
  // project) or invalidates the warm-switch cache (background project).
  // See hooks/useAgentDrivenInvalidation.ts.
  useAgentDrivenInvalidation();

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
        // Deferred through the coalescer: held during an active board drag so
        // a spawning session's status flip doesn't re-render a sortable card
        // mid-drag. Wrapped whole so the (currently side-effect-free) write and
        // auto-name scheduling stay in arrival order with the other handlers.
        enqueueSessionUpdate(() => {
          upsertSession(session);
          scheduleAutoNameSuggestion(session);
        });
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

    // Spawn-stall watcher: when a task sits in a "preparing" spawn-progress
    // state (worktree creation / git fetch / queue wait) past the threshold,
    // surface a non-blocking toast (with a Cancel action) and an optional
    // desktop notification so a slow/head-of-line-blocked spawn never hangs
    // silently. Timers are effect-scoped (like notificationCooldowns above), so
    // they tear down with the effect on unmount/HMR - no module-scope state.
    const STALL_THRESHOLD_MS = 8000;
    const spawnStallTimers = new Map<string, ReturnType<typeof setTimeout>>();
    // Toast id per task so the stall toast can be dismissed when the spawn
    // resolves or is superseded - this also prevents a stale Cancel from
    // aborting a newer move for the same task.
    const spawnStallToastIds = new Map<string, string>();

    function maybeNotifySpawnStall(taskId: string) {
      // The spawn may have finished between arming and firing.
      const label = useSessionStore.getState().spawnProgress[taskId];
      if (!label) return;

      // spawnProgress is a global map keyed by taskId; only surface a stall for
      // a task on the currently-open project's board. A task missing here
      // belongs to a background project - filing it under the active project
      // would mislabel it (the exit/idle handlers gate the same way).
      const task = useBoardStore.getState().tasks.find((candidateTask) => candidateTask.id === taskId);
      if (!task) return;

      const projectId = useProjectStore.getState().currentProject?.id ?? '';
      const notifyConfig = useConfigStore.getState().config.notifications;
      // The 8s timer arms for any preparing label, so describe the actual cause
      // rather than always claiming a git-queue wait. A git-queue wait is either
      // the bare fallback ("Waiting...", "Waiting (2 ahead)") or the running form
      // that ends in a "(waiting 45s)" qualifier; both collapse to one phrase.
      const isGitQueueWait = label.startsWith('Waiting') || /\(waiting \d+s\)$/.test(label);
      const detail = isGitQueueWait
        ? 'waiting on the git queue'
        : label.replace(/\.\.\.$/, '').toLowerCase();

      if (notifyConfig.toasts.onSpawnStalled) {
        const toastId = useToastStore.getState().addToast({
          message: `"${task.title}" is still preparing - ${detail}`,
          variant: 'warning',
          duration: 0, // sticky: the Cancel action must outlive the default auto-dismiss
          action: {
            label: 'Cancel',
            onClick: () => { window.electronAPI.tasks.cancelSpawn(taskId); },
          },
        });
        spawnStallToastIds.set(taskId, toastId);
      }

      if (notifyConfig.desktop.onSpawnStalled && projectId) {
        shouldNotify(`spawnstall:${taskId}`, projectId).then((notify) => {
          if (!notify) return;
          const project = useProjectStore.getState().projects.find((candidateProject) => candidateProject.id === projectId);
          sendNotification(
            `spawnstall:${taskId}`,
            `Still preparing: ${task.title}`,
            project?.name ?? 'A project',
            projectId,
            taskId,
          );
        });
      }
    }

    const unsubscribeSpawnStall = useSessionStore.subscribe((state, prevState) => {
      if (state.spawnProgress === prevState.spawnProgress) return;
      const current = state.spawnProgress;
      const previous = prevState.spawnProgress;
      // Arm when a task newly enters spawnProgress. Do NOT re-arm on a label
      // change (e.g. waiting -> fetching); the threshold measures total
      // continuous preparing time, not time-in-current-phase.
      for (const taskId of Object.keys(current)) {
        if (!(taskId in previous) && !spawnStallTimers.has(taskId)) {
          spawnStallTimers.set(taskId, setTimeout(() => {
            spawnStallTimers.delete(taskId);
            maybeNotifySpawnStall(taskId);
          }, STALL_THRESHOLD_MS));
        }
      }
      // Disarm when a task leaves spawnProgress (session arrived, abort, or
      // moved to To Do). Also dismiss any stall toast so its now-stale Cancel
      // can't abort a newer move for the same task, and the sticky toast for a
      // resolved spawn doesn't linger.
      for (const taskId of Object.keys(previous)) {
        if (!(taskId in current)) {
          const timer = spawnStallTimers.get(taskId);
          if (timer) { clearTimeout(timer); spawnStallTimers.delete(taskId); }
          const toastId = spawnStallToastIds.get(taskId);
          if (toastId) { useToastStore.getState().dismissToast(toastId); spawnStallToastIds.delete(taskId); }
        }
      }
    });
    cleanups.push(() => {
      unsubscribeSpawnStall();
      for (const timer of spawnStallTimers.values()) clearTimeout(timer);
      spawnStallTimers.clear();
      spawnStallToastIds.clear();
    });

    // Session exit events
    if (sessions.onExit) {
      cleanups.push(sessions.onExit((sessionId, exitCode, projectId, intentional) => {
        const currentSession = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
        const exitedTaskId = currentSession?.taskId;
        if (exitedTaskId) {
          const timer = autoNameTimers.get(exitedTaskId);
          if (timer) {
            clearTimeout(timer);
            autoNameTimers.delete(exitedTaskId);
          }
        }
        // `intentional` is set by the main process when the session was ended
        // deliberately, so a non-zero force-kill exit is not a crash. It covers
        // both suspend()-based ends (move-to-Done, isolated switch, settings
        // restart, idle auto-suspend, user Suspend) and kill()-based hard-reset
        // teardown (move-to-To-Do reset, task delete, move-to-Backlog).
        // SESSION_EXIT can arrive before the suspended SESSION_STATUS updates the
        // store, so the store-status check alone races; the flag rides the exit
        // event itself, so it is race-proof. The store check stays as a
        // defense-in-depth fallback. See session-spawn-flow.ts onExit.
        if (intentional || currentSession?.status === 'suspended') return;

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

        // Refresh period stats after metrics are persisted (slight delay for DB write)
        if (useSessionStore.getState().selectedPeriod !== 'live') {
          setTimeout(() => useSessionStore.getState().fetchPeriodStats(), 1000);
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
        enqueueSessionUpdate(() => {
          useSessionStore.getState().markFirstOutput(sessionId);
        });
      }));
    }

    // Session usage data -- only update store for current project sessions
    // Transient sessions (command terminal) always pass through regardless of projectId
    // Batched via microtask to coalesce rapid updates from multiple sessions
    if (sessions.onUsage) {
      cleanups.push(sessions.onUsage((sessionId, data, projectId) => {
        const activeProjectId = useProjectStore.getState().currentProject?.id;
        const sessionState = useSessionStore.getState();
        // Accept usage from the current transient session or any stashed transient session
        const isTransient = sessionId === sessionState.transientSessionId
          || Object.values(sessionState.transientSessions).some((entry) => entry.sessionId === sessionId);
        if (isTransient || !projectId || !activeProjectId || projectId === activeProjectId) {
          enqueueUsage(sessionId, data);

          // Live-capture: feed any newly-reported model ID into the persistent
          // discovered-models cache so the dropdowns instantly "learn" any
          // model the user invokes (e.g. `/model haiku` in Claude reports back
          // as `claude-haiku-4-5-...` on the next usage tick). The action
          // dedupes before persisting, so this is a cheap no-op once seen.
          if (data.model?.id) {
            const task = useBoardStore.getState().tasks.find((entry) => entry.session_id === sessionId);
            if (task?.agent) {
              useConfigStore.getState().rememberDiscoveredModel(task.agent, data.model.id);
            }
          }
        }
      }));
    }

    // Session activity state (thinking/idle)
    // ALWAYS update activity (sidebar badges need cross-project data),
    // but only run auto-focus for current project.
    if (sessions.onActivity) {
      cleanups.push(sessions.onActivity((sessionId, state, reason, projectId, taskId, taskTitle) => {
        // Deferred whole through the coalescer (held during an active board
        // drag). The auto-focus and notification side effects read getState()
        // AFTER updateActivity, so the write and its reads must stay atomic -
        // deferring the body as one thunk preserves that read-after-write.
        enqueueSessionUpdate(() => {
          updateActivity(sessionId, state, reason);

          const activeProjectId = useProjectStore.getState().currentProject?.id;
          const isCurrentProject = !projectId || !activeProjectId || projectId === activeProjectId;

          const config = useConfigStore.getState().config;
          const sessionStore = useSessionStore.getState();

          // Auto-focus: switch the bottom panel to the most recently idle session
          // (only for current project sessions). Treat 'permission' like 'idle'
          // for focus rules - the agent is paused, the user should see it.
          if (isCurrentProject && config.autoFocusIdleSession) {
            const projectSessions = sessionStore.sessions.filter((s) => s.projectId === activeProjectId);
            const target = resolveAutoFocusTarget({
              sessionId,
              newState: state,
              currentActiveSessionId: sessionStore.activeSessionId,
              dialogSessionIds: sessionStore.dialogSessionIds,
              sessionActivity: sessionStore.sessionActivity,
              sessions: projectSessions,
            });
            if (target !== null) {
              sessionStore.setActiveSession(target);
            }
          }

          // OS notification + taskbar flash for sessions awaiting the user
          // (idle or permission) that are not visible. Bucketing via
          // shared/activity-state.ts; the permission-specific message text below
          // still keys off the granular state.
          if (requiresUserInteraction(state)) {
            const notifyConfig = useConfigStore.getState().config.notifications;
            if (notifyConfig.desktop.onAgentIdle) {
              const session = sessionStore.sessions.find((s) => s.id === sessionId);
              if (session) {
                shouldNotify(sessionId, session.projectId).then((notify) => {
                  if (!notify) return;
                  const project = useProjectStore.getState().projects.find((p) => p.id === session.projectId);
                  const projectName = project?.name ?? 'A project';
                  const label = session.transient ? 'Command Terminal' : (taskTitle ?? 'A task');
                  // activity-state-ok: granular permission-vs-idle message text, not an idle-vs-active bucket
                  const body = state === 'permission' ? `Needs permission: ${projectName}` : projectName;
                  const clickTaskId = session.transient ? COMMAND_TERMINAL_NOTIFICATION_TASK_ID : (taskId ?? '');
                  sendNotification(sessionId, label, body, session.projectId, clickTaskId);
                });
              }
            }
          }
        });
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
    // Batched via microtask to coalesce rapid updates from multiple sessions
    if (sessions.onEvent) {
      cleanups.push(sessions.onEvent((sessionId, event, projectId) => {
        const activeProjectId = useProjectStore.getState().currentProject?.id;
        if (!projectId || !activeProjectId || projectId === activeProjectId) {
          enqueueEvent(sessionId, event);
        }
        maybeLabelTransientSession(sessionId, event);
      }));
    }

    // Notification clicked -- switch project and open task detail
    const notifications = window.electronAPI?.notifications;
    if (notifications?.onClicked) {
      cleanups.push(notifications.onClicked((projectId, taskId) => {
        const alreadyActive = useProjectStore.getState().currentProject?.id === projectId;
        const isCommandTerminal = taskId === COMMAND_TERMINAL_NOTIFICATION_TASK_ID;
        if (isCommandTerminal) {
          useSessionStore.getState().setPendingOpenCommandTerminal(true);
          if (!alreadyActive) {
            useProjectStore.getState().openProject(projectId);
          }
          return;
        }
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
          // Held until drag end if the kangentic.json watch fires mid-drag, so
          // columns never reconfigure on the pointer-move thread. See the reload
          // gate in session-update-coalescer.
          enqueueReload('applyConfig', () => useBoardStore.getState().applyConfigChange());
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

    // Agent-driven board/backlog/swimlane/label-color push handlers
    // and their debouncers live in `useAgentDrivenInvalidation` so the
    // current/background-project routing policy stays in one place.
    // The handlers below (onSpawnProgress, onAutoMoved) are tangled
    // with session-lifecycle or notification concerns and remain here.

    const tasks = window.electronAPI?.tasks;

    // Spawn progress (worktree creation, branch checkout phases)
    if (tasks?.onSpawnProgress) {
      cleanups.push(tasks.onSpawnProgress((taskId, label) => {
        enqueueSessionUpdate(() => {
          useSessionStore.getState().setSpawnProgress(taskId, label);
        });
      }));
    }

    // Task auto-moved (plan exit → next column)
    if (tasks?.onAutoMoved) {
      cleanups.push(tasks.onAutoMoved((autoMovedTaskId, _targetSwimlaneId, taskTitle, autoMoveProjectId) => {
        const activeProjectId = useProjectStore.getState().currentProject?.id;
        if (autoMoveProjectId && autoMoveProjectId !== activeProjectId) {
          // Background project: drop the cache so the next warm switch
          // refetches rather than restoring the pre-move column.
          invalidateProject(autoMoveProjectId);
        } else {
          // Current project: a single auto-move event (one task per plan
          // completion) does not need debouncing. Routed through enqueueReload
          // so it is held until drag end if it lands mid-drag, rather than
          // reconciling a sortable lane on the pointer-move thread (see the
          // reload gate in session-update-coalescer).
          enqueueReload('board', () => useBoardStore.getState().loadBoard());
        }

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
  }, [upsertSession, updateSessionStatus, updateActivity]);

  return (
    <>
      <AppLayout />
      <ActivityDebugOverlay />
      {/*
        Dev-only: installs window.__kangenticPreviewSnapshot and subscribes
        to a few stores for ring-buffer accumulation. Renders nothing.
        Production builds drop both the import and this conditional via
        `__KANGENTIC_DEV__` dead-code elimination + Vite tree-shaking.
      */}
      {__KANGENTIC_DEV__ && <DevtoolsBootstrap />}
      {/*
        Dev-only preview test harness (floating "Create Task" toolbar). Built out
        of prod by the `__KANGENTIC_DEV__` dead-code guard, AND gated at runtime on
        `isEphemeralPreview` so it shows only in `/preview`, not the `npm start` dogfood.
      */}
      {__KANGENTIC_DEV__ && window.electronAPI.dev?.isEphemeralPreview && <TestHarness />}
    </>
  );
}

// Dev-only: re-sync all IPC-backed Zustand stores after Vite HMR updates.
// Most store modules revert to defaults when HMR replaces them (e.g. config
// resets to DEFAULT_CONFIG); re-fetching from the main process restores them.
// The board/backlog/project stores are instance-pinned across HMR (Pattern E in
// .claude/rules/hmr-patterns.md), so for them this re-sync RECONCILES the pinned
// instance with main-process truth rather than restoring it from scratch. Keep
// the calls either way; the unit test below enforces them.
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
    // Force every <DndContext> to remount with a fresh dnd-kit manager.
    // After Fast Refresh, the surviving DndContext keeps its internal monitor
    // state but per-droppable `isOver` subscriptions go stale, so visuals
    // driven by `useDroppable` (e.g. the Done dropzone's swirling animation)
    // never fire. Bumping the generation re-keys every DndContext consumer
    // and re-establishes a clean dnd-kit tree identical to a fresh boot.
    bumpHmrGeneration();

    // Discard any buffered session pushes and clear the drag gate. The resync
    // below re-fetches authoritative state from the main process, so buffered
    // renderer-side pushes are stale; an HMR also tears down the DndContext
    // without firing dragEnd, so the gate must be force-cleared here.
    resetCoalescerForHmr();

    // Cancel stale drop highlights (HMR unmounts DndContext without firing dragEnd)
    document.querySelectorAll('.drop-highlight').forEach(element => element.classList.remove('drop-highlight'));

    // Window-manager Pattern D: an HMR mid window-drag fires no pointerup, so
    // hide the snap preview and clear any leftover frame transforms.
    clearSnapPreviewDom();

    // Snapshot active tab before sync - syncSessions may transiently clear
    // activeSessionId if the sessions array is briefly empty during re-fetch.
    const previousActiveSessionId = useSessionStore.getState().activeSessionId;

    useProjectStore.getState().loadProjects();
    useProjectStore.getState().loadGroups();
    useProjectStore.getState().loadCurrent();
    useConfigStore.getState().loadConfig();
    useConfigStore.getState().loadAgentList();
    useBoardStore.getState().loadBoard();
    useBacklogStore.getState().loadBacklog();
    useSessionStore.getState().syncSessions().then((applied) => {
      if (!applied) return;

      // Restore active tab if sync cleared it but the session still exists
      if (previousActiveSessionId && !useSessionStore.getState().activeSessionId) {
        const sessionStillExists = useSessionStore.getState().sessions.some(
          (session) => session.id === previousActiveSessionId,
        );
        if (sessionStillExists) {
          useSessionStore.getState().setActiveSession(previousActiveSessionId);
        }
      }

      const savedPeriod = useConfigStore.getState().config.statusBarPeriod;
      if (savedPeriod && savedPeriod !== useSessionStore.getState().selectedPeriod) {
        useSessionStore.getState().setSelectedPeriod(savedPeriod);
      }
    });
  });
}

// Dev-only: expose Zustand stores for UI test automation (Playwright page.evaluate).
// @ts-expect-error -- Vite defines import.meta.env; tsc doesn't support it
if (import.meta.env.DEV) {
  (window as unknown as Record<string, unknown>).__zustandStores = {
    board: useBoardStore,
    backlog: useBacklogStore,
    config: useConfigStore,
    project: useProjectStore,
    session: useSessionStore,
  };
}

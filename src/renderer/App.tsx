import { useEffect } from 'react';
import { AppLayout } from './components/layout/AppLayout';
import { ActivityDebugOverlay } from './components/debug/ActivityDebugOverlay';
import { DevtoolsBootstrap } from '../devtools/renderer/install';
import { TestHarness } from '../devtools/renderer/TestHarness';
import { useProjectStore } from './stores/project-store';
import { useBoardStore } from './stores/board-store';
import { useConfigStore } from './stores/config-store';
import { useMobileStore } from './stores/mobile-store';
import { useSessionStore } from './stores/session-store';
import { useBacklogStore } from './stores/backlog-store';
import { useToastStore } from './stores/toast-store';
import { useUpdaterStore } from './stores/updater-store';
import { useAnnouncementsStore } from './stores/announcements-store';
import { useUsageDashboardStore } from './stores/usage-dashboard-store';
import { useMonitorStore } from './stores/monitor-store';
import { usePopOutStore } from './stores/pop-out-store';
import { useDictationStore } from './stores/dictation-store';
import { useProjectSwitchEffect } from './hooks/useProjectSwitchEffect';
import { useAgentDrivenInvalidation } from './hooks/useAgentDrivenInvalidation';
import { useWhatsNewOnLaunch } from './hooks/useWhatsNewOnLaunch';
import { invalidateProject } from './stores/project-cache';
import { resolveAutoFocusTarget } from './utils/auto-focus';
import { derivePanelSessions } from './utils/panel-sessions';
import { COMMAND_TERMINAL_NOTIFICATION_TASK_ID } from '../shared/notification-constants';
import { bumpHmrGeneration } from './utils/hmr-generation';
import { clearSnapPreviewDom } from './window-manager';
import { setRebindCaptureActive } from './utils/rebind-state';
import { useWindowStore, commandWindowManager } from './window-manager/store/window-store';
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

export function App() {
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const loadCurrent = useProjectStore((s) => s.loadCurrent);
  const currentProject = useProjectStore((s) => s.currentProject);
  const loadConfig = useConfigStore((s) => s.loadConfig);
  const loadAppVersion = useConfigStore((s) => s.loadAppVersion);
  const loadAgentList = useConfigStore((s) => s.loadAgentList);
  const detectGit = useConfigStore((s) => s.detectGit);
  const upsertSession = useSessionStore((s) => s.upsertSession);
  const updateSessionStatus = useSessionStore((s) => s.updateSessionStatus);
  const updateActivity = useSessionStore((s) => s.updateActivity);

  // Shows the running version's release notes once, on the first launch after
  // the version changes. Self-gating on its own config marker; waits for
  // loadAppVersion() and loadConfig() below to settle before deciding.
  useWhatsNewOnLaunch();

  useEffect(() => {
    if (process.env.NODE_ENV !== 'production') {
      performance.mark('renderer-mount-start');
    }
    const configLoaded = loadConfig();
    loadAppVersion();
    loadAgentList();
    detectGit();
    const projectsLoaded = loadProjects();
    useProjectStore.getState().loadGroups();
    // Restore the current project after a page reload (e.g. Vite HMR).
    // The main process retains currentProjectId across renderer reloads.
    loadCurrent();

    // One-time upgrade backfill for onboardedProjectIds. The field starts
    // undefined for every user (new or existing); this seeds every project
    // already known at first hydration as onboarded, so an existing user never
    // sees the Get started panel retroactively on a project they already use.
    // A brand-new user has no known projects yet, so this simply writes `[]`,
    // and their first real project starts un-onboarded as intended. Runs once
    // on cold mount, not on every HMR tick, because this effect body only runs
    // on genuine (re)mount.
    Promise.all([configLoaded, projectsLoaded]).then(() => {
      const { config, updateConfig } = useConfigStore.getState();
      if (config.onboardedProjectIds === undefined) {
        const allProjectIds = useProjectStore.getState().projects.map((project) => project.id);
        updateConfig({ onboardedProjectIds: allProjectIds });
      }
      // Seed the monitor's persisted view once config is on hand, so reopening it
      // (or relaunching the app) restores the layout/grouping/filters as left.
      useMonitorStore.getState().hydrateView(config.monitor);
    });

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

    // Pop-out windows: hydrate which surfaces are currently detached, then stay
    // live via the popOut:changed push. Only meaningful in the main window (a
    // pop-out window never reads this store); see stores/pop-out-store.ts.
    void usePopOutStore.getState().loadOpen();
    const cleanupPopOutChanged = window.electronAPI.popOut?.onChanged((openInstanceKeys) => {
      usePopOutStore.getState().setOpen(openInstanceKeys);
    });

    // Listen for auto-update downloaded notification
    const cleanupUpdateListener = window.electronAPI.updater?.onUpdateDownloaded((info) => {
      useUpdaterStore.getState().receiveUpdate(info);
    });

    // Announcements: hydrate the active list (the first poll may have landed
    // before this renderer mounted) and the local archive (which, unlike the
    // in-memory active list, is non-empty before the first poll and offline),
    // then stay live via the changed push.
    void useAnnouncementsStore.getState().loadActive();
    void useAnnouncementsStore.getState().loadHistory();
    const cleanupAnnouncementsChanged = window.electronAPI.announcements?.onChanged(
      ({ active, history }) => {
        useAnnouncementsStore.getState().receiveActive(active);
        useAnnouncementsStore.getState().receiveHistory(history);
      },
    );

    return () => {
      if (mountTimerRafId !== undefined) cancelAnimationFrame(mountTimerRafId);
      cleanupAutoOpen();
      cleanupPathMissing?.();
      cleanupPopOutChanged?.();
      cleanupUpdateListener?.();
      cleanupAnnouncementsChanged?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- mount-only bootstrap: every callee is a stable Zustand action or an IPC listener registered exactly once
  }, []);

  // Hydrate each task's persisted detail-view layout (divider, panels, view
  // mode, reviewed files, scope, ...) from its `detail_view_state` blob whenever
  // the board's tasks change. A store subscription (not a reactive selector) so
  // the root App component never re-renders on board changes; the hydrate action
  // is guarded to seed each task only once per session.
  //
  // Hydration runs ONLY from the subscription, never eagerly here. board-store is
  // HMR-instance-pinned (Pattern E): on a Fast Refresh its `tasks` still hold the
  // PRE-reload blobs while the session-store hydration guard has reset. An eager
  // getState() read would hydrate those stale blobs and mark every task seeded,
  // so the fresh `vite:afterUpdate` loadBoard() (which fires this subscription)
  // would early-exit and the user's just-made layout edit would be lost until a
  // full reload. On cold boot the board is empty until loadBoard() resolves and
  // fires the subscription anyway, so nothing is missed by waiting for it.
  useEffect(() => {
    return useBoardStore.subscribe((state) => {
      useSessionStore.getState().hydrateDetailViewStateForTasks(state.tasks);
    });
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
          // Mid-session conversation fork (e.g. Claude /clear): the live
          // session's agent id is null until first capture (that flip stays
          // quiet), so a non-null -> DIFFERENT non-null flip on a running
          // session is exactly a fork. The comparison runs synchronously in
          // this push handler and syncSessions never re-enters it, so an HMR
          // resync cannot replay the toast.
          const previousSession = useSessionStore.getState().sessions
            .find((existingSession) => existingSession.id === sessionId);
          const forkedConversation =
            session.status === 'running'
            && !session.transient
            && previousSession?.agentSessionId != null
            && session.agentSessionId != null
            && previousSession.agentSessionId !== session.agentSessionId;
          upsertSession(session);
          scheduleAutoNameSuggestion(session);
          if (forkedConversation
            && session.projectId === useProjectStore.getState().currentProject?.id) {
            const forkTask = useBoardStore.getState().tasks.find((boardTask) => boardTask.id === session.taskId);
            const forkLabel = forkTask ? `"${forkTask.title}"` : sessionId.slice(0, 8);
            useToastStore.getState().addToast({
              message: `Conversation for ${forkLabel} moved to a new session (e.g. /clear). Resume will follow the new conversation.`,
              variant: 'info',
            });
          }
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
          // Remove this transient session's renderer state (its (project, slot)
          // map entry + per-session dicts). Works whether the session belongs to
          // the current project or another project's still-tracked terminal.
          useSessionStore.getState().clearTransientSessionById(sessionId);
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

        // Refresh the usage dashboard after metrics are persisted (slight delay
        // for the DB write; no-ops while the dashboard is closed).
        setTimeout(() => useUsageDashboardStore.getState().loadDashboardStats({ force: true }), 1000);

        // The desktop crash notification for a non-zero exit on a non-visible
        // project now lives in main (src/main/notifications/desktop-notifier.ts),
        // which listens to SessionManager's 'exit' event directly.
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
        // Accept usage from any transient (command terminal) session, regardless
        // of which project owns it.
        const isTransient = Object.values(sessionState.transientSessions).some((entry) => entry.sessionId === sessionId);
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
              // Also learn this model's account-accurate context window from the
              // same status.json tick (0 when the window is unknown, e.g. the
              // transcript fallback), so the dropdowns can badge context size
              // without hardcoding a per-model window.
              useConfigStore.getState().rememberModelContextWindow(
                task.agent,
                data.model.id,
                data.contextWindow?.contextWindowSize ?? 0,
              );
            }
          }
        }
      }));
    }

    // Agent monitor: snapshot pushes for the DB-resident half of a row (a session
    // spawned or exited, an agent retitled or moved a task). Live activity does
    // NOT come through here - it rides the unbuffered SESSION_ACTIVITY push above
    // and is patched onto rows in place.
    const monitorApi = window.electronAPI?.monitor;
    if (monitorApi?.onChanged) {
      cleanups.push(monitorApi.onChanged((snapshot) => {
        // Applied unconditionally, not gated on the monitor being open. Main
        // only pushes while SOME renderer is subscribed (monitor:subscribe), so
        // with every monitor closed nothing arrives here at all; when the
        // pop-out is the subscriber, applying the broadcast keeps this window's
        // cache warm too. Reopen freshness does not depend on this: attach()
        // seeds from the snapshot the subscription handshake returns.
        useMonitorStore.getState().applySnapshot(snapshot);
      }));
    }

    // Session activity state (thinking/idle)
    // ALWAYS update activity (sidebar badges need cross-project data),
    // but only run auto-focus for current project.
    if (sessions.onActivity) {
      cleanups.push(sessions.onActivity((sessionId, state, reason, projectId) => {
        // Deferred whole through the coalescer (held during an active board
        // drag). The auto-focus effect reads getState() AFTER updateActivity,
        // so the write and its reads must stay atomic - deferring the body as
        // one thunk preserves that read-after-write.
        enqueueSessionUpdate(() => {
          updateActivity(sessionId, state, reason);

          // Patch the monitor's matching row in place. This is why the monitor
          // needs no polling: SESSION_ACTIVITY is already unbuffered and
          // cross-project, so a state change reaches the row with no round trip.
          useMonitorStore.getState().applyActivity(sessionId, state, reason ?? null);

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
              // Both owner sources, not just this renderer's windows: a detail hosted in
              // the detached monitor has no tab here either, and making it the active tab
              // is how the panel ends up selecting a session it renders nothing for.
              ownedSessionIds: derivePanelSessions({
                sessions: sessionStore.sessions,
                currentProjectId: activeProjectId ?? null,
                dialogSessionIds: sessionStore.dialogSessionIds,
                remoteDetailTaskIds: sessionStore.remoteDetailTaskIds,
              }).owned,
              sessionActivity: sessionStore.sessionActivity,
              sessions: projectSessions,
            });
            if (target !== null) {
              sessionStore.setActiveSession(target);
            }
          }

          // The desktop OS-notification decision for idle/permission sessions
          // (cooldown, focus gate, active-project gate, title assembly) now
          // lives in main (src/main/notifications/desktop-notifier.ts), which
          // listens to SessionManager's 'activity' event directly. That keeps
          // it working even when this renderer is gone (window closed).
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
          if (alreadyActive) {
            useSessionStore.getState().setPendingOpenCommandTerminal(true);
            return;
          }
          // Arm the flag only once the switch is CONFIRMED, the same contract the
          // sidebar indicator follows (`ProjectSidebar.handleOpenCommandTerminals`).
          // Setting it up front let `useCommandBar`'s effect fire while the OUTGOING
          // project was still current, opening the layer on the wrong project until
          // the close-on-project-change effect tore it back down. `openProject` also
          // RESOLVES without switching (a moved or renamed folder routes to the
          // "Locate Folder" dialog), so confirm rather than merely sequence.
          useProjectStore.getState().openProject(projectId)
            .then(() => {
              if (useProjectStore.getState().currentProject?.id !== projectId) return;
              useSessionStore.getState().setPendingOpenCommandTerminal(true);
            })
            .catch(() => {});
          return;
        }
        // The Command Terminal layer is top-layered over the board, so opening a
        // task detail underneath it leaves the user looking at a terminal they did
        // not ask for. A cross-project click closes the layer anyway (close-on-
        // project-switch); this covers the same-project case. Every PTY stays alive.
        // Also the path the DETACHED monitor takes: its row click routes through
        // main and re-emits here, so pop-out and in-app behave identically.
        useSessionStore.getState().requestHideCommandBar();
        // agent-focus-ok: a notification click is the user asking for this task,
        // so the detail it opens SHOULD take focus. It arrives over an IPC push
        // like the agent's does, which is why the origin is stated here rather
        // than inferred. See .claude/rules/agent-driven-focus.md.
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
    if (boardConfig?.onBoardProfilesChanged) {
      // An agent (MCP) rewrote the profiles. Unlike a column edit this raises no
      // BOARD_CONFIG_CHANGED, so without this the live profile pickers
      // (ProfilePicker, AdvancedOverridesSection) would keep showing the
      // pre-edit list. An already-open Column Manager deliberately does NOT
      // adopt the change - it snapshots its profile drafts once on mount so an
      // external write cannot clobber in-progress edits.
      //
      // Filtered by project: an agent can retune a BACKGROUND project's
      // profiles, and `getBoardProfiles()` always reads the ACTIVE board, so an
      // unfiltered reload would refetch the wrong project's list for no reason.
      cleanups.push(boardConfig.onBoardProfilesChanged((changedProjectId) => {
        if (changedProjectId !== useProjectStore.getState().currentProject?.id) return;
        useBoardStore.getState().loadBoardProfiles();
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

    // The task was created / promoted / unarchived, but its agent could not
    // start because another task's agent is live in the same checkout. Those
    // paths deliberately keep the task, so without this the result is
    // indistinguishable from a healthy spawn. Current project only: the message
    // names a task the user cannot see from another project.
    if (tasks?.onSpawnBlocked) {
      cleanups.push(tasks.onSpawnBlocked((_taskId, taskTitle, message, blockedProjectId) => {
        const activeProjectId = useProjectStore.getState().currentProject?.id;
        if (blockedProjectId && blockedProjectId !== activeProjectId) return;
        useToastStore.getState().addToast({
          // Deliberately verb-free about how the task got here. This same event
          // fires from create, promote, unarchive and MCP auto-spawn, and only
          // the first of those created anything - "was created" would be a lie
          // on three of the four paths.
          message: `"${taskTitle}" did not start its agent. ${message}`,
          variant: 'warning',
          duration: 12000,
        });
      }));
    }

    // A column's auto_command finished delivering. Main only pushes the
    // outcomes worth acting on (see `shouldNotify` in auto-command-outcome.ts),
    // so anything arriving here is either a real failure or a success that
    // took something from the user without asking. Current project only: the
    // message names a task the user cannot see from another project.
    if (tasks?.onAutoCommandResult) {
      cleanups.push(tasks.onAutoCommandResult((result) => {
        const activeProjectId = useProjectStore.getState().currentProject?.id;
        if (result.projectId && result.projectId !== activeProjectId) return;

        if (result.state === 'failed') {
          useToastStore.getState().addToast({
            message: `"${result.taskTitle}" did not run ${result.command}. ${result.reason ?? ''}`.trim(),
            variant: 'warning',
            duration: 12000,
          });
          return;
        }

        // Delivered, but it cost the user something. Quote the discarded draft
        // verbatim so it can be copied back out of the toast: clearing typed
        // text is defensible, losing it silently is not.
        const notes: string[] = [];
        if (result.discardedDraft) notes.push(`Your unsent text was cleared: "${result.discardedDraft}"`);
        else if (result.interruptedTurn) notes.push('The agent was interrupted mid-task.');
        if (result.escalated) notes.push('The session was restarted to deliver it.');
        if (notes.length === 0) return;

        useToastStore.getState().addToast({
          message: `"${result.taskTitle}" ran ${result.command}. ${notes.join(' ')}`,
          variant: 'info',
          duration: 12000,
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

    // ChangesPanel Pattern D: an HMR mid file-tree-resize or history-resize drag
    // fires no mouseup, so the body cursor / userSelect overrides set on mousedown
    // would stick.
    document.body.style.cursor = '';
    document.body.style.userSelect = '';

    // Keybindings Pattern D: a Hotkeys rebind capture interrupted by an HMR (e.g.
    // mid-rebind when an unrelated module Fast-Refreshes) leaves the module-scope
    // rebind-suppress flag stuck true, which silently kills EVERY app shortcut
    // (push-to-talk included) until a full reload. Reset it on every HMR - you are
    // never legitimately mid-rebind across one, and the capture widget re-arms it
    // on remount if it still is.
    setRebindCaptureActive(false);

    // Snapshot active tab before sync - syncSessions may transiently clear
    // activeSessionId if the sessions array is briefly empty during re-fetch.
    const previousActiveSessionId = useSessionStore.getState().activeSessionId;

    useProjectStore.getState().loadProjects();
    useProjectStore.getState().loadGroups();
    useProjectStore.getState().loadCurrent();
    useConfigStore.getState().loadConfig();
    useConfigStore.getState().loadAgentList();
    useConfigStore.getState().detectGit();
    useBoardStore.getState().loadBoard();
    useBoardStore.getState().loadBoardProfiles();
    useBacklogStore.getState().loadBacklog();
    useMobileStore.getState().loadStatus();
    useMobileStore.getState().loadDevices();
    // Usage dashboard Pattern B: refetch the composite payload from
    // main-process truth (no-ops while the dashboard is closed).
    useUsageDashboardStore.getState().loadDashboardStats();
    // Agent monitor Pattern B: refetch the cross-project snapshot from
    // main-process truth (no-ops while the monitor is closed).
    if (useMonitorStore.getState().monitorOpen) {
      void useMonitorStore.getState().loadSnapshot();
    }
    // Pop-out windows Pattern B: re-hydrate which surfaces are currently detached.
    usePopOutStore.getState().loadOpen();
    // Announcements Pattern B: re-pull the active list and the archive from
    // main-process truth. loadActive also re-runs the open-dialog
    // reconciliation, which a history-opened dialog is exempt from.
    void useAnnouncementsStore.getState().loadActive();
    void useAnnouncementsStore.getState().loadHistory();
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
    window: useWindowStore,
    commandWindow: commandWindowManager.store,
    usageDashboard: useUsageDashboardStore,
    popOut: usePopOutStore,
    dictation: useDictationStore,
    announcements: useAnnouncementsStore,
  };
}

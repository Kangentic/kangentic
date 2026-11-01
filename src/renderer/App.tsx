import { useEffect } from 'react';
import { i18n } from '@lingui/core';
import { msg, plural } from '@lingui/core/macro';
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
import { useWorkflowStore } from './stores/workflow-store';
import { useToastStore } from './stores/toast-store';
import { useLeftoverProcessesStore } from './stores/leftover-processes-store';
import { describeLeftoverReport } from './lib/leftover-processes';
import { showConversationExpiredNotices } from './lib/conversation-expired-toast';
import { useUpdaterStore } from './stores/updater-store';
import { useHostMemoryStore } from './stores/host-memory-store';
import { useAnnouncementsStore } from './stores/announcements-store';
import { useUsageDashboardStore } from './stores/usage-dashboard-store';
import { useMonitorStore } from './stores/monitor-store';
import { useKnowledgeGraphStore } from './stores/knowledge-graph-store';
import { usePopOutStore } from './stores/pop-out-store';
import { receivePopOutOpenSet } from './pop-out/pop-out-changed';
import { useDictationStore } from './stores/dictation-store';
import { useProjectSwitchEffect } from './hooks/useProjectSwitchEffect';
import { useAgentDrivenInvalidation } from './hooks/useAgentDrivenInvalidation';
import { useWhatsNewOnLaunch } from './hooks/useWhatsNewOnLaunch';
import { invalidateProject } from './stores/project-cache';
import { resolveAutoFocusTarget } from './utils/auto-focus';
import { endsOwnCallTurn, resolveIdleToast } from './utils/idle-toast';
import { openTaskFromNotification } from './utils/open-task-from-notification';
import { asSentence, describeIpcError } from './lib/ipc-error';
import { resolveGpuNotice } from './utils/gpu-notice';
import { setSoftwareRenderingActive } from './utils/terminal-webgl';
import { derivePanelSessions } from './utils/panel-sessions';
import { COMMAND_TERMINAL_NOTIFICATION_TASK_ID } from '../shared/notification-constants';
import { PTY_HOST_LOST_EXIT_CODE, PTY_HOST_LOST_NOTICE_WINDOW_MS } from '../shared/pty-host';
import { bumpHmrGeneration } from './utils/hmr-generation';
import { clearSnapPreviewDom } from './window-manager';
import { clearDropGapDom } from './utils/board-drop-preview';
import { setRebindCaptureActive } from './utils/rebind-state';
import { useWindowStore, commandWindowManager, knowledgeGraphWindowManager } from './window-manager/store/window-store';
import {
  autoNameTimers,
  scheduleAutoNameSuggestion,
} from './lib/auto-name-scheduler';
import {
  enqueueUsage,
  enqueueEvent,
  enqueueSessionUpdate,
  enqueueReload,
  resetCoalescerForHmr,
} from './lib/session-update-coalescer';
import type { AutomationRunStatus } from '../shared/types';

/**
 * A Run again result as one sentence naming the automation. One whole message
 * per outcome, so no verb is spliced into another language's sentence.
 * Translated when called, never at module load.
 */
function runAgainOutcomeSentence(status: AutomationRunStatus, automationName: string): string {
  switch (status) {
    case 'succeeded':
      return i18n._(msg`"${automationName}" succeeded against the task's current state.`);
    case 'failed':
      return i18n._(msg`"${automationName}" failed against the task's current state.`);
    case 'skipped':
      return i18n._(msg`"${automationName}" was skipped against the task's current state.`);
    case 'interrupted':
      return i18n._(msg`"${automationName}" was interrupted against the task's current state.`);
    case 'running':
      return i18n._(msg`"${automationName}" is still running against the task's current state.`);
  }
}

export function App() {
  const loadProjects = useProjectStore((s) => s.loadProjects);
  const loadCurrent = useProjectStore((s) => s.loadCurrent);
  const currentProject = useProjectStore((s) => s.currentProject);
  const loadConfig = useConfigStore((s) => s.loadConfig);
  const loadAppVersion = useConfigStore((s) => s.loadAppVersion);
  const loadAgentList = useConfigStore((s) => s.loadAgentList);
  const detectGit = useConfigStore((s) => s.detectGit);
  const upsertSession = useSessionStore((s) => s.upsertSession);
  const removeSession = useSessionStore((s) => s.removeSession);
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

    // Main deleted or reconciled project rows this renderer's list did not
    // know about (a dev-only boot prune, or a global-DB recovery that
    // reopened onto a different file): refetch rather than leaving stale
    // rows that reject when clicked with nothing on screen. Sentry DESKTOP-V.
    const cleanupListChanged = window.electronAPI.projects.onListChanged?.(() => {
      loadProjects();
      loadCurrent();
    });

    // Pop-out windows: hydrate which surfaces are currently detached, then stay
    // live via the popOut:changed push. Only meaningful in the main window (a
    // pop-out window never reads this store); see stores/pop-out-store.ts.
    void usePopOutStore.getState().loadOpen();
    const cleanupPopOutChanged = window.electronAPI.popOut?.onChanged(receivePopOutOpenSet);

    // Listen for auto-update downloaded notification
    const cleanupUpdateListener = window.electronAPI.updater?.onUpdateDownloaded((info) => {
      useUpdaterStore.getState().receiveUpdate(info);
    });

    // Host memory pressure (Sentry DESKTOP-16): a rare, edge-triggered push
    // from main's sampler - see stores/host-memory-store.ts. The recovery
    // push is the clear-side edge; its payload carries a sample but the
    // store deliberately discards it (nothing displays a recovery reading).
    const cleanupHostMemoryPressureListener = window.electronAPI.hostMemory?.onPressure((event) => {
      useHostMemoryStore.getState().receivePressureEvent(event);
    });
    const cleanupHostMemoryRecoveryListener = window.electronAPI.hostMemory?.onRecovery(() => {
      useHostMemoryStore.getState().receiveRecovery();
    });
    // Low memory paused an agent that was waiting on the user: one push per
    // agent, on every platform. The store counts them in one toast and keeps
    // the Review list (stores/host-memory-store.ts).
    const cleanupHostMemoryAgentPausedListener = window.electronAPI.hostMemory?.onAgentPaused((event) => {
      useHostMemoryStore.getState().receiveAgentPaused(event);
    });

    // Graphics state (Sentry DESKTOP-18/DESKTOP-W). PULLED, not pushed: main
    // decides both facts during boot, possibly before this renderer could
    // have registered a listener, and a dropped push would lose the notice
    // for good because the record behind it is already cleared. Reading
    // consumes `noticePending`, so this never re-toasts on a reload.
    void window.electronAPI.gpuHealth?.readStatus().catch((error) => {
      // Swallowed, not reported: this is the ONE call in the bootstrap that a
      // user who never has a graphics problem still makes, and an unhandled
      // rejection here would surface as a renderer error for all of them if
      // the channel ever went missing (a stale preload, a handler throw).
      // Nothing downstream needs it - no status means hardware, as today.
      console.warn('[GPU-HEALTH] Could not read graphics status:', error);
      return null;
    }).then((status) => {
      if (!status) return;
      // Arrives asynchronously, so a terminal that mounts before this lands
      // will attempt WebGL once and arm a retry. Harmless (the attach path
      // already handles a refused context) and not worth a synchronous boot
      // hop to avoid, but it does mean the skip below is an optimisation for
      // later mounts rather than a hard guarantee for the first one.
      setSoftwareRenderingActive(status.softwareRendering);
      const notice = resolveGpuNotice(status);
      if (!notice) return;
      // Main wrote graphicsAccelerationEnabled: false during whenReady, which may
      // have landed after this renderer read config. Re-read it, or Settings >
      // Performance shows "On" for the rest of a session that is demonstrably
      // running without acceleration - the exact lying control this design
      // dropped the tri-state to avoid.
      void useConfigStore.getState().loadConfig();
      useToastStore.getState().addToast({
        title: notice.title,
        message: notice.message,
        variant: 'warning',
        // Never auto-dismisses: the app stays degraded until the user acts,
        // and a 4-second toast about why their app vanished is worse than
        // none at all.
        persistent: true,
        action: {
          label: i18n._(msg`Settings`),
          icon: 'settings',
          onClick: () => {
            useConfigStore.getState().setLastSettingsTab('performance');
            useConfigStore.getState().setSettingsOpen(true);
          },
        },
      });
    }).catch((error) => {
      // The .catch above guards only the invoke. A throw from anything in the
      // handler body would land here as an unhandled rejection that `void`
      // hides from the reader but Electron still reports, so it gets the same
      // swallow: nothing downstream of this chain needs it to have succeeded.
      console.warn('[GPU-HEALTH] Could not apply graphics status:', error);
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

    // Which tasks hold their one browser surface OFFSCREEN. Read once, then
    // live on the push. Only main can see these: an offscreen `BrowserWindow`
    // has no renderer to register itself, so without this the card globe and
    // the Browser pill show nothing for a task that genuinely has a browser.
    // The initial read is what covers a reload and an HMR update, since a
    // surface can sit unchanged for a whole session.
    void useSessionStore.getState().loadBrowserOffscreenTasks();
    const cleanupOffscreenSurfaces = window.electronAPI.browser?.onOffscreenSurfaces?.((taskIds) => {
      useSessionStore.getState().setBrowserOffscreenTasks(taskIds);
    });

    // An agent session started whose MCP tools cannot connect. Main sends this
    // once per run; the body is the error the check hit, the same text the MCP
    // connection row shows, and Open settings lands on that row.
    const cleanupMcpConnectionFailed = window.electronAPI.mcpServer?.onConnectionFailed(({ error }) => {
      useToastStore.getState().addToast({
        title: i18n._(msg`Couldn't reach the MCP server`),
        // The error the check hit, as main wrote it.
        message: error,
        variant: 'warning',
        persistent: true,
        action: {
          label: i18n._(msg`Open settings`),
          icon: 'settings',
          onClick: () => {
            useConfigStore.getState().setLastSettingsTab('mcpServer');
            useConfigStore.getState().setSettingsOpen(true);
          },
        },
      });
    });

    return () => {
      if (mountTimerRafId !== undefined) cancelAnimationFrame(mountTimerRafId);
      cleanupAutoOpen();
      cleanupPathMissing?.();
      cleanupListChanged?.();
      cleanupPopOutChanged?.();
      cleanupUpdateListener?.();
      cleanupHostMemoryPressureListener?.();
      cleanupHostMemoryRecoveryListener?.();
      cleanupHostMemoryAgentPausedListener?.();
      cleanupAnnouncementsChanged?.();
      cleanupOffscreenSurfaces?.();
      cleanupMcpConnectionFailed?.();
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
        // Routed through the coalescer, which runs the thunk synchronously today
        // (the board-drag hold was removed - see enqueueSessionUpdate's docblock).
        // Wrapped whole so the (currently side-effect-free) write and auto-name
        // scheduling stay in arrival order with the other handlers.
        enqueueSessionUpdate(() => {
          // Mid-session conversation move (Claude /clear, or a fork into
          // Claude Code's background daemon): the live session's agent id is
          // null until first capture (that flip stays quiet), so a non-null ->
          // DIFFERENT non-null flip on a running session is exactly a move.
          // Main changes the id only after the agent's own SessionStart hook
          // named it, so a second process writing the same status file cannot
          // raise this. The comparison runs synchronously in this push handler
          // and syncSessions never re-enters it, so an HMR resync cannot
          // replay the toast.
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
            const forkProjectId = session.projectId;
            useToastStore.getState().addToast({
              title: i18n._(msg`Conversation moved`),
              message: i18n._(msg`Resume now follows the agent's new conversation.`),
              variant: 'info',
              // The card names no task, so a click is how the user finds which one.
              onOpen: forkTask && forkProjectId
                ? () => { openTaskFromNotification(forkProjectId, forkTask.id); }
                : undefined,
            });
          }
        });
      }));
    }

    // Session removed from main's registry for good (a To Do reset, a task or
    // project delete, a session reset, an aborted spawn). Its own channel, and
    // the only push that takes a row OUT: the status handler above can only
    // upsert, so a removal announced there re-seeded the row the move had
    // already evicted (#661). Through the same coalescer as the status push so
    // a removal applies in arrival order with any status for the same id.
    if (sessions.onRemoved) {
      cleanups.push(sessions.onRemoved((sessionId) => {
        enqueueSessionUpdate(() => {
          removeSession(sessionId);
        });
      }));
    }

    // Desktop-notification helpers, now used only by the spawn-stall and
    // auto-move handlers: the idle and exit desktop notifications moved to main
    // (src/main/notifications/desktop-notifier.ts), which owns their cooldown.
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

    // agent-focus-ok: every push below that opens a task (an OS notification
    // click, and a click on a toast about a task) does it because the user
    // clicked it, so the detail SHOULD take focus. openTaskFromNotification
    // says so too.

    // Spawn-stall watcher: when a task sits in a "preparing" spawn-progress
    // state (worktree creation / git fetch / queue wait) past the threshold,
    // surface a non-blocking toast and an optional desktop notification so a
    // slow/head-of-line-blocked spawn never hangs silently. The toast has no
    // Cancel: dragging the task back to To Do stops the spawn, and its card
    // opens the task. Timers are effect-scoped (like notificationCooldowns
    // above), so they tear down with the effect on unmount/HMR - no
    // module-scope state.
    const STALL_THRESHOLD_MS = 8000;
    const spawnStallTimers = new Map<string, ReturnType<typeof setTimeout>>();
    // Toast id per task so the persistent stall toast can be dismissed when
    // the spawn resolves or is superseded.
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
      // carrying a "(waiting 45s)" qualifier; both collapse to one phrase. Not
      // anchored to the end: a staleness note may trail the qualifier (e.g.
      // "Removing worktree (waiting 45s) (base fetch failed)").
      //
      // Any other label continues `"<task>" is ...`, so its ellipsis goes (a
      // staleness note can trail it too) and only its first letter is lowered,
      // since an automation's label quotes the automation's own name.
      //
      // The label is main's English, and stays so: both checks read it, and the
      // phase is shown as main wrote it. Only the sentence around it translates.
      const isGitQueueWait = label.startsWith('Waiting') || /\(waiting \d+s\)/.test(label);
      const phaseLabel = label.replace(/\.\.\./g, '').trim();
      const phase = `${phaseLabel.charAt(0).toLowerCase()}${phaseLabel.slice(1)}`;
      const taskTitle = task.title;

      if (notifyConfig.toasts.onSpawnStalled) {
        const toastId = useToastStore.getState().addToast({
          title: i18n._(msg`Still preparing`),
          message: isGitQueueWait
            ? i18n._(msg`"${taskTitle}" is waiting on the git queue.`)
            : i18n._(msg`"${taskTitle}" is ${phase}.`),
          variant: 'warning',
          // Stays until the spawn resolves (the disarm below closes it), so a
          // slow spawn is never left looking like a healthy one.
          persistent: true,
          onOpen: projectId ? () => { openTaskFromNotification(projectId, taskId); } : undefined,
        });
        spawnStallToastIds.set(taskId, toastId);
      }

      if (notifyConfig.desktop.onSpawnStalled && projectId) {
        shouldNotify(`spawnstall:${taskId}`, projectId).then((notify) => {
          if (!notify) return;
          const project = useProjectStore.getState().projects.find((candidateProject) => candidateProject.id === projectId);
          sendNotification(
            `spawnstall:${taskId}`,
            i18n._(msg`Still preparing: ${taskTitle}`),
            project?.name ?? i18n._(msg`A project`),
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
      // moved to To Do). Also dismiss any stall toast, so the persistent toast
      // for a resolved spawn doesn't linger.
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
      // A pty host crash ends every terminal at once; its exits collapse to
      // one notice, and the agents among them resume a moment later.
      let lastHostLostToastAt = 0;
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

        // Transient sessions (command terminal) are ephemeral - skip toasts and
        // notifications. Main ends the terminal right after this exit and
        // announces the removal; the removal subscriber
        // (useCloseCommandWindowOnRemoval) drops the (project, slot) entry and
        // closes the window then, so the entry is left for it to find.
        if (currentSession?.transient) {
          updateSessionStatus(sessionId, { status: 'exited', exitCode });
          return;
        }

        updateSessionStatus(sessionId, { status: 'exited', exitCode });

        const notifyConfig = useConfigStore.getState().config.notifications;

        const activeProjectId = useProjectStore.getState().currentProject?.id;
        if (exitCode === PTY_HOST_LOST_EXIT_CODE) {
          // A machine-level event, not one project's, so no project gate.
          const now = Date.now();
          if (notifyConfig.toasts.onAgentCrash && now - lastHostLostToastAt >= PTY_HOST_LOST_NOTICE_WINDOW_MS) {
            useToastStore.getState().addToast({
              title: i18n._(msg`Terminals restarted`),
              message: i18n._(msg`Running agents are resuming.`),
              variant: 'warning',
            });
          }
          lastHostLostToastAt = now;
        } else if ((projectId ?? currentSession?.projectId) === activeProjectId) {
          // Only show toast if exited session belongs to current project
          if (notifyConfig.toasts.onAgentCrash) {
            const task = useBoardStore.getState().tasks.find((t) => t.session_id === sessionId)
              ?? useBoardStore.getState().tasks.find((t) => t.id === currentSession?.taskId);
            // One whole message per subject: a task's quoted title, or the
            // session's short id when no card names it.
            let exitMessage: string;
            if (task) {
              const taskTitle = task.title;
              exitMessage = i18n._(msg`"${taskTitle}" exited with code ${exitCode}.`);
            } else {
              const sessionIdShort = sessionId.slice(0, 8);
              exitMessage = i18n._(msg`${sessionIdShort} exited with code ${exitCode}.`);
            }
            const exitProjectId = projectId ?? currentSession?.projectId;
            useToastStore.getState().addToast({
              title: i18n._(msg`Session ended`),
              message: exitMessage,
              variant: exitCode === 0 ? 'info' : 'warning',
              onOpen: task && exitProjectId
                ? () => { openTaskFromNotification(exitProjectId, task.id); }
                : undefined,
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

    // The session's agent is on screen (main's markAgentReady): lifts the launch overlay
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

    // Agent message trail for the board card. Cross-project like activity (a
    // small map keyed by session, and a project switch must find the trails
    // already there), and deferred through the coalescer so a line landing
    // mid-drag does not re-render a sortable card until the drop.
    if (sessions.onMessageTrail) {
      cleanups.push(sessions.onMessageTrail((sessionId, entries) => {
        enqueueSessionUpdate(() => {
          useSessionStore.getState().updateMessageTrail(sessionId, entries);
        });
      }));
    }

    // Session activity state (thinking/idle)
    // ALWAYS update activity (sidebar badges need cross-project data),
    // but only run auto-focus for current project.
    if (sessions.onActivity) {
      cleanups.push(sessions.onActivity((sessionId, state, reason, projectId) => {
        // Routed whole through the coalescer. It runs the thunk synchronously
        // today (the board-drag hold was removed - see enqueueSessionUpdate's
        // docblock for why), so this is about ATOMICITY, not deferral: the
        // auto-focus and toast blocks below read getState() AFTER
        // updateActivity, and passing the body as one thunk keeps that
        // read-after-write intact if a hold is ever reintroduced.
        enqueueSessionUpdate(() => {
          // Read the prior state BEFORE the write: this channel now also carries
          // a reason-only refresh (same state, moved reason kind), and auto-focus
          // below must not treat one as a transition. See the gate at its call.
          const previousState = useSessionStore.getState().sessionActivity[sessionId];
          updateActivity(sessionId, state, reason);

          // Patch the monitor's matching row in place. This is why the monitor
          // needs no polling: SESSION_ACTIVITY is already unbuffered and
          // cross-project, so a state change reaches the row with no round trip.
          useMonitorStore.getState().applyActivity(sessionId, state, reason ?? null);

          const activeProjectId = useProjectStore.getState().currentProject?.id;
          const isCurrentProject = !projectId || !activeProjectId || projectId === activeProjectId;

          const config = useConfigStore.getState().config;
          const sessionStore = useSessionStore.getState();

          // Which sessions already have their terminal on another surface. EVERY
          // owner source, not just this renderer's windows: a detail hosted in the
          // detached monitor has no tab here either, and making it the active tab is
          // how the panel ends up selecting a session it renders nothing for. A
          // phone streaming the terminal is an owner for the same reason, and is the
          // one source `derivePanelSessions` treats as optional - omit it and the
          // suppression `resolveIdleToast` documents silently does not happen.
          //
          // Hoisted out of the auto-focus branch because the idle toast below reads
          // it too. One computation, so the two cannot disagree about what the user
          // can actually see.
          const ownedSessionIds = derivePanelSessions({
            sessions: sessionStore.sessions,
            currentProjectId: activeProjectId ?? null,
            dialogSessionIds: sessionStore.dialogSessionIds,
            remoteDetailTaskIds: sessionStore.remoteDetailTaskIds,
            mobileTerminalStreamedSessionIds: sessionStore.mobileTerminalStreamedSessionIds,
          }).owned;

          // Auto-focus: switch the bottom panel to the most recently idle session
          // (only for current project sessions). Treat 'permission' like 'idle'
          // for focus rules - the agent is paused, the user should see it.
          //
          // `previousState` is what makes a reason-only refresh on this channel a
          // no-op here: the resolver returns null when the state did not move.
          //
          // Not for the idle that ends the turn in which the session moved its
          // own task or paused its own workflow: that turn belongs to the call.
          const endsOwnCall = endsOwnCallTurn(reason);
          if (isCurrentProject && config.autoFocusIdleSession && !endsOwnCall) {
            const projectSessions = sessionStore.sessions.filter((s) => s.projectId === activeProjectId);
            const target = resolveAutoFocusTarget({
              sessionId,
              newState: state,
              previousState,
              currentActiveSessionId: sessionStore.activeSessionId,
              ownedSessionIds,
              sessionActivity: sessionStore.sessionActivity,
              sessions: projectSessions,
            });
            if (target !== null) {
              sessionStore.setActiveSession(target);
            }
          }

          // In-app toast for a session that stopped and is waiting on the user.
          // The desktop half of this same event is owned by main (see below) and
          // fires on the opposite condition - when the user is AWAY. This covers
          // the case that one skips: the user is here, on this project, but is not
          // looking at this particular agent.
          const toastSession = sessionStore.sessions.find((s) => s.id === sessionId);
          if (toastSession) {
            const toastTask = useBoardStore.getState().tasks.find((t) => t.id === toastSession.taskId);
            const idleToast = resolveIdleToast({
              state,
              previousState,
              enabled: config.notifications.toasts.onAgentIdle,
              // Strict, unlike `isCurrentProject` above, which is permissive when
              // either id is missing. Matches the exit and idle-timeout handlers:
              // a toast has to name a task on the board the user is looking at.
              isCurrentProject: Boolean(activeProjectId) && toastSession.projectId === activeProjectId,
              transient: Boolean(toastSession.transient),
              ownedByDetailSurface: ownedSessionIds.has(sessionId),
              taskTitle: toastTask?.title,
              sessionIdShort: sessionId.slice(0, 8),
              endsOwnCall,
              reason,
            });
            if (idleToast) {
              const openProjectId = toastSession.projectId;
              const openTaskId = toastSession.taskId;
              useToastStore.getState().addToast({
                title: idleToast.title,
                message: idleToast.message,
                variant: idleToast.variant,
                // No board row means nothing to open, so the card stays informational.
                onOpen: idleToast.hasTask
                  ? () => { openTaskFromNotification(openProjectId, openTaskId); }
                  : undefined,
              });
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
          let pausedMessage: string;
          if (task) {
            const taskTitle = task.title;
            pausedMessage = i18n._(msg`"${taskTitle}" was idle for ${plural(timeoutMinutes, { one: '# minute', other: '# minutes' })}.`);
          } else {
            const sessionIdShort = sessionId.slice(0, 8);
            pausedMessage = i18n._(msg`${sessionIdShort} was idle for ${plural(timeoutMinutes, { one: '# minute', other: '# minutes' })}.`);
          }
          const pausedProjectId = timeoutProjectId;
          useToastStore.getState().addToast({
            // "Paused", matching the Pausing agents card that sets this timer.
            title: i18n._(msg`Agent paused`),
            message: pausedMessage,
            variant: 'info',
            onOpen: task && pausedProjectId
              ? () => { openTaskFromNotification(pausedProjectId, task.id); }
              : undefined,
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
        // A click carrying no task can still only mean "go to that project".
        if (!taskId) {
          useSessionStore.getState().requestHideCommandBar();
          useProjectStore.getState().openProject(projectId);
          return;
        }
        // Shared with a click on a toast about a task. Also the path the DETACHED
        // monitor takes: its row click routes through main and re-emits here, so
        // pop-out and in-app behave identically.
        openTaskFromNotification(projectId, taskId);
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
    if (boardConfig?.onWarnings) {
      cleanups.push(boardConfig.onWarnings((warnedProjectId, warnings) => {
        useBoardStore.getState().receiveOpenConfigWarnings(warnedProjectId, warnings);
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
    const automations = window.electronAPI?.automations;

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
      cleanups.push(tasks.onSpawnBlocked((blockedTaskId, taskTitle, message, blockedProjectId) => {
        const activeProjectId = useProjectStore.getState().currentProject?.id;
        if (blockedProjectId && blockedProjectId !== activeProjectId) return;
        const openProjectId = blockedProjectId ?? activeProjectId;
        useToastStore.getState().addToast({
          // Deliberately verb-free about how the task got here. This same event
          // fires from create, promote, unarchive and MCP auto-spawn, and only
          // the first of those created anything - "was created" would be a lie
          // on three of the four paths. Main words the reason; the title says
          // the agent did not start, so the body leads with the task.
          title: i18n._(msg`Agent didn't start`),
          message: `"${taskTitle}": ${asSentence(message)}`,
          variant: 'warning',
          durationMs: 12000,
          onOpen: openProjectId
            ? () => { openTaskFromNotification(openProjectId, blockedTaskId); }
            : undefined,
        });
      }));
    }

    // A resume found the agent had deleted the conversation, so the task
    // started a new one from a recap of the task. The push is a signal: main
    // queued the notice first, and this takes the queue rather than toasting
    // the payload, so the project-switch take (useProjectSwitchEffect) and
    // this one never show the same notice twice. Current project only, as
    // onSpawnBlocked: the toast names a task from that project's board, and a
    // notice for another project waits in main until it becomes current.
    if (tasks?.onConversationExpired) {
      cleanups.push(tasks.onConversationExpired((notice) => {
        const activeProjectId = useProjectStore.getState().currentProject?.id;
        if (!activeProjectId || notice.projectId !== activeProjectId) return;
        void showConversationExpiredNotices(activeProjectId);
      }));
    }

    // The agent started, but from a base that could not be freshened (network
    // or credential fetch failure). Main composes the whole message and
    // cooldown-guards it, so this toasts verbatim. Current project only, same
    // as onSpawnBlocked: the message names a task from that project's board.
    if (tasks?.onSpawnWarning) {
      cleanups.push(tasks.onSpawnWarning((_taskId, message, warningProjectId, kind) => {
        const activeProjectId = useProjectStore.getState().currentProject?.id;
        if (warningProjectId && warningProjectId !== activeProjectId) return;
        useToastStore.getState().addToast({
          title: kind === 'setup-script-failed'
            ? i18n._(msg`Setup script failed`)
            : i18n._(msg`Base branch not refreshed`),
          message,
          variant: 'warning',
          durationMs: 12000,
        });
      }));
    }

    // A sync write to the data directory (config or one of the other small
    // per-machine/per-project state files) failed - DESKTOP-14/DESKTOP-13. Main
    // composes the body (the cause, and that the change may be lost) and
    // latches it per failing source, so this toasts it verbatim under its
    // title, same as onSpawnWarning. Not project-filtered: an unwritable data
    // directory is a machine-level condition, not one tied to whichever
    // project happens to be open.
    if (window.electronAPI?.config?.onWriteFailed) {
      cleanups.push(window.electronAPI.config.onWriteFailed((message) => {
        useToastStore.getState().addToast({
          title: i18n._(msg`Change not saved to disk`),
          message,
          variant: 'error',
          durationMs: 12000,
        });
      }));
    }

    // What a task left running when it reached Done or To Do, or was deleted
    // (src/main/pty/process-tag/). The toast gives counts and opens the list
    // with the names: a timed toast when its card is clicked, one that stays
    // up through Review. Not project-filtered: a delete or the startup sweep
    // in a background project still leaves processes on this machine.
    if (window.electronAPI?.leftoverProcesses?.onReport) {
      cleanups.push(window.electronAPI.leftoverProcesses.onReport((report) => {
        const toast = describeLeftoverReport(report);
        if (!toast) return;
        const openList = () => useLeftoverProcessesStore.getState().openReport(report.id);
        // Stays while something is still running or could not be stopped, so
        // the list stays reachable; the leftover store closes it once every
        // such process has stopped.
        const fields = { title: toast.title, message: toast.message, variant: toast.variant, since: toast.since };
        const toastId = toast.sticky
          ? useToastStore.getState().addToast({
            ...fields,
            persistent: true,
            action: { label: i18n._(msg`Review`), icon: 'review', onClick: openList },
          })
          : useToastStore.getState().addToast({ ...fields, onOpen: openList });
        // A toast whose report the store no longer keeps opens nothing, so it
        // closes with its report.
        for (const evictedToastId of useLeftoverProcessesStore.getState().addReport(report, toastId)) {
          useToastStore.getState().dismissToast(evictedToastId);
        }
      }));
    }
    // A Stop main gave up waiting for reads `failed`; the host finished it
    // anyway, and its row takes the real outcome. No toast: the row was wrong.
    if (window.electronAPI?.leftoverProcesses?.onStopSettled) {
      cleanups.push(window.electronAPI.leftoverProcesses.onStopSettled((settled) => {
        useLeftoverProcessesStore.getState().settleStop(settled.processId, settled.outcome);
      }));
    }

    // This install cannot update itself until the user moves it - DESKTOP-1A,
    // the macOS read-only-volume case. Main composes the body and latches it
    // for the app's lifetime, so this toasts it verbatim under its title, same
    // as onWriteFailed above. Persistent rather than timed: unlike a failed
    // write, this does not resolve on its own, and the updater already uses a
    // persistent toast for the other thing the user has to act on (see
    // updater-store's no-release-notes branch).
    if (window.electronAPI?.updater?.onUpdateBlocked) {
      cleanups.push(window.electronAPI.updater.onUpdateBlocked((message) => {
        useToastStore.getState().addToast({
          title: i18n._(msg`Updates blocked`),
          message,
          variant: 'warning',
          persistent: true,
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
        const openProjectId = result.projectId ?? activeProjectId;
        const openTask = openProjectId
          ? () => { openTaskFromNotification(openProjectId, result.taskId); }
          : undefined;
        const taskTitle = result.taskTitle;
        const command = result.command;

        if (result.state === 'failed') {
          // Main's reason is its own sentence, so it follows the one that
          // names the task, and stays as main wrote it.
          const reason = result.reason ? ` ${asSentence(result.reason)}` : '';
          const notRunSentence = i18n._(msg`"${taskTitle}" did not run ${command}.`);
          useToastStore.getState().addToast({
            title: i18n._(msg`Command didn't run`),
            message: `${notRunSentence}${reason}`,
            variant: 'warning',
            durationMs: 12000,
            onOpen: openTask,
          });
          return;
        }

        // Delivered, but it cost the user something, so say what. Clearing
        // typed text is defensible; doing it silently is not. A draft cleared
        // and a turn interrupted never come together, so five sentences cover
        // every cost, each one whole message.
        let ranSentence: string | null = null;
        if (result.escalated) {
          if (result.discardedDraft) {
            ranSentence = i18n._(msg`"${taskTitle}" ran ${command}, cleared your unsent text and restarted the session to deliver it.`);
          } else if (result.interruptedTurn) {
            ranSentence = i18n._(msg`"${taskTitle}" ran ${command}, interrupted the agent mid-task and restarted the session to deliver it.`);
          } else {
            ranSentence = i18n._(msg`"${taskTitle}" ran ${command} and restarted the session to deliver it.`);
          }
        } else if (result.discardedDraft) {
          ranSentence = i18n._(msg`"${taskTitle}" ran ${command} and cleared your unsent text.`);
        } else if (result.interruptedTurn) {
          ranSentence = i18n._(msg`"${taskTitle}" ran ${command} and interrupted the agent mid-task.`);
        }
        if (ranSentence === null) return;

        useToastStore.getState().addToast({
          title: i18n._(msg`Command ran`),
          message: ranSentence,
          variant: 'info',
          durationMs: 12000,
          onOpen: openTask,
        });
      }));
    }


    // An automation did not do what the board says it does. Main pushes only
    // failures, and rations them to one per automation per minute (see
    // automation-run-outcome.ts), so anything arriving here is worth a toast.
    // Current project only: the message names a column and a task the user
    // cannot see from another project.
    if (automations?.onRunFailed) {
      cleanups.push(automations.onRunFailed((failure) => {
        const activeProjectId = useProjectStore.getState().currentProject?.id;
        if (failure.projectId && failure.projectId !== activeProjectId) return;
        // The toast outlives a project switch, so both of its actions carry the
        // failure's project rather than reading the open one at the click. A
        // push with no project (main sends '' when it had none) belongs to the
        // open one, as the guard above already treats it.
        const failureProjectId = failure.projectId || activeProjectId || null;

        // The task first, as the "Agent didn't start" toast does: it is what the
        // user acts on, and the toast can sit on a board that does not show it.
        // Then the automation AND the column, because neither alone locates it:
        // two columns can hold rows with the same name. A bulk move that fails
        // many tasks raises one toast (main's rationing), naming the first task,
        // which is the one Run again acts on; the run log holds the rest.
        // Main's detail is its own sentence and stays as main wrote it.
        const detail = failure.detail ? ` ${asSentence(failure.detail)}` : '';
        const taskTitle = failure.taskTitle;
        const automationName = failure.automationName;
        const columnName = failure.columnName;
        const failedSentence = i18n._(msg`"${taskTitle}": "${automationName}" failed on ${columnName}.`);
        const failureToastId = useToastStore.getState().addToast({
          title: i18n._(msg`Automation failed`),
          message: `${failedSentence}${detail}`,
          variant: 'warning',
          // Stays so Run again is there when the user reaches for it. A card
          // click opens the task and leaves the toast up (ToastItem keeps a card
          // with a button), so the user can look before running it again.
          persistent: true,
          onOpen: failureProjectId
            ? () => { openTaskFromNotification(failureProjectId, failure.taskId); }
            : undefined,
          // Re-runs against the task's CURRENT state, which the result says,
          // because the task may have moved twice since the failure. An
          // interrupted run is offered the same action: it is the one status
          // where the work definitely did not finish.
          action: {
            label: i18n._(msg`Run again`),
            icon: 'retry',
            onClick: () => {
              // The result toast takes over from here, and a failure left up
              // beside it would invite a second run.
              useToastStore.getState().dismissToast(failureToastId);
              void useBoardStore.getState()
                .runAutomationAgain(failure.automationId, failure.taskId, failureProjectId)
                .then((result) => {
                  if (!result.ok) {
                    // The run never started (a deleted automation, a closed project).
                    useToastStore.getState().addToast({
                      title: i18n._(msg`Couldn't run again`),
                      message: asSentence(result.error),
                      variant: 'error',
                      durationMs: 8000,
                    });
                    return;
                  }
                  const succeeded = result.status === 'succeeded';
                  // A run that did not succeed says why after the sentence.
                  const resultDetail = !succeeded && result.detail ? ` ${asSentence(result.detail)}` : '';
                  useToastStore.getState().addToast({
                    title: i18n._(msg`Ran again`),
                    message: `${runAgainOutcomeSentence(result.status, result.automationName)}${resultDetail}`,
                    variant: succeeded ? 'success' : 'warning',
                    durationMs: 8000,
                  });
                })
                .catch((error: unknown) => {
                  useToastStore.getState().addToast({
                    title: i18n._(msg`Couldn't run again`),
                    message: asSentence(describeIpcError(error, ''), i18n._(msg`The automation did not start.`)),
                    variant: 'error',
                    durationMs: 8000,
                  });
                });
            },
          },
        });
      }));
    }

    // Runs a quit left mid-flight, swept on project open. One notice for the
    // whole sweep, never one per row: the shutdown path is synchronous by rule,
    // so this is expected after any quit during a move and a per-row storm
    // would make it noise.
    if (automations?.onRunsInterrupted) {
      cleanups.push(automations.onRunsInterrupted((summary) => {
        const activeProjectId = useProjectStore.getState().currentProject?.id;
        if (summary.projectId && summary.projectId !== activeProjectId) return;
        const interruptedCount = summary.count;
        useToastStore.getState().addToast({
          title: i18n._(msg`${plural(interruptedCount, { one: 'Automation interrupted', other: 'Automations interrupted' })}`),
          message: i18n._(msg`${plural(interruptedCount, {
            one: "# automation didn't finish before Kangentic closed.",
            other: "# automations didn't finish before Kangentic closed.",
          })}`),
          variant: 'info',
          durationMs: 10000,
        });
      }));
    }
    // Task auto-moved (plan exit → next column)
    if (tasks?.onAutoMoved) {
      cleanups.push(tasks.onAutoMoved((autoMovedTaskId, targetSwimlaneId, taskTitle, autoMoveProjectId) => {
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
        // Active project only, like every other toast (exit, idle, idle-timeout,
        // spawn-stall). An auto-move on a BACKGROUND project used to toast here
        // unconditionally, naming a task on a board the user is not looking at -
        // and the desktop notification below fires for exactly that case, so the
        // one event raised both alerts at once.
        const isActiveProjectMove = !autoMoveProjectId || autoMoveProjectId === activeProjectId;
        if (isActiveProjectMove && notifyConfig.toasts.onPlanComplete) {
          // The board on screen is the move's own, so its columns name the target.
          const columnName = useBoardStore.getState().swimlanes.find((lane) => lane.id === targetSwimlaneId)?.name;
          const movedProjectId = autoMoveProjectId ?? activeProjectId;
          useToastStore.getState().addToast({
            title: i18n._(msg`Plan complete`),
            message: columnName !== undefined
              ? i18n._(msg`Moved "${taskTitle}" to ${columnName}.`)
              : i18n._(msg`Moved "${taskTitle}" to the next column.`),
            variant: 'success',
            onOpen: movedProjectId
              ? () => { openTaskFromNotification(movedProjectId, autoMovedTaskId); }
              : undefined,
          });
        }

        // Desktop notification for auto-moves on non-visible projects
        if (autoMoveProjectId && notifyConfig.desktop.onPlanComplete) {
          shouldNotify(`automove:${autoMovedTaskId}`, autoMoveProjectId).then((notify) => {
            if (!notify) return;
            const project = useProjectStore.getState().projects.find((p) => p.id === autoMoveProjectId);
            sendNotification(
              `automove:${autoMovedTaskId}`,
              i18n._(msg`Plan complete: ${taskTitle}`),
              project?.name ?? i18n._(msg`A project`),
              autoMoveProjectId,
              autoMovedTaskId,
            );
          });
        }
      }));
    }
    // Every task in a workflow reached Done. Shaped like Plan Complete: a toast
    // for the project on screen, a desktop notification through the same
    // focus gate and cooldown for one that is not.
    if (tasks?.onWorkflowCompleted) {
      cleanups.push(tasks.onWorkflowCompleted((completed) => {
        const notifyConfig = useConfigStore.getState().config.notifications;
        const activeProjectId = useProjectStore.getState().currentProject?.id;
        const workflowTitle = completed.title;
        if (completed.projectId === activeProjectId && notifyConfig.toasts.onWorkflowComplete) {
          const taskCount = completed.taskCount;
          useToastStore.getState().addToast({
            title: i18n._(msg`Workflow complete`),
            message: i18n._(msg`${plural(taskCount, {
              one: `The task of "${workflowTitle}" is in Done.`,
              other: `All # tasks of "${workflowTitle}" are in Done.`,
            })}`),
            variant: 'success',
            // No `onOpen`: a finished workflow leaves every list, so there is
            // nothing for the card to open. A task's Workflow panel disables
            // its Open for a finished workflow for the same reason.
          });
        }
        if (notifyConfig.desktop.onWorkflowComplete) {
          const notificationKey = `workflow-complete:${completed.workflowId}`;
          shouldNotify(notificationKey, completed.projectId).then((notify) => {
            if (!notify) return;
            const project = useProjectStore.getState().projects.find((candidate) => candidate.id === completed.projectId);
            // No task: a click on it goes to the workflow's project.
            sendNotification(
              notificationKey,
              i18n._(msg`Workflow complete: ${workflowTitle}`),
              project?.name ?? i18n._(msg`A project`),
              completed.projectId,
              '',
            );
          });
        }
      }));
    }
    // A running workflow stalled on a task. Main raises the desktop
    // notification itself (it must reach a user with no window open); this is
    // the toast, for the project on screen.
    if (tasks?.onWorkflowStalled) {
      cleanups.push(tasks.onWorkflowStalled((stalled) => {
        const notifyConfig = useConfigStore.getState().config.notifications;
        const activeProjectId = useProjectStore.getState().currentProject?.id;
        if (stalled.projectId !== activeProjectId || !notifyConfig.toasts.onWorkflowStalled) return;
        useToastStore.getState().addToast({
          title: i18n._(msg`Workflow stalled`),
          message: stalled.taskTitle ? `"${stalled.taskTitle}": ${stalled.reason}` : stalled.reason,
          variant: 'warning',
          onOpen: () => { openTaskFromNotification(stalled.projectId, stalled.taskId); },
        });
      }));
    }
    // A workflow or its tasks changed, whoever changed it: the Workflows view
    // (and its segment's count) reloads that one workflow.
    const workflows = window.electronAPI?.workflows;
    if (workflows?.onChanged) {
      cleanups.push(workflows.onChanged((changed) => useWorkflowStore.getState().handleChanged(changed)));
    }

    return () => {
      cleanups.forEach((fn) => fn());
    };
  }, [upsertSession, removeSession, updateSessionStatus, updateActivity]);

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
// A store that is not instance-pinned reverts to its defaults when HMR replaces
// its module, and re-fetching from the main process restores it. The stores in
// PATTERN_E_STORES (tests/unit/hmr-resync.test.ts), board, backlog, project,
// session and config among them, are instance-pinned (Pattern E in
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
    // Same for a cross-column drop gap: parted cards, a held settle, a visible slot card.
    clearDropGapDom();

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
    // The version never changes in a session, but the store holding it can be new: an
    // update that finds no pinned instance builds one with no version, and the status
    // bar drops its version pill.
    useConfigStore.getState().loadAppVersion();
    useBoardStore.getState().loadBoard();
    useBoardStore.getState().loadBoardProfiles();
    useBoardStore.getState().loadAutomations();
    useBacklogStore.getState().loadBacklog();
    useWorkflowStore.getState().loadWorkflows();
    useWorkflowStore.getState().loadSupersessions();
    useWorkflowStore.getState().loadDetail();
    useWorkflowStore.getState().loadHomeSummaries(Object.keys(useWorkflowStore.getState().homeSummaries));
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
    // Knowledge Graph Pattern B: re-read the cached projection + coverage from
    // main-process truth (no-ops while the surface is closed).
    // The Projects list and every project in a scope are main-process truth too.
    // Marked as pushes: a save is a refresh, not the reader acting, so it never
    // starts a rebuild of a stale map on its own. A window following the main
    // one re-reads with null, as its own pushes do, so it keeps following.
    if (useKnowledgeGraphStore.getState().graphOpen) {
      const knowledgeGraph = useKnowledgeGraphStore.getState();
      const asRefresh = { fromPush: true };
      void knowledgeGraph.loadSnapshot(knowledgeGraph.followsCurrentProject ? null : knowledgeGraph.projectId, asRefresh);
      void knowledgeGraph.loadProjects();
      // The open project's island comes from loadSnapshot above.
      for (const scopedProjectId of knowledgeGraph.scopeProjectIds ?? []) {
        if (scopedProjectId !== knowledgeGraph.projectId) void knowledgeGraph.loadScopeSnapshot(scopedProjectId, asRefresh);
      }
    }
    // Pop-out windows Pattern B: re-hydrate which surfaces are currently detached.
    usePopOutStore.getState().loadOpen();
    // Offscreen browser surfaces Pattern B: main is the only authority, and a
    // surface can sit unchanged across the whole session, so the push alone
    // would leave the card globe dark after a Fast Refresh.
    void useSessionStore.getState().loadBrowserOffscreenTasks();
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
    monitor: useMonitorStore,
    commandWindow: commandWindowManager.store,
    knowledgeGraphWindows: knowledgeGraphWindowManager.store,
    usageDashboard: useUsageDashboardStore,
    knowledgeGraph: useKnowledgeGraphStore,
    popOut: usePopOutStore,
    dictation: useDictationStore,
    announcements: useAnnouncementsStore,
    // Not IPC-backed like the rest, but exposed for the same reason: without it
    // a UI test cannot raise an arbitrary toast and has to borrow whichever push
    // happens to toast verbatim (`config:writeFailed`), which drags unrelated
    // setup into a test about toasts.
    toast: useToastStore,
    // So a UI test can open and clear the board's links overlay in the same
    // task it then reads, to catch the overlay's fade while it runs.
    workflow: useWorkflowStore,
  };
}

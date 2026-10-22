import { useProjectStore } from '../stores/project-store';
import { useSessionStore } from '../stores/session-store';

/**
 * Open a task's detail because the user acted on a notification about it: an
 * OS notification click, or a click on a toast about the task. Both mean the
 * same thing, so they share one path.
 *
 * The current project is re-read here rather than captured by the caller: a
 * toast stays up for `durationSeconds`, and the user can switch projects
 * before clicking it.
 *
 * In a pop-out window (the detached Agent Monitor, a detached Knowledge Graph)
 * there is no board to open it on, so main decides where it opens, as the
 * monitor's own "Open on board" does.
 */
export function openTaskFromNotification(notifyProjectId: string, notifyTaskId: string): void {
  if (window.electronAPI?.popOut?.descriptor) {
    void window.electronAPI.monitor.revealTask(notifyProjectId, notifyTaskId);
    return;
  }
  // The Command Terminal layer is top-layered over the board, so opening a
  // task detail underneath it leaves the user looking at a terminal they did
  // not ask for. A cross-project click closes the layer anyway (close-on-
  // project-switch); this covers the same-project case. Every PTY stays alive.
  //
  // The toast caller can hit this while the user is PRESENT and typing in a
  // Command Terminal, which the OS-click caller cannot. Hiding it anyway is
  // deliberate: clicking a toast names a task, and a detail window opening
  // behind the layer is the worse outcome. The layer reopens on Ctrl+Shift+P
  // with every terminal reattached.
  useSessionStore.getState().requestHideCommandBar();
  // agent-focus-ok: acting on a notification is the user asking for this task,
  // so the detail it opens SHOULD take focus. The OS-click path arrives over an
  // IPC push like the agent's does, which is why the origin is stated here
  // rather than inferred. See .claude/rules/agent-driven-focus.md.
  if (useProjectStore.getState().currentProject?.id === notifyProjectId) {
    useSessionStore.getState().setDetailTaskId(notifyTaskId);
  } else {
    useSessionStore.getState().setPendingOpenTaskId(notifyTaskId);
    // A switch that did not land must not leave the id for the next switch
    // to open, as the search palette and the Knowledge Graph also clear it.
    void useProjectStore.getState().openProject(notifyProjectId).then((outcome) => {
      if (outcome !== 'opened') useSessionStore.getState().setPendingOpenTaskId(null);
    });
  }
}

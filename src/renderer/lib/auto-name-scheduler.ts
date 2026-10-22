/**
 * Auto-name-from-prompt scheduler for TASKS, wired into the renderer's session
 * listener:
 *
 *   - `scheduleAutoNameSuggestion(session)` schedules a 30-second timer for a
 *     placeholder-titled task. When it fires, the Automation agent generates a
 *     title from the task's description, and Kangentic applies it at the
 *     session's next idle edge. There is no suggestion to accept: the title only
 *     ever replaces a placeholder, so the user loses nothing. A task the timer
 *     fired for is marked asked for the run, and persisted once it proves
 *     nameable, so the next launch does not try it again.
 *
 * Why the idle edge: main's task update renames the task's worktree branch with
 * its title, and skips that rename while the agent is working, since git work
 * may be in flight (`task-crud.ts`). A title applied mid-turn would leave the
 * branch on its placeholder name for good.
 *
 * The task is read from its OWN project: the open board when that project is on
 * screen, otherwise main's copy (`monitor.getTaskDetail`). The save is stamped
 * with that project, so a task in a background project is named the same way.
 *
 * A Command Terminal is named in main instead (`command-terminal-namer.ts`),
 * because a terminal a phone started, or one in a project this renderer does
 * not have open, has no renderer code watching its prompts.
 *
 * The module owns three pieces of mutable state:
 *
 *   - `autoNameTimers`            taskId -> setTimeout handle
 *   - `autoNameAsked`             taskIds named (or tried) this app run
 *   - `autoRenamesAwaitingIdle`   taskId -> a generated title waiting for the
 *                                 session's idle edge, and its store listener
 *
 * The HMR block at the bottom (a no-op in vitest, where `import.meta.hot` is
 * undefined) keeps `autoNameAsked` and the waiting titles across hot reloads, so
 * a renderer module replacement neither re-names a task nor loses a title that
 * was already generated.
 */
import type { Session, Task } from '../../shared/types';
import { namingAgentReady } from '../../shared/answer-agent';
import { requiresUserInteraction } from '../../shared/activity-state';
import { useBoardStore } from '../stores/board-store';
import { useConfigStore } from '../stores/config-store';
import { useProjectStore } from '../stores/project-store';
import { useSessionStore } from '../stores/session-store';
import { useToastStore } from '../stores/toast-store';
import { invalidateProject } from '../stores/project-cache';
import { openTaskFromNotification } from '../utils/open-task-from-notification';
import { describeIpcError, asSentence } from './ipc-error';
import { isPlaceholderTitle } from './placeholder-title';

/** A generated title waiting for its session to stop working. Plain data, so it survives HMR. */
export interface PendingAutoRename {
  taskId: string;
  sessionId: string;
  projectId: string;
  title: string;
}

// @ts-expect-error -- Vite handles import.meta.hot
const preservedAutoName = import.meta.hot?.data?.autoNameState as
  | { askedTaskIds: string[]; pendingRenames?: PendingAutoRename[] }
  | undefined;

export const autoNameTimers = new Map<string, ReturnType<typeof setTimeout>>();
export const autoNameAsked = new Set<string>(preservedAutoName?.askedTaskIds ?? []);
export const autoRenamesAwaitingIdle = new Map<string, { rename: PendingAutoRename; stopWatching: () => void }>();

/** Persist a taskId to `AppConfig.autoNameAskedTaskIds`, so the next launch does not try it again. */
function persistAutoNameAsked(taskId: string): void {
  const persisted = useConfigStore.getState().config.autoNameAskedTaskIds ?? [];
  if (persisted.includes(taskId)) return;
  void useConfigStore.getState().updateConfig({
    autoNameAskedTaskIds: [...persisted, taskId],
  });
}

/** True when the Automation agent can name tasks: chosen, installed, with a model
 *  when it needs one, and able to summarize. The IPC handler refuses on the same
 *  predicate (`namingAgentReady`), so a title is never asked for a call main
 *  would refuse. With no Automation agent, naming is off. */
export function automationAgentCanName(): boolean {
  const { agentList, globalConfig } = useConfigStore.getState();
  return namingAgentReady(agentList, globalConfig.automation, true);
}

function isOpenProject(projectId: string): boolean {
  return useProjectStore.getState().currentProject?.id === projectId;
}

/** A task the scheduler may name: its title is still a placeholder, and it has a description to name it from. */
function canBeNamed(task: Task): boolean {
  return isPlaceholderTitle(task.title, task.id) && task.description.trim().length > 0;
}

/** The task as its own project stores it, or null when it is gone. */
async function readTask(projectId: string, taskId: string): Promise<Task | null> {
  if (isOpenProject(projectId)) {
    return useBoardStore.getState().tasks.find((entry) => entry.id === taskId) ?? null;
  }
  const bundle = await window.electronAPI.monitor.getTaskDetail(projectId, taskId);
  return bundle?.task ?? null;
}

/** Schedule a one-shot 30-second timer that names a task whose title still
 *  looks like a placeholder. Fires once per task per app run. */
export function scheduleAutoNameSuggestion(session: Session): void {
  if (session.transient) return;
  if (session.status !== 'running') return;
  if (!session.taskId) return;
  if (autoNameAsked.has(session.taskId)) return;
  if (autoNameTimers.has(session.taskId)) return;

  const config = useConfigStore.getState().config;
  // Persisted: if a previous app session already named (or tried) this task,
  // never try again. Seeding lazily here avoids needing a config-load watcher.
  if (config.autoNameAskedTaskIds?.includes(session.taskId)) {
    autoNameAsked.add(session.taskId);
    return;
  }

  // On the open board the task is at hand, so one that cannot be named never
  // starts a timer. A task of another project is read from main when it fires.
  if (isOpenProject(session.projectId)) {
    const task = useBoardStore.getState().tasks.find((entry) => entry.id === session.taskId);
    if (!task || !canBeNamed(task)) return;
  }

  if (!automationAgentCanName()) return;

  const timer = setTimeout(() => {
    autoNameTimers.delete(session.taskId);
    // Once per task per app run. It persists only once the task proves
    // nameable (`generateTitle`): a background project's timer starts without
    // the board gate, and persisting every task it fires for would write the
    // config once per agent, real titles included.
    autoNameAsked.add(session.taskId);
    void generateTitle(session);
  }, 30_000);
  autoNameTimers.set(session.taskId, timer);
}

async function generateTitle(session: Session): Promise<void> {
  try {
    // Re-check: the user may have named the task in the 30 seconds since spawn.
    const task = await readTask(session.projectId, session.taskId);
    if (!task || !canBeNamed(task)) return;

    // Skip if the session crashed or was suspended in those 30 seconds.
    const liveSession = useSessionStore.getState().sessions.find((entry) => entry.id === session.id);
    if (!liveSession || liveSession.status !== 'running') return;

    persistAutoNameAsked(session.taskId);
    const result = await window.electronAPI.agent.summarize({
      prompt: task.description,
      projectId: session.projectId,
      taskId: session.taskId,
    });
    if (!result.ok || !result.title) return;
    renameAtIdleEdge({ taskId: session.taskId, sessionId: session.id, projectId: session.projectId, title: result.title });
  } catch {
    // Non-essential: a title that could not be generated leaves the placeholder.
  }
}

type IdleEdgeVerdict = 'apply' | 'wait' | 'drop';

function idleEdgeVerdict(
  state: Pick<ReturnType<typeof useSessionStore.getState>, 'sessions' | 'sessionActivity'>,
  sessionId: string,
): IdleEdgeVerdict {
  const session = state.sessions.find((entry) => entry.id === sessionId);
  // Removed, suspended or exited: this session reaches no idle edge, and the
  // listener must not outlive it.
  if (!session || session.status !== 'running') return 'drop';
  return requiresUserInteraction(state.sessionActivity[sessionId]) ? 'apply' : 'wait';
}

function stopWaitingForIdle(taskId: string): void {
  const waiting = autoRenamesAwaitingIdle.get(taskId);
  if (!waiting) return;
  autoRenamesAwaitingIdle.delete(taskId);
  waiting.stopWatching();
}

/** Apply the title now if the session already waits on the user, else at the
 *  moment it starts to. A later call for the same task replaces this one. */
function renameAtIdleEdge(rename: PendingAutoRename): void {
  stopWaitingForIdle(rename.taskId);
  const verdict = idleEdgeVerdict(useSessionStore.getState(), rename.sessionId);
  if (verdict === 'apply') {
    void applyGeneratedTitle(rename);
    return;
  }
  if (verdict === 'drop') return;
  const stopWatching = useSessionStore.subscribe((state) => {
    const next = idleEdgeVerdict(state, rename.sessionId);
    if (next === 'wait') return;
    stopWaitingForIdle(rename.taskId);
    if (next === 'apply') void applyGeneratedTitle(rename);
  });
  autoRenamesAwaitingIdle.set(rename.taskId, { rename, stopWatching });
}

async function applyGeneratedTitle(rename: PendingAutoRename): Promise<void> {
  const { taskId, projectId, title } = rename;
  try {
    // The user may have named the task while the agent worked.
    const task = await readTask(projectId, taskId);
    if (!task || !isPlaceholderTitle(task.title, task.id)) return;
  } catch (error) {
    console.warn('[AUTO-NAME] Could not read the task before renaming it:', error);
    return;
  }

  let saved: Task;
  try {
    saved = await window.electronAPI.tasks.update({ id: taskId, title }, projectId);
  } catch (error) {
    // Only the project on screen hears about it: a failure in a background
    // project would name nothing the user can see.
    if (isOpenProject(projectId)) {
      useToastStore.getState().addToast({
        title: "Couldn't rename task",
        message: asSentence(describeIpcError(error, ''), 'The new title was not saved.'),
        variant: 'error',
      });
    } else {
      console.warn('[AUTO-NAME] Could not rename a task in a background project:', error);
    }
    return;
  }

  // Re-read after the save: the user may have switched projects meanwhile.
  if (!isOpenProject(projectId)) {
    // Main sends the main window no push for its own write, so drop the
    // project's warm snapshot, or a switch back would restore the placeholder.
    invalidateProject(projectId);
    return;
  }
  useBoardStore.setState((state) => ({
    tasks: state.tasks.map((entry) => (entry.id === saved.id ? saved : entry)),
    archivedTasks: state.archivedTasks.map((entry) => (entry.id === saved.id ? saved : entry)),
  }));
  useToastStore.getState().addToast({
    title: 'Task renamed',
    message: `"${saved.title}" replaces the placeholder title.`,
    variant: 'info',
    durationMs: 12_000,
    onOpen: () => openTaskFromNotification(projectId, taskId),
  });
}

/** Cancel pending timers and idle-edge waits, and clear all in-memory state.
 *  Intended for HMR dispose and for unit tests that need a fresh module state
 *  between cases. */
export function cancelAutoNameTimersAndClear(): void {
  for (const timer of autoNameTimers.values()) clearTimeout(timer);
  autoNameTimers.clear();
  for (const { stopWatching } of autoRenamesAwaitingIdle.values()) stopWatching();
  autoRenamesAwaitingIdle.clear();
  autoNameAsked.clear();
}

// A title generated before a hot reload waits for its idle edge again here.
for (const rename of preservedAutoName?.pendingRenames ?? []) renameAtIdleEdge(rename);

// HMR persistence: clear pending timers and store listeners on dispose, and save
// the asked set and the waiting titles so a hot reload neither re-names a task
// nor loses a generated title. Vitest provides no `import.meta.hot`, so this
// block is a no-op under unit tests.
//
// One dev-only gap is accepted: a title still being generated when the reload
// lands finishes in the old module, which waits for the idle edge and applies
// the title there, outside the state stashed here.
// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    for (const timer of autoNameTimers.values()) clearTimeout(timer);
    autoNameTimers.clear();
    const pendingRenames = [...autoRenamesAwaitingIdle.values()].map(({ rename }) => rename);
    for (const { stopWatching } of autoRenamesAwaitingIdle.values()) stopWatching();
    autoRenamesAwaitingIdle.clear();
    data.autoNameState = {
      askedTaskIds: [...autoNameAsked],
      pendingRenames,
    };
  });
}

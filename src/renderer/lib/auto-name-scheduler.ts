/**
 * Auto-name-from-prompt scheduler for TASKS. Two pure-ish functions wired into
 * the renderer's session listener:
 *
 *   - `scheduleAutoNameSuggestion(session)` schedules a 30-second timer that
 *     fires a "Rename to <X>?" toast for placeholder-titled tasks.
 *   - `markAutoNameAsked(taskId)` records that a task has been offered a
 *     suggestion and persists it so the next launch does not re-ask.
 *
 * A Command Terminal is named in main instead (`command-terminal-namer.ts`),
 * because a terminal a phone started, or one in a project this renderer does
 * not have open, has no renderer code watching its prompts.
 *
 * The module owns two Sets/Maps of mutable state:
 *
 *   - `autoNameTimers`       taskId -> setTimeout handle
 *   - `autoNameAsked`        taskIds we have asked about this app run
 *
 * The HMR preservation block at the bottom (no-op in vitest, where
 * `import.meta.hot` is undefined) keeps `autoNameAsked` across hot reloads so a
 * renderer module replacement does not double-fire timers or re-prompt tasks
 * already considered.
 */
import type { Session } from '../../shared/types';
import { useProjectStore } from '../stores/project-store';
import { useBoardStore } from '../stores/board-store';
import { useConfigStore } from '../stores/config-store';
import { useSessionStore } from '../stores/session-store';
import { useToastStore } from '../stores/toast-store';
import { isPlaceholderTitle } from './placeholder-title';

// @ts-expect-error -- Vite handles import.meta.hot
const preservedAutoName = import.meta.hot?.data?.autoNameState as
  | { askedTaskIds: string[] }
  | undefined;

export const autoNameTimers = new Map<string, ReturnType<typeof setTimeout>>();
export const autoNameAsked = new Set<string>(preservedAutoName?.askedTaskIds ?? []);

/** Add a taskId to the asked set and persist to AppConfig. Idempotent. */
export function markAutoNameAsked(taskId: string): void {
  if (autoNameAsked.has(taskId)) return;
  autoNameAsked.add(taskId);
  const persisted = useConfigStore.getState().config.autoNameAskedTaskIds ?? [];
  if (persisted.includes(taskId)) return;
  void useConfigStore.getState().updateConfig({
    autoNameAskedTaskIds: [...persisted, taskId],
  });
}

/** Returns true if the given project's default agent has the summarize capability
 *  AND is detected on disk. The IPC handler resolves to the same adapter, so this
 *  keeps the renderer-side gating consistent with what the main process can satisfy. */
export function projectAgentCanSummarize(projectId: string | null | undefined): boolean {
  if (!projectId) return false;
  const project = useProjectStore.getState().projects.find((entry) => entry.id === projectId);
  if (!project) return false;
  const adapterName = project.default_agent;
  if (!adapterName) return false;
  const adapter = useConfigStore.getState().agentList.find((entry) => entry.name === adapterName);
  return !!adapter?.found && !!adapter?.supportsSummarize;
}

/** Schedule a one-shot 30-second timer that suggests renaming a task whose
 *  title still looks like a placeholder. Fires once per task per app run. */
export function scheduleAutoNameSuggestion(session: Session): void {
  if (session.transient) return;
  if (session.status !== 'running') return;
  if (!session.taskId) return;
  if (autoNameAsked.has(session.taskId)) return;
  if (autoNameTimers.has(session.taskId)) return;

  const config = useConfigStore.getState().config;
  // Persisted dismissal: if a previous app session already asked for this task,
  // never re-ask. Seeding lazily here avoids needing a config-load watcher.
  if (config.autoNameAskedTaskIds?.includes(session.taskId)) {
    autoNameAsked.add(session.taskId);
    return;
  }

  const task = useBoardStore.getState().tasks.find((entry) => entry.id === session.taskId);
  if (!task) return;
  if (!isPlaceholderTitle(task.title, task.id)) return;
  if (!task.description.trim()) return;

  if (!projectAgentCanSummarize(session.projectId)) return;

  const timer = setTimeout(async () => {
    autoNameTimers.delete(session.taskId);
    markAutoNameAsked(session.taskId);

    // Re-check the latest title in case the user has renamed it manually.
    const latest = useBoardStore.getState().tasks.find((entry) => entry.id === session.taskId);
    if (!latest || !isPlaceholderTitle(latest.title, latest.id)) return;

    // Skip if the session crashed or was suspended in the 30 seconds since spawn.
    // Renaming a task whose agent died on startup would be misleading at best.
    const liveSession = useSessionStore.getState().sessions.find((entry) => entry.id === session.id);
    if (!liveSession || liveSession.status !== 'running') return;

    try {
      const result = await window.electronAPI.agent.summarize({ prompt: latest.description });
      if (!result.ok || !result.title) return;
      const suggested = result.title;
      // The board may have moved on; only suggest if the task still exists with a placeholder.
      const stillPlaceholder = useBoardStore.getState().tasks.find((entry) => entry.id === session.taskId);
      if (!stillPlaceholder || !isPlaceholderTitle(stillPlaceholder.title, stillPlaceholder.id)) return;

      useToastStore.getState().addToast({
        message: `Rename to "${suggested}"?`,
        variant: 'info',
        duration: 12_000,
        action: {
          label: 'Rename',
          onClick: () => {
            void useBoardStore
              .getState()
              .updateTask({ id: session.taskId, title: suggested })
              .catch(() => {
                useToastStore.getState().addToast({
                  message: 'Could not rename task',
                  variant: 'error',
                });
              });
          },
        },
      });
    } catch {
      // Silently swallow - this is a non-essential suggestion.
    }
  }, 30_000);
  autoNameTimers.set(session.taskId, timer);
}

/** Cancel pending timers and clear all in-memory state. Intended for HMR dispose
 *  and for unit tests that need a fresh module state between cases. */
export function cancelAutoNameTimersAndClear(): void {
  for (const timer of autoNameTimers.values()) clearTimeout(timer);
  autoNameTimers.clear();
  autoNameAsked.clear();
}

// HMR persistence: clear pending timers on dispose, save the in-memory sets so a
// hot reload doesn't double-fire. Vitest provides no `import.meta.hot`, so this
// block is a no-op under unit tests.
// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    for (const timer of autoNameTimers.values()) clearTimeout(timer);
    autoNameTimers.clear();
    data.autoNameState = {
      askedTaskIds: [...autoNameAsked],
    };
  });
}

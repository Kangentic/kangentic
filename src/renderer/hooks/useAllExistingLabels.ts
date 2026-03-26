import { useMemo } from 'react';
import { useBacklogStore } from '../stores/backlog-store';
import { useBoardStore } from '../stores/board-store';
import { useConfigStore } from '../stores/config-store';

/**
 * Collects all unique labels from backlog tasks, board tasks,
 * and config-defined label colors, sorted alphabetically.
 * Used for label autocomplete suggestions.
 */
export function useAllExistingLabels(): string[] {
  const backlogItems = useBacklogStore((state) => state.items);
  const boardTasks = useBoardStore((state) => state.tasks);
  const labelColors = useConfigStore((state) => state.config.backlog?.labelColors);

  return useMemo(() => {
    const labelSet = new Set<string>();
    for (const item of backlogItems) {
      for (const label of item.labels) {
        labelSet.add(label);
      }
    }
    for (const task of boardTasks) {
      for (const label of (task.labels ?? [])) {
        labelSet.add(label);
      }
    }
    if (labelColors) {
      for (const label of Object.keys(labelColors)) {
        labelSet.add(label);
      }
    }
    return [...labelSet].sort();
  }, [backlogItems, boardTasks, labelColors]);
}

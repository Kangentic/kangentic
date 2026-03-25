import { useMemo } from 'react';
import { useBacklogStore } from '../stores/backlog-store';
import { useBoardStore } from '../stores/board-store';

/**
 * Collects all unique labels from backlog items and board tasks,
 * sorted alphabetically. Used for label autocomplete suggestions.
 */
export function useAllExistingLabels(): string[] {
  const backlogItems = useBacklogStore((state) => state.items);
  const boardTasks = useBoardStore((state) => state.tasks);

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
    return [...labelSet].sort();
  }, [backlogItems, boardTasks]);
}

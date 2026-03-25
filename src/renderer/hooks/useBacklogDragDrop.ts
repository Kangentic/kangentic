import { useState, useCallback } from 'react';
import { PointerSensor, useSensor, useSensors, closestCenter } from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import { useBacklogStore } from '../stores/backlog-store';
import type { BacklogTask } from '../../shared/types';
import type { DragEndEvent } from '@dnd-kit/core';

/**
 * Slot algorithm: map a reordered visible subset back to the full list.
 *
 * Visible items occupy certain positions ("slots") in the full list.
 * After a drag reorder, substitute the new visible order into those
 * same slots, preserving hidden items' positions.
 *
 * O(n) time: one pass over allItems + O(m) Set construction.
 */
export function computeSlotReorder(
  newDisplayOrder: Array<{ id: string }>,
  displayItems: Array<{ id: string }>,
  allItems: Array<{ id: string }>,
): string[] {
  const visibleIds = new Set(displayItems.map((item) => item.id));
  const result: string[] = [];
  let visibleIndex = 0;
  for (const item of allItems) {
    if (visibleIds.has(item.id)) {
      result.push(newDisplayOrder[visibleIndex].id);
      visibleIndex++;
    } else {
      result.push(item.id);
    }
  }
  return result;
}

/**
 * Hook for drag-to-reorder in the backlog list.
 *
 * Supports reordering when sort/filter is active via the slot algorithm:
 * visible items occupy certain positions in the full list. After drag,
 * the reordered visible items are mapped back to those same slots,
 * preserving hidden items' positions.
 *
 * @param displayItems - Items in current display order (filtered + sorted)
 * @param allItems - All items ordered by position (the full unfiltered list)
 */
export function useBacklogDragDrop(displayItems: BacklogTask[], allItems: BacklogTask[]) {
  const reorderItems = useBacklogStore((state) => state.reorderItems);
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const handleDragStart = useCallback((event: { active: { id: string | number } }) => {
    setActiveId(String(event.active.id));
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const activeIndex = displayItems.findIndex((item) => item.id === String(active.id));
    const overIndex = displayItems.findIndex((item) => item.id === String(over.id));
    if (activeIndex === -1 || overIndex === -1) return;

    const newDisplayOrder = arrayMove(displayItems, activeIndex, overIndex);
    reorderItems(computeSlotReorder(newDisplayOrder, displayItems, allItems));
  }, [displayItems, allItems, reorderItems]);

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
  }, []);

  const activeItem = activeId ? displayItems.find((item) => item.id === activeId) : null;

  return {
    sensors,
    collisionDetection: closestCenter,
    handleDragStart,
    handleDragEnd,
    handleDragCancel,
    activeId,
    activeItem,
  };
}

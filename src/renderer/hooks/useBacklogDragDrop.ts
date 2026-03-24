import { useState, useCallback } from 'react';
import { PointerSensor, useSensor, useSensors, closestCenter } from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import { useBacklogStore } from '../stores/backlog-store';
import type { BacklogItem } from '../../shared/types';
import type { DragEndEvent } from '@dnd-kit/core';

/**
 * Hook for drag-to-reorder in the backlog list.
 * Follows the useSidebarDragDrop pattern - simple vertical list reorder.
 */
export function useBacklogDragDrop(filteredItems: BacklogItem[]) {
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

    const activeIndex = filteredItems.findIndex((item) => item.id === String(active.id));
    const overIndex = filteredItems.findIndex((item) => item.id === String(over.id));
    if (activeIndex === -1 || overIndex === -1) return;

    const reordered = arrayMove(filteredItems, activeIndex, overIndex);
    reorderItems(reordered.map((item) => item.id));
  }, [filteredItems, reorderItems]);

  const handleDragCancel = useCallback(() => {
    setActiveId(null);
  }, []);

  const activeItem = activeId ? filteredItems.find((item) => item.id === activeId) : null;

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

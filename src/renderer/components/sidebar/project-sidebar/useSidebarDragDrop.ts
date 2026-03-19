import { useState, useCallback, useMemo } from 'react';
import {
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type CollisionDetection,
} from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import type { Project, ProjectGroup } from '../../../../shared/types';

export function useSidebarDragDrop(
  projects: Project[],
  groups: ProjectGroup[],
  reorderProjects: (ids: string[]) => void,
  setProjectGroup: (projectId: string, groupId: string | null) => void,
) {
  const [activeId, setActiveId] = useState<string | null>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  // Build sorted groups and project maps
  const { sortedGroups, ungroupedProjects, groupedProjectsMap } = useMemo(() => {
    const hasGroups = groups.length > 0;
    const sorted = [...groups].sort((a, b) => a.position - b.position);
    const ungrouped = hasGroups
      ? projects.filter((p) => !p.group_id)
      : projects;
    const grouped = new Map<string, Project[]>();
    if (hasGroups) {
      for (const group of sorted) {
        grouped.set(
          group.id,
          projects
            .filter((p) => p.group_id === group.id)
            .sort((a, b) => a.position - b.position),
        );
      }
    }
    return { sortedGroups: sorted, ungroupedProjects: ungrouped, groupedProjectsMap: grouped };
  }, [projects, groups]);

  // Build sortable IDs: only project IDs, groups first then ungrouped
  const sortableIds = useMemo(() => {
    const ids: string[] = [];
    for (const group of sortedGroups) {
      if (!group.is_collapsed) {
        const groupProjects = groupedProjectsMap.get(group.id) || [];
        for (const project of groupProjects) {
          ids.push(project.id);
        }
      }
    }
    for (const project of ungroupedProjects) {
      ids.push(project.id);
    }
    return ids;
  }, [sortedGroups, groupedProjectsMap, ungroupedProjects]);

  // Collision detection that skips the dragged project's own group header,
  // so within-group reorder targets sibling projects instead of the header.
  const activeProject = activeId ? projects.find((p) => p.id === activeId) : null;
  const collisionDetection: CollisionDetection = useMemo(() => {
    const ownGroupHeaderId = activeProject?.group_id ? `group:${activeProject.group_id}` : null;
    return (args) => {
      const collisions = closestCenter(args);
      if (!ownGroupHeaderId || collisions.length === 0) return collisions;
      // If the closest hit is the project's own group header, skip it
      if (String(collisions[0].id) === ownGroupHeaderId) {
        const filtered = collisions.filter((c) => String(c.id) !== ownGroupHeaderId);
        if (filtered.length > 0) return filtered;
      }
      return collisions;
    };
  }, [activeProject?.group_id]);

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  }, []);

  // Build the full visual order: all groups' projects (by group position),
  // then ungrouped. Includes collapsed groups' projects so reorderProjects
  // always receives the complete list.
  const buildVisualOrder = useCallback((): Project[] => {
    const order: Project[] = [];
    for (const group of sortedGroups) {
      const groupProjects = groupedProjectsMap.get(group.id) || [];
      order.push(...groupProjects);
    }
    order.push(...ungroupedProjects);
    return order;
  }, [sortedGroups, groupedProjectsMap, ungroupedProjects]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    setActiveId(null);
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const activeIdStr = String(active.id);
    const overIdStr = String(over.id);

    const draggedProject = projects.find((p) => p.id === activeIdStr);
    if (!draggedProject) return;

    // Dropped on a group header: assign to that group (top position)
    if (overIdStr.startsWith('group:')) {
      const targetGroupId = overIdStr.replace('group:', '');
      if (draggedProject.group_id !== targetGroupId) {
        setProjectGroup(activeIdStr, targetGroupId);
      }
      // Move to top of target group
      const visualOrder = buildVisualOrder();
      const oldIndex = visualOrder.findIndex((p) => p.id === activeIdStr);
      // Find first project in the target group to insert before it
      const firstInGroup = visualOrder.findIndex(
        (p) => p.group_id === targetGroupId && p.id !== activeIdStr,
      );
      const insertIndex = firstInGroup !== -1 ? firstInGroup : oldIndex;
      if (oldIndex === -1) return;
      const reordered = arrayMove(visualOrder, oldIndex, insertIndex);
      reorderProjects(reordered.map((p) => p.id));
      return;
    }

    // Dropped on another project
    const targetProject = projects.find((p) => p.id === overIdStr);
    if (!targetProject) return;

    // Cross-group: reassign to target's group
    if (draggedProject.group_id !== targetProject.group_id) {
      setProjectGroup(activeIdStr, targetProject.group_id);
    }

    // Reorder using visual order
    const visualOrder = buildVisualOrder();
    const oldIndex = visualOrder.findIndex((p) => p.id === activeIdStr);
    const newIndex = visualOrder.findIndex((p) => p.id === overIdStr);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(visualOrder, oldIndex, newIndex);
    reorderProjects(reordered.map((p) => p.id));
  }, [projects, buildVisualOrder, reorderProjects, setProjectGroup]);

  return {
    sensors,
    collisionDetection,
    sortableIds,
    sortedGroups,
    groupedProjectsMap,
    ungroupedProjects,
    activeId,
    handleDragStart,
    handleDragEnd,
  };
}

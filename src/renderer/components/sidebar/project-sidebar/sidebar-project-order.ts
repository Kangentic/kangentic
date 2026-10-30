import type { Project, ProjectGroup } from '../../../../shared/types';

export interface SidebarProjectGrouping {
  /** Groups in their sidebar order (by position). */
  sortedGroups: ProjectGroup[];
  /** Projects in no group, in store order, listed after every group. */
  ungroupedProjects: Project[];
  /** Each group's projects, by position. Empty when there are no groups. */
  groupedProjectsMap: Map<string, Project[]>;
}

/**
 * How the sidebar lays its projects out: groups by position, each group's
 * projects by position, then the ungrouped projects. With no groups at all,
 * every project is ungrouped and keeps store order.
 */
export function groupSidebarProjects(projects: Project[], groups: ProjectGroup[]): SidebarProjectGrouping {
  const hasGroups = groups.length > 0;
  const sortedGroups = [...groups].sort((firstGroup, secondGroup) => firstGroup.position - secondGroup.position);
  const ungroupedProjects = hasGroups
    ? projects.filter((project) => !project.group_id)
    : projects;
  const groupedProjectsMap = new Map<string, Project[]>();
  if (hasGroups) {
    for (const group of sortedGroups) {
      groupedProjectsMap.set(
        group.id,
        projects
          .filter((project) => project.group_id === group.id)
          .sort((firstProject, secondProject) => firstProject.position - secondProject.position),
      );
    }
  }
  return { sortedGroups, ungroupedProjects, groupedProjectsMap };
}

/**
 * The sidebar's full visual order: every group's projects (collapsed groups
 * included) in group order, then the ungrouped projects. A project whose
 * `group_id` names a group that no longer exists is in neither list, so it is
 * absent here, exactly as it is absent from the sidebar.
 */
export function sidebarVisualOrder(grouping: SidebarProjectGrouping): Project[] {
  const order: Project[] = [];
  for (const group of grouping.sortedGroups) {
    order.push(...(grouping.groupedProjectsMap.get(group.id) ?? []));
  }
  order.push(...grouping.ungroupedProjects);
  return order;
}

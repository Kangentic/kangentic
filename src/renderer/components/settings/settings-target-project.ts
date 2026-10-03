import type { Project } from '../../../shared/types';

/**
 * The project the Settings panel is editing. Pure, with no store imports, so it
 * can be unit tested without evaluating a store module; `useSettingsProject`
 * is the hook over it.
 *
 * The panel's project switcher and the sidebar gear move `projectSettingsPath`,
 * which can name a project other than the board's `currentProject`. A project
 * tab that edits a project ROW (Agent's defaults, General's location) has to
 * read and write the row this returns, the same project `updateProjectOverride`
 * writes. Binding to `currentProject` instead showed and wrote the board
 * project's row whatever the switcher said.
 *
 * Never falls back to a DIFFERENT project. A target with no row is null, and
 * the caller disables its controls, because a write that silently lands on the
 * board project is the bug this exists to prevent.
 */
export function resolveSettingsProject({ projectSettingsPath, currentProject, projects }: {
  projectSettingsPath: string | null;
  currentProject: Project | null;
  projects: Project[];
}): Project | null {
  const targetPath = projectSettingsPath || currentProject?.path;
  if (!targetPath) return null;
  // The board project's own copy wins over its list row, so Settings agrees with
  // every other renderer reader of the board project's defaults. The two can
  // differ for a moment: `loadCurrent` refreshes only this copy and
  // `loadProjects` only the list.
  if (currentProject?.path === targetPath) return currentProject;
  return projects.find((project) => project.path === targetPath) ?? null;
}

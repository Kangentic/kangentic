import type { Project } from '../../shared/types';

/**
 * The project to open once the one that was open is gone: deleted, or hidden because its SSH host was removed.
 * The most recently opened of those still listed, so the app lands where the person last was and the theme
 * that applies is that project's own, instead of the app-wide default painting for the instant between two
 * projects. `projects` is the list a person picks from, which already leaves hidden projects out. Null when
 * none is left, and the empty state is right then.
 */
export function nextProjectToOpen(projects: readonly Project[], goneProjectId: string | null): Project | null {
  let best: Project | null = null;
  for (const project of projects) {
    if (project.id === goneProjectId) continue;
    if (best === null || (project.last_opened || '') > (best.last_opened || '')) best = project;
  }
  return best;
}

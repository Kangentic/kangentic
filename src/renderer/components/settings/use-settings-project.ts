import type { Project } from '../../../shared/types';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';
import { resolveSettingsProject } from './settings-target-project';

/** The project the Settings panel is editing. See `resolveSettingsProject`. */
export function useSettingsProject(): Project | null {
  const projectSettingsPath = useConfigStore((state) => state.projectSettingsPath);
  const currentProject = useProjectStore((state) => state.currentProject);
  const projects = useProjectStore((state) => state.projects);
  return resolveSettingsProject({ projectSettingsPath, currentProject, projects });
}

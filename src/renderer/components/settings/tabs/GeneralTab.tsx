import { FolderInput } from 'lucide-react';
import { useConfigStore } from '../../../stores/config-store';
import { useProjectStore } from '../../../stores/project-store';
import { useProjectRelocation } from '../../../hooks/useProjectRelocation';
import { SettingRow, INPUT_CLASS } from '../shared';
import { settingProps } from '../settings-registry';

/**
 * General per-project settings. Project Location is unlike every other
 * per-project row, editing the project row in the global DB (via the
 * projects IPC surface) rather than the project's config overrides.
 */
export function GeneralTab() {
  const projectSettingsPath = useConfigStore((state) => state.projectSettingsPath);
  const openProjectSettings = useConfigStore((state) => state.openProjectSettings);
  const currentProject = useProjectStore((state) => state.currentProject);
  const projects = useProjectStore((state) => state.projects);

  // Settings can target a non-current project (sidebar gear icon); resolve
  // by the path the panel was opened for, falling back to the current project.
  const activePath = projectSettingsPath || currentProject?.path;
  const project = projects.find((candidate) => candidate.path === activePath)
    ?? currentProject;

  const { requestMove, relocationDialog } = useProjectRelocation((updated) => {
    // The settings panel and its project switcher are keyed by path; re-key
    // them so the panel keeps pointing at the relocated project.
    openProjectSettings(updated.path, updated.name, 'general');
  });

  return (
    <>
      {project && (
        <SettingRow {...settingProps('project.location')}>
          <div className="flex items-center gap-2">
            {/* `INPUT_CLASS` rather than a hand-rolled shell: this is read-only,
                but it is still a value FIELD sitting in a row with a button, and
                it was the last control left on the pre-unification `bg-surface`
                + `border-edge` pairing. Borrowing the shared class means it
                cannot drift again. The focus utilities in it are inert on a div. */}
            <div
              className={`${INPUT_CLASS} flex-1 min-w-0 truncate`}
              title={project.path}
              data-testid="project-location-path"
            >
              {project.path}
            </div>
            <button
              type="button"
              onClick={() => requestMove(project)}
              data-testid="project-location-move"
              className="flex-shrink-0 inline-flex items-center gap-2 px-3 py-1.5 text-xs rounded border border-edge-input text-fg-muted hover:text-fg hover:border-edge-hover transition-colors"
            >
              <FolderInput size={14} />
              <span>Move...</span>
            </button>
          </div>
        </SettingRow>
      )}
      {relocationDialog}
    </>
  );
}

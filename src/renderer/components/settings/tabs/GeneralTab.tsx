import { FolderInput, FolderOpen } from 'lucide-react';
import { useConfigStore } from '../../../stores/config-store';
import { useProjectRelocation } from '../../../hooks/useProjectRelocation';
import { INPUT_CLASS } from '../shared';
import { SettingsCard, CardRow } from '../settings-card';
import { settingProps } from '../settings-registry';
import { useSettingsProject } from '../use-settings-project';

/**
 * General per-project settings. Project Location is unlike every other
 * per-project row, editing the project row in the global DB (via the
 * projects IPC surface) rather than the project's config overrides.
 */
export function GeneralTab() {
  const openProjectSettings = useConfigStore((state) => state.openProjectSettings);
  // Settings can target a non-current project (the switcher, the sidebar gear).
  const project = useSettingsProject();

  const { requestMove, relocationDialog } = useProjectRelocation((updated) => {
    // relocateProject has already re-keyed the panel to the new path, so this
    // changes neither the path nor the tab. It refetches the project's
    // overrides from the new location.
    openProjectSettings(updated.path, updated.name, 'general');
  });

  return (
    <div className="space-y-4">
      {project && (
        <SettingsCard
          icon={<FolderOpen size={16} />}
          label="Project"
          description="Where this project lives on disk."
          searchIds={['project.location']}
        >
          <CardRow {...settingProps('project.location')}>
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
          </CardRow>
        </SettingsCard>
      )}
      {relocationDialog}
    </div>
  );
}

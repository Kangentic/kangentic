// Monaco worker config + benign-error funnel. ChangesPanel normally supplies
// this side effect for the diff subsystem; this pane mounts DiffViewer without
// ChangesPanel, so it must import it itself or Monaco's workers are missing.
import '../../monacoConfig';
import { useConfigStore } from '../../stores/config-store';
import { DiffViewer } from '../../components/dialogs/task-detail/changes/DiffViewer';
import { DiffErrorBoundary } from '../../components/dialogs/task-detail/changes/DiffErrorBoundary';
import type { GitDiffFileEntry, GitDiffScope } from '../../../shared/types';
import type { DisplayedFileDiffContent } from './PopOutChangesFileRoot';

/**
 * The single-file diff body of a 'changes-file' pop-out window. Purely
 * presentational: PopOutChangesFileRoot owns fetching, the live-update
 * subscription, and the loading/empty/error states, and mounts this pane only
 * once content exists - keeping Monaco (this module's import graph) out of the
 * root chunk and the loading surface stable while both load in parallel.
 */
export function ChangesFileDiffPane({ filePath, entry, content, scope, commitOid, projectPath, worktreePath, scrollKey }: {
  filePath: string;
  entry: GitDiffFileEntry;
  content: DisplayedFileDiffContent;
  scope?: GitDiffScope;
  commitOid?: string;
  projectPath: string;
  worktreePath?: string;
  scrollKey: string;
}) {
  const viewMode = useConfigStore((state) => state.config.diffViewMode);
  const updateConfig = useConfigStore((state) => state.updateConfig);

  return (
    <DiffErrorBoundary>
      <DiffViewer
        original={content.result.original}
        modified={content.result.modified}
        language={content.result.language}
        filePath={filePath}
        contentFilePath={content.filePath}
        scrollKey={scrollKey}
        status={entry.status}
        viewMode={viewMode}
        onViewModeChange={(mode) => updateConfig({ diffViewMode: mode })}
        binary={entry.binary}
        isFocused
        worktreePath={worktreePath}
        projectPath={projectPath}
        blameEligible={!commitOid && scope !== 'staged'}
        // The root's full-body spinner is this window's ONE loading indicator;
        // a second one in the editor area would shift ~20px at hand-off.
        showEditorBootSpinner={false}
      />
    </DiffErrorBoundary>
  );
}

// Monaco worker config + benign-error funnel. ChangesPanel normally supplies
// this side effect for the diff subsystem; this pane mounts DiffViewer without
// ChangesPanel, so it must import it itself or Monaco's workers are missing.
import '../../monacoConfig';
import { useConfigStore } from '../../stores/config-store';
import { DiffViewer, type DiffLinkedFiles } from '../../components/dialogs/task-detail/changes/DiffViewer';
import { DiffErrorBoundary } from '../../components/dialogs/task-detail/changes/DiffErrorBoundary';
import type { DiffContentScope } from '../../components/dialogs/task-detail/changes/diff-content';
import type { GitDiffFileEntry, GitDiffScope } from '../../../shared/types';
import type { DisplayedFileDiffContent } from './PopOutChangesFileRoot';

/**
 * The single-file diff body of a 'changes-file' pop-out window. Purely
 * presentational: PopOutChangesFileRoot owns fetching, the live-update
 * subscription, and the loading/empty/error states, and mounts this pane only
 * once content exists - keeping Monaco (this module's import graph) out of the
 * root chunk and the loading surface stable while both load in parallel.
 */
export function ChangesFileDiffPane({ filePath, entry, content, scope, commitOid, isRange = false, projectPath, worktreePath, scrollKey, contentScope, linkedFiles }: {
  filePath: string;
  entry: GitDiffFileEntry;
  content: DisplayedFileDiffContent;
  scope?: GitDiffScope;
  commitOid?: string;
  /** The diff is a completed task's commit range, not a working tree. */
  isRange?: boolean;
  projectPath: string;
  worktreePath?: string;
  scrollKey: string;
  /** What the diff is read against, for the images its markdown preview loads. */
  contentScope: DiffContentScope;
  /** The files a link in the markdown preview can open. */
  linkedFiles: DiffLinkedFiles;
}) {
  const viewMode = useConfigStore((state) => state.config.diffViewMode);
  const updateConfig = useConfigStore((state) => state.updateConfig);

  return (
    <DiffErrorBoundary>
      <DiffViewer
        original={content.result.text.original}
        modified={content.result.text.modified}
        language={content.result.text.language}
        image={content.result.image}
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
        // Blame reads the working tree's file: never for a commit or a range.
        blameEligible={!commitOid && !isRange && scope !== 'staged'}
        // The root's full-body spinner is this window's ONE loading indicator;
        // a second one in the editor area would shift ~20px at hand-off.
        showEditorBootSpinner={false}
        contentScope={contentScope}
        linkedFiles={linkedFiles}
      />
    </DiffErrorBoundary>
  );
}

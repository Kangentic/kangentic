import { useRef, useEffect } from 'react';
import { Info, GitPullRequest } from 'lucide-react';
import { BranchPicker } from '../BranchPicker';
import { WorktreeChip } from '../WorktreeChip';
import { Select } from '../../settings/shared';
import { LabelInput } from '../../LabelInput';
import { DescriptionEditor } from '../../DescriptionEditor';
import { AttachmentThumbnails } from './AttachmentThumbnails';
import { useConfigStore } from '../../../stores/config-store';
import { useProjectStore } from '../../../stores/project-store';
import { useAllExistingLabels } from '../../../hooks/useAllExistingLabels';
import type { AttachmentsState } from './useAttachments';
import type { BranchConfigState } from './useBranchConfig';
import { DEFAULT_PRIORITY_CONFIG } from '../../../../shared/types';
import type { Task } from '../../../../shared/types';

interface TaskDetailEditFormProps {
  task: Task;
  title: string;
  setTitle: (title: string) => void;
  description: string;
  setDescription: (description: string) => void;
  prUrl: string;
  setPrUrl: (prUrl: string) => void;
  labels: string[];
  setLabels: (labels: string[]) => void;
  priority: number;
  setPriority: (priority: number) => void;
  attachments: AttachmentsState;
  branchConfig: BranchConfigState;
  isSessionActive: boolean;
  isArchived: boolean;
  isInTodo: boolean;
}

export function TaskDetailEditForm({
  task,
  title,
  setTitle,
  description,
  setDescription,
  prUrl,
  setPrUrl,
  labels,
  setLabels,
  priority,
  setPriority,
  attachments,
  branchConfig,
  isSessionActive,
  isArchived,
  isInTodo,
}: TaskDetailEditFormProps) {
  const titleInputRef = useRef<HTMLInputElement>(null);

  const labelColors = useConfigStore((state) => state.config.backlog?.labelColors) ?? {};
  const priorities = useConfigStore((state) => state.config.backlog?.priorities) ?? DEFAULT_PRIORITY_CONFIG;
  const allExistingLabels = useAllExistingLabels();
  const currentProject = useProjectStore((state) => state.currentProject);

  // Focus title input on mount
  useEffect(() => {
    titleInputRef.current?.focus();
  }, []);

  return (
    <div
      className="space-y-3 relative"
      onDragOver={attachments.handleAttachmentDragOver}
      onDragLeave={attachments.handleAttachmentDragLeave}
      onDrop={attachments.handleAttachmentDrop}
    >
      <input
        ref={titleInputRef}
        type="text"
        placeholder="Task title"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        className="w-full bg-surface border border-edge-input rounded px-3 py-2 text-sm text-fg placeholder-fg-faint focus:outline-none focus:border-accent"
      />
      <DescriptionEditor
        value={description}
        onChange={setDescription}
        onPaste={attachments.handleAttachmentPaste}
        testId="task-description"
        mentionSearchCwd={task.worktree_path ?? currentProject?.path ?? null}
      />
      <AttachmentThumbnails
        attachments={attachments.savedAttachments}
        isEditing={true}
        onPreview={attachments.handlePreview}
        onOpenExternal={attachments.handleOpenExternal}
        onRemove={attachments.removeAttachment}
      />
      <div className="flex gap-3">
        <div className="flex-1">
          <label className="text-xs text-fg-muted mb-1 block">Priority</label>
          <Select
            value={priority}
            onChange={(event) => setPriority(Number((event.target as HTMLSelectElement).value))}
            className="appearance-none bg-surface border border-edge-input rounded pl-3 pr-10 py-1.5 text-sm text-fg w-full focus:outline-none focus:border-accent"
            data-testid="task-priority"
          >
            {priorities.map((priorityEntry, index) => (
              <option key={index} value={index}>{priorityEntry.label}</option>
            ))}
          </Select>
        </div>
        <LabelInput
          labels={labels}
          setLabels={setLabels}
          labelColors={labelColors}
          allExistingLabels={allExistingLabels}
          testId="task-labels"
        />
      </div>
      {!isInTodo && (
        <div>
          <label className="text-xs text-fg-muted mb-1 flex items-center gap-1">
            <GitPullRequest size={12} />
            Pull Request
          </label>
          <input
            type="url"
            placeholder="https://github.com/owner/repo/pull/123"
            value={prUrl}
            onChange={(e) => setPrUrl(e.target.value)}
            className="w-full bg-surface border border-edge-input rounded px-3 py-1.5 text-xs text-fg placeholder-fg-faint focus:outline-none focus:border-accent"
            data-testid="pr-url-input"
          />
        </div>
      )}
      {!isSessionActive && !isArchived && isInTodo && (
        <div>
          <label className="text-xs text-fg-muted mb-1 block">Branch</label>
          <div className="flex items-center gap-2">
            <input
              data-testid="custom-branch-name-input"
              type="text"
              placeholder={branchConfig.branchPlaceholder}
              value={branchConfig.customBranchName}
              onChange={(e) => branchConfig.setCustomBranchName(e.target.value)}
              className={`flex-1 min-w-0 bg-surface border rounded px-3 py-1.5 text-xs text-fg placeholder-fg-faint focus:outline-none ${
                branchConfig.branchNameError
                  ? 'border-red-500 focus:border-red-500'
                  : 'border-edge-input focus:border-accent'
              }`}
            />
            <span className="text-xs text-fg-disabled shrink-0">from</span>
            <BranchPicker value={branchConfig.baseBranch} defaultBranch={branchConfig.defaultBaseBranch || 'main'} onChange={branchConfig.setBaseBranch} />
            <div className="w-px h-5 bg-edge-input shrink-0" />
            <WorktreeChip enabled={branchConfig.effectiveWorktree} onToggle={() => branchConfig.setUseWorktree(branchConfig.effectiveWorktree ? false : true)} />
          </div>
          {branchConfig.branchNameError ? (
            <p className="text-xs text-red-500 mt-0.5">{branchConfig.branchNameError}</p>
          ) : (
            <span className="text-xs text-fg-disabled mt-1 flex items-center gap-1"><Info size={12} className="shrink-0" />{branchConfig.branchHint}</span>
          )}
        </div>
      )}
      {!isSessionActive && !isArchived && !isInTodo && (
        <div className="flex items-center gap-2">
          <BranchPicker value={branchConfig.baseBranch} defaultBranch={branchConfig.defaultBaseBranch || 'main'} onChange={branchConfig.setBaseBranch} />
          {!task.worktree_path && (
            <>
              <div className="w-px h-5 bg-edge-input" />
              <WorktreeChip enabled={branchConfig.effectiveWorktree} onToggle={() => branchConfig.setUseWorktree(branchConfig.effectiveWorktree ? false : true)} />
            </>
          )}
        </div>
      )}
      {attachments.isDragOver && (
        <div className="absolute inset-0 bg-accent/10 border-2 border-dashed border-accent rounded-lg flex items-center justify-center z-10 pointer-events-none">
          <span className="text-sm text-accent-fg font-medium">Drop files here</span>
        </div>
      )}
    </div>
  );
}

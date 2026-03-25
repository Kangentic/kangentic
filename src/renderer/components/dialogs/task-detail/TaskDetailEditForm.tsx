import { useState, useRef, useEffect } from 'react';
import { Paperclip, Info, GitPullRequest, Eye, PenLine } from 'lucide-react';
import { BranchPicker } from '../BranchPicker';
import { WorktreeChip } from '../WorktreeChip';
import { Select } from '../../settings/shared';
import { LabelInput } from '../../LabelInput';
import { MarkdownRenderer } from '../../MarkdownRenderer';
import { AttachmentThumbnails } from './AttachmentThumbnails';
import { useConfigStore } from '../../../stores/config-store';
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const [textareaFocused, setTextareaFocused] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  const labelColors = useConfigStore((state) => state.config.backlog?.labelColors) ?? {};
  const priorities = useConfigStore((state) => state.config.backlog?.priorities) ?? DEFAULT_PRIORITY_CONFIG;
  const allExistingLabels = useAllExistingLabels();

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
      <div className="rounded border border-edge-input overflow-hidden focus-within:border-accent">
        <div className="flex items-center border-b border-edge-input">
          <button
            type="button"
            onClick={() => setShowPreview(false)}
            className={`flex-1 flex items-center justify-center gap-1 px-2.5 py-1.5 text-xs transition-colors ${
              !showPreview ? 'text-fg-secondary bg-surface-hover/50' : 'text-fg-faint hover:text-fg-muted'
            }`}
            data-testid="description-edit-tab"
          >
            <PenLine size={12} />
            Write
          </button>
          <button
            type="button"
            onClick={() => setShowPreview(true)}
            className={`flex-1 flex items-center justify-center gap-1 px-2.5 py-1.5 text-xs transition-colors ${
              showPreview ? 'text-fg-secondary bg-surface-hover/50' : 'text-fg-faint hover:text-fg-muted'
            }`}
            data-testid="description-preview-toggle"
          >
            <Eye size={12} />
            Preview
          </button>
        </div>
        <div className="relative w-full bg-surface h-[280px] overflow-hidden">
          {showPreview ? (
            <div
              className="absolute inset-0 px-3 py-2 overflow-y-auto"
              data-testid="description-preview"
            >
              {description ? (
                <MarkdownRenderer content={description} />
              ) : (
                <span className="text-sm text-fg-faint">Nothing to preview</span>
              )}
            </div>
          ) : (
            <>
              <textarea
                ref={textareaRef}
                data-testid="task-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onPaste={attachments.handleAttachmentPaste}
                onFocus={() => setTextareaFocused(true)}
                onBlur={() => setTextareaFocused(false)}
                className="absolute inset-0 w-full h-full bg-transparent px-3 py-2 text-sm text-fg focus:outline-none resize-none overflow-y-auto"
              />
              {!description && (
                <div className={`absolute inset-0 flex flex-col pointer-events-none px-3 py-2 transition-opacity duration-200 ${textareaFocused ? 'opacity-100' : 'opacity-40'}`}>
                  <span className="text-sm text-fg-faint">Describe the task for the agent...</span>
                  <div className="flex-1 flex items-center justify-center">
                    <div className="flex flex-col items-center gap-1.5 border border-dashed border-edge rounded-lg px-6 py-4">
                      <Paperclip size={20} className="text-fg-disabled" />
                      <span className="text-xs text-fg-disabled">Paste or drop files here</span>
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </div>
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

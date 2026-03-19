import { useState, useRef, useEffect } from 'react';
import { Image, Info } from 'lucide-react';
import { BranchPicker } from '../BranchPicker';
import { WorktreeChip } from '../WorktreeChip';
import { AttachmentThumbnails } from './AttachmentThumbnails';
import type { AttachmentsState } from './useAttachments';
import type { BranchConfigState } from './useBranchConfig';
import type { Task } from '../../../../shared/types';

interface TaskDetailEditFormProps {
  task: Task;
  title: string;
  setTitle: (title: string) => void;
  description: string;
  setDescription: (description: string) => void;
  attachments: AttachmentsState;
  branchConfig: BranchConfigState;
  isSessionActive: boolean;
  isArchived: boolean;
  isInBacklog: boolean;
}

export function TaskDetailEditForm({
  task,
  title,
  setTitle,
  description,
  setDescription,
  attachments,
  branchConfig,
  isSessionActive,
  isArchived,
  isInBacklog,
}: TaskDetailEditFormProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const titleInputRef = useRef<HTMLInputElement>(null);
  const [textareaFocused, setTextareaFocused] = useState(false);

  // Auto-expand textarea to fit content
  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 800)}px`;
  }, [description]);

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
      <div className="relative">
        <textarea
          ref={textareaRef}
          data-testid="task-description"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          onPaste={attachments.handleAttachmentPaste}
          onFocus={() => setTextareaFocused(true)}
          onBlur={() => setTextareaFocused(false)}
          className="w-full bg-surface border border-edge-input rounded px-3 py-2 text-sm text-fg focus:outline-none focus:border-accent min-h-[200px] max-h-[800px] resize-y overflow-y-auto"
        />
        {!description && (
          <div className={`absolute inset-0 flex flex-col pointer-events-none px-3 py-2 transition-opacity duration-200 ${textareaFocused ? 'opacity-100' : 'opacity-40'}`}>
            <span className="text-sm text-fg-faint">Describe the task for the agent...</span>
            <div className="flex-1 flex items-center justify-center">
              <div className="flex flex-col items-center gap-1.5 border border-dashed border-edge rounded-lg px-6 py-4">
                <Image size={20} className="text-fg-disabled" />
                <span className="text-xs text-fg-disabled">Paste or drop images here</span>
              </div>
            </div>
          </div>
        )}
      </div>
      <AttachmentThumbnails
        attachments={attachments.savedAttachments}
        isEditing={true}
        onPreview={attachments.handlePreview}
        onRemove={attachments.removeAttachment}
      />
      {!isSessionActive && !isArchived && isInBacklog && (
        <div>
          <label className="text-[10px] text-fg-muted mb-1 block">Branch</label>
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
      {!isSessionActive && !isArchived && !isInBacklog && (
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
          <span className="text-sm text-accent-fg font-medium">Drop images here</span>
        </div>
      )}
    </div>
  );
}

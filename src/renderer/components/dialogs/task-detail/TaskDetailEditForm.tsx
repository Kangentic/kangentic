import { useRef, useEffect } from 'react';
import { GitPullRequest } from 'lucide-react';
import { Field, FIELD_CONTROL_CLASS } from '../../Field';
import { TaskBranchRow } from '../TaskBranchRow';
import { PriorityLabelsRow } from '../PriorityLabelsRow';
import { DescriptionEditor } from '../../DescriptionEditor';
import { NameFromPromptButton } from '../../NameFromPromptButton';
import { AdvancedOverridesSection } from '../AdvancedOverridesSection';
import { AttachmentChipStrip } from '../AttachmentChipStrip';
import { isImageMediaType } from '../attachment-utils';
import { useTaskDetailHost } from './task-detail-host';
import type { AttachmentsState } from './useAttachments';
import type { BranchConfigState } from './useBranchConfig';
import type { Task, TaskRunMode } from '../../../../shared/types';

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
  agentOverride: string;
  setAgentOverride: (value: string) => void;
  modelOverride: string;
  setModelOverride: (value: string) => void;
  effortOverride: string;
  setEffortOverride: (value: string) => void;
  permissionOverride: string;
  profileId: string | null;
  setProfileId: (value: string | null) => void;
  runMode: TaskRunMode;
  setRunMode: (value: TaskRunMode) => void;
  setPermissionOverride: (value: string) => void;
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
  agentOverride,
  setAgentOverride,
  modelOverride,
  setModelOverride,
  effortOverride,
  setEffortOverride,
  permissionOverride,
  profileId,
  setProfileId,
  runMode,
  setRunMode,
  setPermissionOverride,
  attachments,
  branchConfig,
  isSessionActive,
  isArchived,
  isInTodo,
}: TaskDetailEditFormProps) {
  const titleInputRef = useRef<HTMLInputElement>(null);

  // The HOSTING project's path, not the open board's: an @-mention search must
  // look inside the project the task actually belongs to.
  const { projectPath } = useTaskDetailHost();

  // Focus title input on mount
  useEffect(() => {
    titleInputRef.current?.focus();
  }, []);

  return (
    <div
      className="space-y-3 relative flex flex-col flex-1"
      onDragOver={attachments.handleAttachmentDragOver}
      onDragLeave={attachments.handleAttachmentDragLeave}
      onDrop={attachments.handleAttachmentDrop}
    >
      <div className="flex items-center gap-2">
        <input
          ref={titleInputRef}
          type="text"
          placeholder="Task title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="flex-1 min-w-0 bg-surface border border-edge-input rounded px-3 py-2 text-sm text-fg placeholder-fg-faint focus:outline-none focus:border-accent"
        />
        <NameFromPromptButton description={description} onTitle={setTitle} />
      </div>
      <DescriptionEditor
        value={description}
        onChange={setDescription}
        onPaste={attachments.handleAttachmentPaste}
        testId="task-description"
        mentionSearchCwd={task.worktree_path ?? projectPath ?? null}
        className="flex-1"
      />
      <AttachmentChipStrip
        attachments={attachments.savedAttachments}
        onOpen={(attachment) =>
          isImageMediaType(attachment.media_type)
            ? attachments.handlePreview(attachment)
            : attachments.handleOpenExternal(attachment)
        }
        onRemove={attachments.removeAttachment}
      />
      <PriorityLabelsRow
        priority={priority}
        setPriority={setPriority}
        labels={labels}
        setLabels={setLabels}
        testIdPrefix="task-"
      />
      {!isInTodo && (
        <Field label={<span className="flex items-center gap-1"><GitPullRequest size={12} />Pull Request</span>}>
          <input
            type="url"
            placeholder="https://github.com/owner/repo/pull/123"
            value={prUrl}
            onChange={(e) => setPrUrl(e.target.value)}
            className={FIELD_CONTROL_CLASS}
            data-testid="pr-url-input"
          />
        </Field>
      )}
      {!isSessionActive && !isArchived && isInTodo && (
        <TaskBranchRow
          customBranchName={branchConfig.customBranchName}
          setCustomBranchName={branchConfig.setCustomBranchName}
          branchPlaceholder={branchConfig.branchPlaceholder}
          branchNameError={branchConfig.branchNameError}
          branchHint={branchConfig.branchHint}
          baseBranch={branchConfig.baseBranch}
          setBaseBranch={branchConfig.setBaseBranch}
          defaultBaseBranch={branchConfig.defaultBaseBranch}
          effectiveWorktree={branchConfig.effectiveWorktree}
          setUseWorktree={branchConfig.setUseWorktree}
        />
      )}
      {!isSessionActive && !isArchived && !isInTodo && (
        // Past To Do the branch name is fixed, so this is the same field with no
        // name segment. It used to be a bare, unlabelled pill row - the one
        // control in the form with nothing naming it. No hint here, matching what
        // this cluster showed before: the hint reads "will be created from ...",
        // which describes a decision this task has already made.
        <TaskBranchRow
          baseBranch={branchConfig.baseBranch}
          setBaseBranch={branchConfig.setBaseBranch}
          defaultBaseBranch={branchConfig.defaultBaseBranch}
          effectiveWorktree={branchConfig.effectiveWorktree}
          setUseWorktree={branchConfig.setUseWorktree}
          showWorktree={!task.worktree_path}
        />
      )}
      {!isSessionActive && !isArchived && (
        <AdvancedOverridesSection
          swimlaneId={task.swimlane_id}
          agentOverride={agentOverride}
          setAgentOverride={setAgentOverride}
          modelOverride={modelOverride}
          setModelOverride={setModelOverride}
          effortOverride={effortOverride}
          setEffortOverride={setEffortOverride}
          permissionOverride={permissionOverride}
          profileId={profileId}
          setProfileId={setProfileId}
          runMode={runMode}
          setRunMode={setRunMode}
          setPermissionOverride={setPermissionOverride}
        />
      )}
      {attachments.isDragOver && (
        <div className="absolute inset-0 bg-accent/10 border-2 border-dashed border-accent rounded-lg flex items-center justify-center z-10 pointer-events-none">
          <span className="text-sm text-accent-fg font-medium">Drop files here</span>
        </div>
      )}
    </div>
  );
}

import { useRef, useEffect } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { Field, FIELD_CONTROL_CLASS } from '../../Field';
import { TaskBranchRow } from '../TaskBranchRow';
import { PriorityLabelsRow } from '../PriorityLabelsRow';
import { DescriptionEditor } from '../../DescriptionEditor';
import { DescriptionLimitNote } from '../DescriptionLimitNote';
import { taskDescriptionOverage } from '../../../../shared/task-description-limit';
import { NameFromPromptButton } from '../../NameFromPromptButton';
import { AdvancedOverridesSection } from '../AdvancedOverridesSection';
import { AttachmentChipStrip } from '../AttachmentChipStrip';
import { isImageMediaType } from '../attachment-utils';
import { useTaskDetailHost } from './task-detail-host';
import type { AttachmentsState } from './useAttachments';
import type { BranchConfigState } from './useBranchConfig';
import { ArtifactsField } from '../../artifacts/ArtifactsField';
import type { Task, TaskArtifactChanges, TaskRunMode } from '../../../../shared/types';

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
  /** The form's unsaved artifact edits (`artifact-draft.ts`), sent with Save. */
  artifactChanges: TaskArtifactChanges;
  setArtifactChanges: (changes: TaskArtifactChanges) => void;
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
  artifactChanges,
  setArtifactChanges,
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
  const { t } = useLingui();
  const titleInputRef = useRef<HTMLInputElement>(null);

  // The HOSTING project's path, not the open board's: an @-mention search must
  // look inside the project the task actually belongs to. It comes from the
  // host context rather than ambient state: a task-detail window can be hosted
  // for a project that is not the open board's
  // (`.claude/rules/pop-out-surface-registry.md`).
  const { projectPath } = useTaskDetailHost();

  // The branch can be changed only while no agent runs in it and the task is not archived.
  const showBranchRow = !isSessionActive && !isArchived;

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
          placeholder={t`Task title`}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="flex-1 min-w-0 bg-surface-control border border-edge-input rounded px-3 py-2 text-sm text-fg placeholder-fg-faint focus:outline-none focus:border-accent"
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
      <DescriptionLimitNote overage={taskDescriptionOverage(description, task.description)} />
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
      {/* The task's git row, where New Task has its Branch row (#1056). In To
          Do it is that row exactly, alone: a task there has no pull request.
          Past To Do the branch name is fixed, so the same field shows it as
          text, and Pull request takes the right half, under Labels. The two
          used to stack with Artifacts between them: a full-width link field,
          then a base-branch pill alone on a row of its own. */}
      {showBranchRow && isInTodo && (
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
          showWorktree={branchConfig.worktreesEnabled}
          worktreeBlocker={branchConfig.blocker}
        />
      )}
      {!isInTodo && (
        <div className="flex gap-3" data-testid="task-git-row">
          {showBranchRow && (
            // No hint here: it reads "will be created from ...", which
            // describes a decision this task has already made.
            <div className="min-w-0 flex-1">
              <TaskBranchRow
                fixedBranchName={task.branch_name}
                baseBranch={branchConfig.baseBranch}
                setBaseBranch={branchConfig.setBaseBranch}
                defaultBaseBranch={branchConfig.defaultBaseBranch}
                effectiveWorktree={branchConfig.effectiveWorktree}
                setUseWorktree={branchConfig.setUseWorktree}
                showWorktree={branchConfig.worktreesEnabled && !task.worktree_path}
                worktreeBlocker={branchConfig.blocker}
              />
            </div>
          )}
          <Field label={t`Pull request`} className="min-w-0 flex-1">
            <input
              type="url"
              // i18n-ok: a URL-shaped example, not prose
              placeholder="https://github.com/owner/repo/pull/123"
              value={prUrl}
              onChange={(event) => setPrUrl(event.target.value)}
              className={FIELD_CONTROL_CLASS}
              data-testid="pr-url-input"
            />
          </Field>
        </div>
      )}
      {/* Shown in To Do too, where Pull request hides: requirements and designs
          are linked before the task starts. */}
      <ArtifactsField
        taskId={task.id}
        artifacts={task.artifacts ?? []}
        changes={artifactChanges}
        onChange={setArtifactChanges}
      />
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
          <span className="text-sm text-accent-fg font-medium"><Trans>Drop files here</Trans></span>
        </div>
      )}
    </div>
  );
}

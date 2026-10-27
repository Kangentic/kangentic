import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import { FolderOpen, Pencil, Plus, X } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useBoardStore } from '../../stores/board-store';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';
import { useSessionStore } from '../../stores/session-store';
import { useToastStore } from '../../stores/toast-store';
import { useWorkflowStore } from '../../stores/workflow-store';
import { describeIpcError, asSentence } from '../../lib/ipc-error';
import { openTaskFromNotification } from '../../utils/open-task-from-notification';
import { useKeybinding } from '../../hooks/useKeybinding';
import { useWorkflowAgentWorking } from '../../hooks/useWorkflowAgentWorking';
import { useTaskBoardFacts } from '../../hooks/useTaskBoardFacts';
import { NameFromPromptButton } from '../NameFromPromptButton';
import { BaseDialog } from './BaseDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { maximizedDialogLayout, MaximizeToggleButton } from './dialog-maximize';
import { TaskBranchRow } from './TaskBranchRow';
import { PriorityLabelsRow } from './PriorityLabelsRow';
import { DialogFooterActions } from './DialogFooterActions';
import { AdvancedOverridesSection } from './AdvancedOverridesSection';
import { Combobox } from './Combobox';
import { useBranchSettings, type BranchSettingsInitial } from '../../hooks/useBranchSettings';
import {
  DEFAULT_AGENT,
  type PermissionMode,
  type Project,
  type ProjectGroup,
  type TaskRunMode,
  type WorkflowTaskInput,
  type WorkflowTaskRunSettings,
} from '../../../shared/types';
import { WORKFLOW_REFUSAL_MESSAGES } from '../../../shared/workflow-refusals';
import { translateText } from '../../i18n/translate';
import { isPermissionMode } from '../../../shared/workflow-run-settings';
import { runSettingsFrom, showsPlannedTaskRows, type WorkflowTaskInitial } from './workflow-task-form';
import { DescriptionEditor } from '../DescriptionEditor';
import { AttachmentChipStrip } from './AttachmentChipStrip';
import { MAX_ATTACHMENT_BYTES, MEDIA_TYPE_EXT, resolveMediaType, isImageMediaType, pastedAttachmentPrefix, reserveNextPastedIndex } from './attachment-utils';
import { compressClipboardImage } from './image-compress';

interface PendingAttachment {
  id: string;
  filename: string;
  data: string; // base64
  media_type: string;
  previewUrl: string;
}

interface NewTaskDialogProps {
  swimlaneId: string;
  onClose: () => void;
  /**
   * Write into a workflow instead of onto the board: the Workflows canvas's
   * Add task, and the editor for a task that is still only planned (it has no
   * task id yet, so the task window cannot host it). The form is the board's
   * own, with the board's own rows: the project picker first (which board the
   * task goes on), then Base branch with Worktree or Project, and Column
   * Settings or Agent Override (#732, sign-offs 9 and 25). It leaves out the
   * branch name, Pull Request and attachments, which a task gets once Start
   * creates it. Save waits while the workflow agent's turn runs, as every
   * other planning control does. `onSubmit` resolves true once the workflow
   * has the task.
   */
  workflow?: {
    /** The dialog's title; "New Task" when omitted. */
    title?: string;
    /** The submit button's label; "Create" when omitted. */
    submitLabel?: string;
    /** The planned task itself, when editing one: its text, its board and its run settings. */
    initial?: WorkflowTaskInitial;
    onSubmit: (input: WorkflowTaskInput) => Promise<boolean>;
  };
}

// Non-task sentinel key for the maximize toggle (the create dialog has no task
// yet), so the flag lives in the same `maximizedTasks` store set and survives HMR.
const NEW_TASK_ENTITY_ID = 'new-task-dialog';

/** A new task starts with nothing pinned: base, branch name, and worktree all inherit. */
const EMPTY_BRANCH_SETTINGS: BranchSettingsInitial = { baseBranch: '', customBranchName: '', useWorktree: null };

/** The registered projects in the sidebar's order: each group's by position, groups by position, then the ungrouped. */
function projectsInSidebarOrder(projects: readonly Project[], groups: readonly ProjectGroup[]): Project[] {
  if (groups.length === 0) return [...projects];
  const ordered: Project[] = [];
  for (const group of [...groups].sort((left, right) => left.position - right.position)) {
    ordered.push(...projects.filter((project) => project.group_id === group.id).sort((left, right) => left.position - right.position));
  }
  // The ungrouped, and any whose group is gone: every project stays choosable.
  ordered.push(...projects.filter((project) => !ordered.includes(project)));
  return ordered;
}

export function NewTaskDialog({ swimlaneId, onClose, workflow }: NewTaskDialogProps) {
  const { t } = useLingui();
  const createTask = useBoardStore((s) => s.createTask);
  const currentProject = useProjectStore((s) => s.currentProject);
  const isMaximized = useSessionStore((s) => s.maximizedTasks.has(NEW_TASK_ENTITY_ID));
  const toggleMaximized = useSessionStore((s) => s.toggleMaximized);
  const handleToggleMaximized = useCallback(() => toggleMaximized(NEW_TASK_ENTITY_ID), [toggleMaximized]);
  // The planned task an edit opens on, whole: its text, its board and its run
  // settings. Read once: the edit then measures against it (`isDirty`), never
  // against an empty form.
  const initial = workflow?.initial;
  const [initialRun] = useState(() => runSettingsFrom(initial));
  const [title, setTitle] = useState(initial?.title ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [description, setDescription] = useState(initial?.description ?? '');
  const [priority, setPriority] = useState(initial?.priority ?? 0);
  const [labels, setLabels] = useState<string[]>(initial?.labels ?? []);

  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [previewAttachment, setPreviewAttachment] = useState<PendingAttachment | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const nextIdRef = useRef(0);
  // Highest pasted-filename index handed out so far, per prefix. Monotonic on
  // purpose - see reserveNextPastedIndex.
  const issuedPastedIndex = useRef<Record<string, number>>({});

  // Per-task agent/model/effort overrides. Empty string means "use column
  // default" for that field. The Advanced section locks all three for the
  // task's lifetime once set - column moves cannot change them (see
  // `resolveTargetAgent` and the cross-agent guards in `task-move.ts`).
  // A planned task opens on what it holds; everything else on nothing pinned.
  const [agentOverride, setAgentOverride] = useState(initialRun.agent_override ?? '');
  const [modelOverride, setModelOverride] = useState(initialRun.model_override ?? '');
  const [effortOverride, setEffortOverride] = useState(initialRun.effort_override ?? '');
  const [permissionOverride, setPermissionOverride] = useState<string>(initialRun.permission_mode ?? '');
  const [profileId, setProfileId] = useState<string | null>(initialRun.profile_id);
  // Which run-mode branch is selected. Persisted as `Task.run_mode`, so it is
  // real form state here rather than local state inside AdvancedOverridesSection
  // - which is also what lets `isDirty` below see it.
  const [runMode, setRunMode] = useState<TaskRunMode>(initialRun.run_mode);

  // A workflow task's board: the project picker, first in the form. It starts
  // on the planned task's board, or the workflow's own (the open project). A
  // task the plan takes in from a board keeps that board and its own settings,
  // so it shows neither the picker nor the run rows.
  const projects = useProjectStore((s) => s.projects);
  const projectGroups = useProjectStore((s) => s.groups);
  const homeProjectId = currentProject?.id ?? null;
  const initialProjectId = initial?.project_id ?? homeProjectId;
  const [taskProjectId, setTaskProjectId] = useState<string | null>(initialProjectId);
  const showsWorkflowRows = showsPlannedTaskRows(workflow !== undefined, initial);
  const taskProject = projects.find((project) => project.id === taskProjectId) ?? currentProject;
  // Everything the rows below inherit comes from the board the task goes on,
  // which for a workflow task may be another project's: its default base
  // branch, Worktrees switch, To Do column, profiles and default agent. The
  // board's own form reads the open board, as it always has.
  const boardFacts = useTaskBoardFacts(workflow ? taskProjectId : null);
  const { defaultBaseBranch, worktreesEnabled } = boardFacts;
  const projectOptions = useMemo(
    () => projectsInSidebarOrder(projects, projectGroups).map((project) => ({ value: project.id, label: project.name })),
    [projects, projectGroups],
  );

  // Save waits while the workflow agent's turn runs, as every other control
  // that changes its plan does (board 2c).
  const selectedWorkflowId = useWorkflowStore((s) => s.selectedWorkflowId);
  const workflowAgentWorking = useWorkflowAgentWorking(workflow ? selectedWorkflowId : null);
  const heldReason = workflow && workflowAgentWorking ? translateText(WORKFLOW_REFUSAL_MESSAGES.agentWorking) : null;

  // The Branch row: state, placeholder, hint, and the structural blockers,
  // shared with the task-detail edit form through one hook. The remote-agent
  // input mirrors the spawn-time skip in `ensureTaskWorktree`: the user's own
  // pick, else the destination column's override, else the project default.
  // A workflow task's column is its board's To Do, on whichever board it goes.
  const openBoardLane = useBoardStore((state) => state.swimlanes.find((lane) => lane.id === swimlaneId));
  const destinationLane = workflow ? boardFacts.todoLane : openBoardLane;
  const destinationProject = workflow ? boardFacts.project : currentProject;
  const agentExecution = boardFacts.agentExecution;
  const resolvedAgent = agentOverride || destinationLane?.agent_override || destinationProject?.default_agent || DEFAULT_AGENT;
  const [branchInitial] = useState<BranchSettingsInitial>(() => ({
    ...EMPTY_BRANCH_SETTINGS,
    baseBranch: initialRun.base_branch ?? '',
    useWorktree: initialRun.use_worktree === null ? null : initialRun.use_worktree === 1,
  }));
  const {
    baseBranch,
    setBaseBranch,
    customBranchName,
    setCustomBranchName,
    useWorktree,
    setUseWorktree,
    effectiveWorktree,
    branchPlaceholder,
    branchNameError,
    branchHint,
    blocker: worktreeBlocker,
  } = useBranchSettings({
    title,
    initial: branchInitial,
    worktreesEnabled,
    defaultBaseBranch,
    active: true,
    // The board the task goes on: a workflow task's may be another project's.
    projectPath: (workflow ? taskProject?.path : currentProject?.path) ?? null,
    projectId: workflow ? taskProjectId : null,
    remoteAgent: agentExecution[resolvedAgent]?.mode === 'remote',
  });

  /** A new board for a workflow task: the base branch and the profile named the old board's, so both go back to its defaults. */
  const handleProjectChange = (nextProjectId: string) => {
    if (!nextProjectId || nextProjectId === taskProjectId) return;
    setTaskProjectId(nextProjectId);
    setBaseBranch('');
    setProfileId(null);
  };

  // Every field the user can touch, including the two that pin nothing on their
  // own: selecting Agent Override with all four inherited, or picking a Board
  // Profile, is still work to lose, so Escape must prompt.
  // Editing a planned task measures against what it already holds, not an empty form.
  // A workflow task's board, base branch and Worktree choice count too; the
  // board form's never did, and keeps its old measure.
  const isDirty = title.trim() !== (initial?.title ?? '').trim()
    || description.trim() !== (initial?.description ?? '').trim()
    || labels.join('\n') !== (initial?.labels ?? []).join('\n')
    || priority !== (initial?.priority ?? 0)
    || customBranchName.trim() !== '' || attachments.length > 0
    || agentOverride !== (initialRun.agent_override ?? '') || modelOverride !== (initialRun.model_override ?? '')
    || effortOverride !== (initialRun.effort_override ?? '') || permissionOverride !== (initialRun.permission_mode ?? '')
    || profileId !== initialRun.profile_id || runMode !== initialRun.run_mode
    || (workflow !== undefined && (
      taskProjectId !== initialProjectId
      || baseBranch.trim() !== (initialRun.base_branch ?? '')
      || useWorktree !== branchInitial.useWorktree
    ));

  // Guard close gestures (X, Escape, backdrop, Ctrl+Shift+W) so unsaved work is
  // not lost: when the form is dirty, ask before discarding. Returns true to let
  // the caller proceed with the close, false when a confirm was shown instead.
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const handleCloseAttempt = useCallback(() => {
    if (confirmDiscard) return false;
    if (isDirty) { setConfirmDiscard(true); return false; }
    return true;
  }, [confirmDiscard, isDirty]);

  // BaseDialog publishes its animated, guard-aware close here so the footer
  // Cancel button and the panel.close keybinding play the exit animation instead
  // of unmounting instantly (matching the header X and Escape). Falls back to
  // onClose if invoked before mount.
  const dialogCloseRef = useRef<(() => void) | null>(null);
  const closeWithAnimation = useCallback(() => {
    if (dialogCloseRef.current) dialogCloseRef.current();
    else onClose();
  }, [onClose]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Reuse the shared panel.maximize / panel.close bindings (capture phase,
  // mirroring the task detail dialog and command terminal). panel.close and
  // Escape both route through the dirty-changes guard. No ad-hoc keydown listener.
  useKeybinding('panel.maximize', handleToggleMaximized, { capture: true });
  // Suppressed while a surface the Advanced section can spawn is open over this
  // dialog: the Board Manager (profile edit button) or the Settings panel (agent
  // edit button). This binding is capture-phase while both of those dismiss on a
  // bubble-phase listener, so without the gate a single Escape meant for the
  // surface on top would reach here first and raise the discard-changes confirm
  // over a draft the user never tried to abandon. Mirrors how BoardManagerDialog
  // suppresses its own Escape under a nested modal.
  const boardManagerOpen = useBoardStore((state) => state.boardManagerOpen);
  const settingsOpen = useConfigStore((state) => state.settingsOpen);
  useKeybinding('panel.close', closeWithAnimation, { capture: true, enabled: !boardManagerOpen && !settingsOpen });

  // Cleanup object URLs on unmount. Track the latest attachments in a ref so the
  // unmount-only cleanup revokes the CURRENT set: a [] dep captures the
  // mount-time (empty) array and leaks later previews, while an `attachments`
  // dep would revoke URLs still on screen on every add/remove.
  // Written on commit (a layout effect), never during render, which the
  // compiler rules forbid.
  const attachmentsRef = useRef(attachments);
  useLayoutEffect(() => {
    attachmentsRef.current = attachments;
  });
  useEffect(() => {
    return () => {
      attachmentsRef.current.forEach((a) => URL.revokeObjectURL(a.previewUrl));
    };
  }, []);

  // Close image preview on Escape (capture phase - fires before BaseDialog's handler)
  useEffect(() => {
    if (!previewAttachment) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setPreviewAttachment(null);
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [previewAttachment]);

  const addFile = useCallback(async (file: File, filenameOverride?: string) => {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      const oversizedFileName = file.name;
      useToastStore.getState().addToast({
        title: t`File too large`,
        message: t`"${oversizedFileName}" is over the 10 MB limit.`,
        variant: 'warning',
      });
      return;
    }

    const mediaType = resolveMediaType(file);

    let dataUrl: string;
    try {
      dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(file);
      });
    } catch (error) {
      console.error('Failed to read attachment:', error);
      return;
    }
    const base64 = dataUrl.split(',')[1];
    const previewUrl = URL.createObjectURL(file);
    const id = `pending-${nextIdRef.current++}`;
    const filename = filenameOverride || file.name;
    setAttachments((previous) => [...previous, {
      id,
      filename,
      data: base64,
      media_type: mediaType,
      previewUrl,
    }]);
  }, [t]);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((previous) => {
      const removed = previous.find((attachment) => attachment.id === id);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return previous.filter((attachment) => attachment.id !== id);
    });
  }, []);

  const handlePaste = useCallback((event: React.ClipboardEvent) => {
    // A workflow task takes no attachments until it exists (see `workflow`).
    if (workflow) return;
    const items = event.clipboardData?.items;
    if (!items) return;

    for (let index = 0; index < items.length; index++) {
      const item = items[index];
      if (item.kind !== 'file') continue;
      const file = item.getAsFile();
      if (!file) continue;

      event.preventDefault();
      const mediaType = resolveMediaType(file);
      const prefix = pastedAttachmentPrefix(mediaType);
      const extensionStart = file.name ? file.name.lastIndexOf('.') : -1;
      const fallbackExtension = MEDIA_TYPE_EXT[mediaType] || (extensionStart >= 0 ? file.name.slice(extensionStart) : '.bin');
      // Reserved synchronously so two fast pastes cannot claim the same index,
      // then recorded in a high-water mark that is never decremented.
      const pastedIndex = reserveNextPastedIndex(
        prefix,
        attachments.map((attachment) => attachment.filename),
        issuedPastedIndex.current[prefix] ?? 0,
      );
      issuedPastedIndex.current[prefix] = pastedIndex;
      void (async () => {
        const { file: outFile } = await compressClipboardImage(file);
        const finalMediaType = resolveMediaType(outFile);
        const finalExtension = MEDIA_TYPE_EXT[finalMediaType] ?? fallbackExtension;
        await addFile(outFile, `${prefix}${pastedIndex}${finalExtension}`);
      })();
    }
  }, [attachments, addFile, workflow]);

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (!workflow) setIsDragOver(true);
  }, [workflow]);

  const handleDragLeave = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(false);

    const files = event.dataTransfer?.files;
    if (!files || workflow) return;
    for (let index = 0; index < files.length; index++) {
      addFile(files[index]);
    }
  }, [addFile, workflow]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim() || submitting) return;
    if (branchNameError || heldReason) return;
    setSubmitting(true);
    try {
      const taskTitle = title.trim();
      if (workflow) {
        // The store reports its own failure; the dialog stays open to retry.
        // Labels, priority and every run setting are always sent, so an edit
        // can clear them. The profile is one of the task's own board's, which
        // the select lists whichever board that is.
        const runSettings: Partial<WorkflowTaskRunSettings> = {
          base_branch: baseBranch.trim() || null,
          use_worktree: useWorktree === null ? null : useWorktree ? 1 : 0,
          run_mode: runMode,
          profile_id: profileId,
          agent_override: agentOverride || null,
          model_override: modelOverride || null,
          effort_override: effortOverride || null,
          permission_mode: isPermissionMode(permissionOverride) ? permissionOverride : null,
        };
        const saved = await workflow.onSubmit({
          title: taskTitle,
          description: description.trim(),
          labels,
          priority,
          ...(showsWorkflowRows ? { projectId: taskProjectId, ...runSettings } : {}),
        });
        if (saved) onClose();
        return;
      }
      // The project the slice stamps on the create, read at the same moment so
      // a project switch while the create is in flight cannot re-point the
      // toast's click at the wrong board.
      const createdInProjectId = useProjectStore.getState().currentProject?.id ?? null;
      const createdTask = await createTask({
        title: taskTitle,
        description: description.trim(),
        swimlane_id: swimlaneId,
        ...(labels.length > 0 ? { labels } : {}),
        ...(priority > 0 ? { priority } : {}),
        ...(baseBranch.trim() ? { baseBranch: baseBranch.trim() } : {}),
        ...(useWorktree !== null ? { useWorktree } : {}),
        ...(customBranchName.trim() ? { customBranchName: customBranchName.trim() } : {}),
        ...(agentOverride ? { agent_override: agentOverride } : {}),
        ...(modelOverride ? { model_override: modelOverride } : {}),
        ...(effortOverride ? { effort_override: effortOverride } : {}),
        ...(permissionOverride ? { permission_mode: permissionOverride as PermissionMode } : {}),
        ...(profileId ? { profile_id: profileId } : {}),
        // Always sent, never a conditional spread: 'column_settings' is a real
        // choice, not an absent one, and it is the half of the pair that carries
        // no pins to imply it.
        run_mode: runMode,
        ...(attachments.length > 0 ? {
          pendingAttachments: attachments.map((attachment) => ({
            filename: attachment.filename,
            data: attachment.data,
            media_type: attachment.media_type,
          })),
        } : {}),
      });
      // Revoke all preview URLs
      attachments.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl));
      const openBoardLaneName = openBoardLane?.name ?? '';
      useToastStore.getState().addToast({
        title: t`Task created`,
        message: openBoardLane
          ? t`"${taskTitle}" is in ${openBoardLaneName}.`
          : t`"${taskTitle}" is on the board.`,
        variant: 'info',
        ...(createdInProjectId
          ? { onOpen: () => openTaskFromNotification(createdInProjectId, createdTask.id) }
          : {}),
      });
      onClose();
    } catch (error) {
      // Previously unhandled: a rejected create (including a pending
      // attachment write failing inside it) reached only the global
      // unhandledrejection analytics listener, with nothing shown to the
      // user. The dialog stays open so the title/description/attachments
      // are not lost and the user can retry.
      console.error('[NewTaskDialog] Failed to create task:', error);
      useToastStore.getState().addToast({
        title: t`Couldn't create task`,
        message: asSentence(describeIpcError(error)),
        variant: 'error',
      });
    } finally {
      setSubmitting(false);
    }
  };

  const { dialogClassName, backdropPositionClass, backdropClassName, contentRadiusClass } =
    maximizedDialogLayout(isMaximized, 'w-[840px] max-w-[90vw]');

  return (
    <>
      <form onSubmit={handleSubmit}>
        <BaseDialog
          onClose={onClose}
          closeRef={dialogCloseRef}
          onHeaderDoubleClick={handleToggleMaximized}
          onCloseRequest={handleCloseAttempt}
          testId="new-task-dialog"
          // The Advanced section's edit buttons open the Board Manager (profile)
          // or Settings (agent) over this dialog; Escape then belongs to
          // whichever of those is on top, alone.
          suppressEscape={boardManagerOpen || settingsOpen}
          title={workflow?.title ?? t`New Task`}
          // Editing a planned task carries the board's Edit Task pencil; adding one, the plus.
          icon={initial
            ? <Pencil size={14} className="text-fg-muted" data-testid="new-task-dialog-edit-icon" />
            : <Plus size={14} className="text-fg-muted" data-testid="new-task-dialog-add-icon" />}
          headerRight={
            <MaximizeToggleButton isMaximized={isMaximized} onToggle={handleToggleMaximized} />
          }
          className={dialogClassName}
          backdropPositionClass={backdropPositionClass}
          backdropClassName={backdropClassName}
          contentRadiusClass={contentRadiusClass}
          bodyClassName="flex-1 flex flex-col"
          closeHotkeyActionId="panel.close"
          footer={
            <DialogFooterActions
              onCancel={closeWithAnimation}
              submitLabel={workflow?.submitLabel ?? t`Create`}
              busy={submitting}
              disabled={!!branchNameError || heldReason !== null}
              disabledReason={heldReason}
            />
          }
        >
          <div
            className="space-y-3 relative flex flex-col flex-1"
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            {showsWorkflowRows && (<>
              {/* Which board the task goes on, first, since it decides the base
                  branch and the columns its route can use (board 17b). Full
                  width, then a full-bleed divider before the board's own form. */}
              <Combobox
                value={taskProjectId ?? ''}
                onChange={handleProjectChange}
                options={projectOptions}
                allowClear={false}
                leadingIcon={<FolderOpen size={14} />}
                className="w-full"
                testId="workflow-task-project"
              />
              <div className="-mx-4 border-t border-edge" role="separator" data-testid="workflow-task-project-divider" />
            </>)}
            <div className="flex items-center gap-2">
              <input
                ref={inputRef}
                type="text"
                placeholder={t`Task title`}
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                className="flex-1 min-w-0 bg-surface-control border border-edge-input rounded px-3 py-2 text-sm text-fg placeholder-fg-faint focus:outline-none focus:border-accent"
              />
              <NameFromPromptButton description={description} onTitle={setTitle} />
            </div>
            <DescriptionEditor
              value={description}
              onChange={setDescription}
              onPaste={handlePaste}
              testId="task-description"
              // Mentions search the repository the task works in.
              mentionSearchCwd={(workflow ? taskProject?.path : currentProject?.path) ?? null}
              className="flex-1"
            />

            {!workflow && (
              <AttachmentChipStrip
                attachments={attachments}
                onOpen={(attachment) => {
                  if (isImageMediaType(attachment.media_type)) setPreviewAttachment(attachment);
                }}
                onRemove={removeAttachment}
              />
            )}

            <PriorityLabelsRow
              priority={priority}
              setPriority={setPriority}
              labels={labels}
              setLabels={setLabels}
              testIdPrefix="task-"
            />

            {!workflow && (<>
            <TaskBranchRow
              customBranchName={customBranchName}
              setCustomBranchName={setCustomBranchName}
              branchPlaceholder={branchPlaceholder}
              branchNameError={branchNameError}
              branchHint={branchHint}
              baseBranch={baseBranch}
              setBaseBranch={setBaseBranch}
              defaultBaseBranch={defaultBaseBranch}
              effectiveWorktree={effectiveWorktree}
              setUseWorktree={setUseWorktree}
              showWorktree={worktreesEnabled}
              worktreeBlocker={worktreeBlocker}
            />

            <AdvancedOverridesSection
              swimlaneId={swimlaneId}
              runMode={runMode}
              setRunMode={setRunMode}
              agentOverride={agentOverride}
              setAgentOverride={setAgentOverride}
              modelOverride={modelOverride}
              setModelOverride={setModelOverride}
              effortOverride={effortOverride}
              setEffortOverride={setEffortOverride}
              permissionOverride={permissionOverride}
              setPermissionOverride={setPermissionOverride}
              profileId={profileId}
              setProfileId={setProfileId}
            />
            </>)}

            {/* A workflow task: the board form's own rows, less the branch name,
                which Start chooses, as it does for every task. */}
            {showsWorkflowRows && (<>
            <TaskBranchRow
              baseBranch={baseBranch}
              setBaseBranch={setBaseBranch}
              defaultBaseBranch={defaultBaseBranch}
              effectiveWorktree={effectiveWorktree}
              setUseWorktree={setUseWorktree}
              showWorktree={worktreesEnabled}
              worktreeBlocker={worktreeBlocker}
              projectId={taskProjectId}
            />

            <AdvancedOverridesSection
              swimlaneId={swimlaneId}
              runMode={runMode}
              setRunMode={setRunMode}
              agentOverride={agentOverride}
              setAgentOverride={setAgentOverride}
              modelOverride={modelOverride}
              setModelOverride={setModelOverride}
              effortOverride={effortOverride}
              setEffortOverride={setEffortOverride}
              permissionOverride={permissionOverride}
              setPermissionOverride={setPermissionOverride}
              profileId={profileId}
              setProfileId={setProfileId}
              board={{
                project: boardFacts.project,
                lane: boardFacts.todoLane,
                boardProfiles: boardFacts.boardProfiles,
                permissionMode: boardFacts.permissionMode,
                isOpenBoard: boardFacts.isOpenBoard,
                loading: boardFacts.loading,
              }}
            />
            </>)}

            {/* Drag overlay */}
            {isDragOver && (
              <div className="absolute inset-0 bg-accent/10 border-2 border-dashed border-accent rounded-lg flex items-center justify-center z-10 pointer-events-none">
                <span className="text-sm text-accent-fg font-medium"><Trans>Drop files here</Trans></span>
              </div>
            )}
          </div>
        </BaseDialog>
      </form>

      {/* Discard-unsaved-changes confirmation (close gestures route here when dirty) */}
      {confirmDiscard && (
        <ConfirmDialog
          title={t`Discard unsaved changes?`}
          variant="warning"
          confirmLabel={t`Discard`}
          cancelLabel={t`Keep editing`}
          message={initial ? t`Closing now will discard your changes to this task.` : t`Closing now will discard this new task and its unsaved changes.`}
          onConfirm={() => { setConfirmDiscard(false); onClose(); }}
          onCancel={() => setConfirmDiscard(false)}
        />
      )}

      {/* Full-size preview overlay (images only) */}
      {previewAttachment && isImageMediaType(previewAttachment.media_type) && (
        <div
          className="fixed inset-0 bg-black/80 flex flex-col items-center justify-center z-[60]"
          onClick={() => setPreviewAttachment(null)}
          data-testid="attachment-preview-overlay"
        >
          <button
            className="absolute top-4 right-4 p-2 text-fg-muted hover:text-fg-secondary transition-colors"
            onClick={() => setPreviewAttachment(null)}
          >
            <X size={24} />
          </button>
          <img
            src={previewAttachment.previewUrl}
            alt={previewAttachment.filename}
            className="max-w-[90vw] max-h-[85vh] object-contain"
            onClick={(event) => event.stopPropagation()}
          />
          <p className="mt-2 text-sm text-fg-muted">{previewAttachment.filename}</p>
        </div>
      )}
    </>
  );
}

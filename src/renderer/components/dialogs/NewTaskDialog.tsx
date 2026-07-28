import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Plus, X } from 'lucide-react';
import { useBoardStore } from '../../stores/board-store';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';
import { useSessionStore } from '../../stores/session-store';
import { useToastStore } from '../../stores/toast-store';
import { useKeybinding } from '../../hooks/useKeybinding';
import { NameFromPromptButton } from '../NameFromPromptButton';
import { BaseDialog } from './BaseDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { maximizedDialogLayout, MaximizeToggleButton } from './dialog-maximize';
import { TaskBranchRow } from './TaskBranchRow';
import { PriorityLabelsRow } from './PriorityLabelsRow';
import { DialogFooterActions } from './DialogFooterActions';
import { AdvancedOverridesSection } from './AdvancedOverridesSection';
import { fetchGitBranches } from '../../utils/git-branches';
import { isValidGitBranchName } from '../../../shared/git-utils';
import { slugify, computeAutoBranchName } from '../../../shared/slugify';
import type { PermissionMode, TaskRunMode } from '../../../shared/types';
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
}

// Non-task sentinel key for the maximize toggle (the create dialog has no task
// yet), so the flag lives in the same `maximizedTasks` store set and survives HMR.
const NEW_TASK_ENTITY_ID = 'new-task-dialog';

export function NewTaskDialog({ swimlaneId, onClose }: NewTaskDialogProps) {
  const createTask = useBoardStore((s) => s.createTask);
  const defaultBaseBranch = useConfigStore((s) => s.config.git.defaultBaseBranch);
  const worktreesEnabled = useConfigStore((s) => s.config.git.worktreesEnabled);
  const currentProject = useProjectStore((s) => s.currentProject);
  const isMaximized = useSessionStore((s) => s.maximizedTasks.has(NEW_TASK_ENTITY_ID));
  const toggleMaximized = useSessionStore((s) => s.toggleMaximized);
  const handleToggleMaximized = useCallback(() => toggleMaximized(NEW_TASK_ENTITY_ID), [toggleMaximized]);
  const [title, setTitle] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [description, setDescription] = useState('');
  const [priority, setPriority] = useState(0);
  const [labels, setLabels] = useState<string[]>([]);
  const [baseBranch, setBaseBranch] = useState('');
  const [useWorktree, setUseWorktree] = useState<boolean | null>(null);
  const effectiveWorktree = useWorktree ?? worktreesEnabled;
  const [customBranchName, setCustomBranchName] = useState('');
  const branchNameError = customBranchName.trim() && !isValidGitBranchName(customBranchName.trim())
    ? 'Invalid git branch name'
    : '';
  const [knownBranches, setKnownBranches] = useState<Set<string>>(new Set());
  useEffect(() => {
    fetchGitBranches()
      .then(branches => setKnownBranches(new Set(branches)))
      .catch(() => setKnownBranches(new Set()));
  }, []);
  const branchExists = useMemo(
    () => customBranchName.trim() ? knownBranches.has(customBranchName.trim()) : false,
    [customBranchName, knownBranches],
  );
  const effectiveBaseBranch = baseBranch.trim() || defaultBaseBranch || 'main';
  const branchPlaceholder = (() => {
    if (effectiveWorktree) {
      const slug = slugify(title.trim()) || 'task-title';
      return computeAutoBranchName(effectiveBaseBranch, defaultBaseBranch || 'main', slug, 'ab12cd34');
    }
    return effectiveBaseBranch;
  })();
  const branchHint = useMemo(() => {
    const pill = (text: string) => (
      <span className="font-mono text-fg-faint">{text}</span>
    );
    const branch = customBranchName.trim();
    if (branch) {
      if (branchExists) {
        if (effectiveWorktree) {
          return <>{pill(branch)} exists and will be checked out in a new worktree</>;
        }
        return <>{pill(branch)} exists and will be checked out</>;
      }
      if (effectiveWorktree) {
        return <>{pill(branch)} will be created from {pill(effectiveBaseBranch)} in a new worktree</>;
      }
      return <>{pill(branch)} will be created from {pill(effectiveBaseBranch)}</>;
    }
    if (effectiveWorktree) {
      return <>Auto-generated branch will be created from {pill(effectiveBaseBranch)} in a new worktree</>;
    }
    return <>Agent will work directly on {pill(effectiveBaseBranch)}</>;
  }, [customBranchName, branchExists, effectiveWorktree, effectiveBaseBranch]);

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
  const [agentOverride, setAgentOverride] = useState('');
  const [modelOverride, setModelOverride] = useState('');
  const [effortOverride, setEffortOverride] = useState('');
  const [permissionOverride, setPermissionOverride] = useState('');
  const [profileId, setProfileId] = useState<string | null>(null);
  // Which run-mode branch is selected. Persisted as `Task.run_mode`, so it is
  // real form state here rather than local state inside AdvancedOverridesSection
  // - which is also what lets `isDirty` below see it.
  const [runMode, setRunMode] = useState<TaskRunMode>('column_settings');

  // Every field the user can touch, including the two that pin nothing on their
  // own: selecting Agent Override with all four inherited, or picking a Board
  // Profile, is still work to lose, so Escape must prompt.
  const isDirty = title.trim() !== '' || description.trim() !== '' || customBranchName.trim() !== '' || attachments.length > 0 || labels.length > 0 || priority !== 0 || agentOverride !== '' || modelOverride !== '' || effortOverride !== '' || permissionOverride !== '' || profileId !== null || runMode !== 'column_settings';

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
  const attachmentsRef = useRef(attachments);
  attachmentsRef.current = attachments;
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
      useToastStore.getState().addToast({
        message: `File "${file.name}" exceeds 10MB limit`,
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
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((previous) => {
      const removed = previous.find((attachment) => attachment.id === id);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return previous.filter((attachment) => attachment.id !== id);
    });
  }, []);

  const handlePaste = useCallback((event: React.ClipboardEvent) => {
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
  }, [attachments, addFile]);

  const handleDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(true);
  }, []);

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
    if (!files) return;
    for (let index = 0; index < files.length; index++) {
      addFile(files[index]);
    }
  }, [addFile]);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!title.trim() || submitting) return;
    if (branchNameError) return;
    setSubmitting(true);
    try {
      const taskTitle = title.trim();
      await createTask({
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
      useToastStore.getState().addToast({
        message: `Created task "${taskTitle}"`,
        variant: 'info',
      });
      onClose();
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
          title="New Task"
          icon={<Plus size={14} className="text-fg-muted" />}
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
              submitLabel="Create"
              busyLabel="Creating..."
              busy={submitting}
              disabled={!!branchNameError}
            />
          }
        >
          <div
            className="space-y-3 relative flex flex-col flex-1"
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <div className="flex items-center gap-2">
              <input
                ref={inputRef}
                type="text"
                placeholder="Task title"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                className="flex-1 min-w-0 bg-surface border border-edge-input rounded px-3 py-2 text-sm text-fg placeholder-fg-faint focus:outline-none focus:border-accent"
              />
              <NameFromPromptButton description={description} onTitle={setTitle} />
            </div>
            <DescriptionEditor
              value={description}
              onChange={setDescription}
              onPaste={handlePaste}
              testId="task-description"
              mentionSearchCwd={currentProject?.path ?? null}
              className="flex-1"
            />

            <AttachmentChipStrip
              attachments={attachments}
              onOpen={(attachment) => {
                if (isImageMediaType(attachment.media_type)) setPreviewAttachment(attachment);
              }}
              onRemove={removeAttachment}
            />

            <PriorityLabelsRow
              priority={priority}
              setPriority={setPriority}
              labels={labels}
              setLabels={setLabels}
              testIdPrefix="task-"
            />

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

            {/* Drag overlay */}
            {isDragOver && (
              <div className="absolute inset-0 bg-accent/10 border-2 border-dashed border-accent rounded-lg flex items-center justify-center z-10 pointer-events-none">
                <span className="text-sm text-accent-fg font-medium">Drop files here</span>
              </div>
            )}
          </div>
        </BaseDialog>
      </form>

      {/* Discard-unsaved-changes confirmation (close gestures route here when dirty) */}
      {confirmDiscard && (
        <ConfirmDialog
          title="Discard unsaved changes?"
          variant="warning"
          confirmLabel="Discard"
          cancelLabel="Keep editing"
          message="Closing now will discard this new task and its unsaved changes."
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

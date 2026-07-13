import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Plus, X, Info } from 'lucide-react';
import { useBoardStore } from '../../stores/board-store';
import { useConfigStore } from '../../stores/config-store';
import { useProjectStore } from '../../stores/project-store';
import { useSessionStore } from '../../stores/session-store';
import { useAllExistingLabels } from '../../hooks/useAllExistingLabels';
import { useToastStore } from '../../stores/toast-store';
import { useKeybinding } from '../../hooks/useKeybinding';
import { NameFromPromptButton } from '../NameFromPromptButton';
import { BaseDialog } from './BaseDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { maximizedDialogLayout, MaximizeToggleButton } from './dialog-maximize';
import { BranchPicker } from './BranchPicker';
import { WorktreeChip } from './WorktreeChip';
import { AdvancedOverridesSection } from './AdvancedOverridesSection';
import { Select } from '../settings/shared';
import { LabelInput } from '../LabelInput';
import { fetchGitBranches } from '../../utils/git-branches';
import { isValidGitBranchName } from '../../../shared/git-utils';
import { slugify, computeAutoBranchName } from '../../../shared/slugify';
import { DEFAULT_PRIORITY_CONFIG } from '../../../shared/types';
import type { PermissionMode } from '../../../shared/types';
import { DescriptionEditor } from '../DescriptionEditor';
import { MAX_ATTACHMENT_BYTES, MEDIA_TYPE_EXT, resolveMediaType, isImageMediaType, getFileTypeIcon, getExtension } from './attachment-utils';
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
  const labelColors = useConfigStore((s) => s.config.backlog?.labelColors) ?? {};
  const priorities = useConfigStore((s) => s.config.backlog?.priorities) ?? DEFAULT_PRIORITY_CONFIG;
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
  const allExistingLabels = useAllExistingLabels();

  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [previewAttachment, setPreviewAttachment] = useState<PendingAttachment | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const nextIdRef = useRef(0);
  const pendingPasteCount = useRef(0);

  // Per-task agent/model/effort overrides. Empty string means "use column
  // default" for that field. The Advanced section locks all three for the
  // task's lifetime once set - column moves cannot change them (see
  // `resolveTargetAgent` and the cross-agent guards in `task-move.ts`).
  const [agentOverride, setAgentOverride] = useState('');
  const [modelOverride, setModelOverride] = useState('');
  const [effortOverride, setEffortOverride] = useState('');
  const [permissionOverride, setPermissionOverride] = useState('');

  const isDirty = title.trim() !== '' || description.trim() !== '' || customBranchName.trim() !== '' || attachments.length > 0 || labels.length > 0 || priority !== 0 || agentOverride !== '' || modelOverride !== '' || effortOverride !== '' || permissionOverride !== '';

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
  useKeybinding('panel.close', closeWithAnimation, { capture: true });

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
      const isImage = isImageMediaType(mediaType);
      const prefix = isImage ? 'pasted-image-' : 'pasted-file-';
      const extensionStart = file.name ? file.name.lastIndexOf('.') : -1;
      const fallbackExtension = MEDIA_TYPE_EXT[mediaType] || (extensionStart >= 0 ? file.name.slice(extensionStart) : '.bin');
      const baseCount =
        attachments.filter((attachment) => attachment.filename.startsWith(prefix)).length +
        pendingPasteCount.current;
      pendingPasteCount.current += 1;
      void (async () => {
        try {
          const { file: outFile } = await compressClipboardImage(file);
          const finalMediaType = resolveMediaType(outFile);
          const finalExtension = MEDIA_TYPE_EXT[finalMediaType] ?? fallbackExtension;
          const finalName = `${prefix}${baseCount + 1}${finalExtension}`;
          await addFile(outFile, finalName);
        } finally {
          pendingPasteCount.current -= 1;
        }
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
            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={closeWithAnimation}
                className="px-4 py-1.5 text-xs text-fg-muted hover:text-fg-secondary border border-edge-input hover:border-fg-faint rounded transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!!branchNameError || submitting}
                className="px-4 py-1.5 text-xs bg-accent-emphasis hover:bg-accent text-accent-on rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {submitting ? 'Creating...' : 'Create'}
              </button>
            </div>
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

            {/* Thumbnail strip */}
            {attachments.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs text-fg-faint">{attachments.length} attachment{attachments.length !== 1 ? 's' : ''}</span>
                </div>
                <div className="flex gap-2.5 overflow-x-auto pb-1" data-testid="attachment-thumbnails">
                {attachments.map((attachment) => {
                  const isImage = isImageMediaType(attachment.media_type);
                  const FileTypeIcon = getFileTypeIcon(attachment.media_type);
                  return (
                    <div
                      key={attachment.id}
                      className="relative flex-shrink-0 w-24 h-24 rounded-md border border-edge-input overflow-hidden group cursor-pointer"
                      onClick={() => isImage ? setPreviewAttachment(attachment) : undefined}
                    >
                      {isImage ? (
                        <img
                          src={attachment.previewUrl}
                          alt={attachment.filename}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <div className="w-full h-full bg-surface-secondary flex flex-col items-center justify-evenly px-1.5 py-2">
                          <FileTypeIcon size={20} className="text-fg-muted shrink-0" />
                          <span className="text-[10px] text-fg-muted text-center break-all line-clamp-2 w-full leading-tight">
                            {attachment.filename}
                          </span>
                          <span className="bg-surface-raised border border-edge-input rounded px-1.5 py-0.5 text-[9px] font-medium text-fg-faint uppercase leading-none">
                            {getExtension(attachment.filename).replace('.', '')}
                          </span>
                        </div>
                      )}
                      <button
                        type="button"
                        onClick={(buttonEvent) => { buttonEvent.stopPropagation(); removeAttachment(attachment.id); }}
                        className="absolute top-0 right-0 p-1 bg-black/70 text-white rounded-bl opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <X size={14} />
                      </button>
                      {isImage && (
                        <div className="absolute bottom-0 left-0 right-0 bg-black/50 px-1 py-0.5 text-[9px] text-fg-tertiary truncate opacity-0 group-hover:opacity-100 transition-opacity">
                          {attachment.filename}
                        </div>
                      )}
                    </div>
                  );
                })}
                </div>
              </div>
            )}

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

            <div>
              <label className="text-[10px] text-fg-muted mb-1 block">Branch</label>
              <div className="flex items-center gap-2">
                <input
                  data-testid="custom-branch-name-input"
                  type="text"
                  placeholder={branchPlaceholder}
                  value={customBranchName}
                  onChange={(event) => setCustomBranchName(event.target.value)}
                  className={`flex-1 min-w-0 bg-surface border rounded px-3 py-1.5 text-xs text-fg placeholder-fg-faint focus:outline-none ${
                    branchNameError
                      ? 'border-red-500 focus:border-red-500'
                      : 'border-edge-input focus:border-accent'
                  }`}
                />
                <span className="text-xs text-fg-disabled shrink-0">from</span>
                <BranchPicker value={baseBranch} defaultBranch={defaultBaseBranch || 'main'} onChange={setBaseBranch} />
                <div className="w-px h-5 bg-edge-input shrink-0" />
                <WorktreeChip enabled={effectiveWorktree} onToggle={() => setUseWorktree(effectiveWorktree ? false : true)} />
              </div>
              {branchNameError ? (
                <p className="text-xs text-red-500 mt-0.5">{branchNameError}</p>
              ) : (
                <span className="text-xs text-fg-disabled mt-1 flex items-center gap-1"><Info size={12} className="shrink-0" />{branchHint}</span>
              )}
            </div>

            <AdvancedOverridesSection
              swimlaneId={swimlaneId}
              agentOverride={agentOverride}
              setAgentOverride={setAgentOverride}
              modelOverride={modelOverride}
              setModelOverride={setModelOverride}
              effortOverride={effortOverride}
              setEffortOverride={setEffortOverride}
              permissionOverride={permissionOverride}
              setPermissionOverride={setPermissionOverride}
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

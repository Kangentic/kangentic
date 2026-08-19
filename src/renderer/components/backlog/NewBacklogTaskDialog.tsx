import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Plus, Pencil, ExternalLink, Trash2, X } from 'lucide-react';
import { BaseDialog } from '../dialogs/BaseDialog';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { maximizedDialogLayout, MaximizeToggleButton } from '../dialogs/dialog-maximize';
import { PriorityLabelsRow } from '../dialogs/PriorityLabelsRow';
import { DialogFooterActions } from '../dialogs/DialogFooterActions';
import { PriorityBadge } from './PriorityBadge';
import { GitHubIcon } from '../icons/GitHubIcon';
import { NameFromPromptButton } from '../NameFromPromptButton';
import { useProjectStore } from '../../stores/project-store';
import { useSessionStore } from '../../stores/session-store';
import { useToastStore } from '../../stores/toast-store';
import { useConfigStore } from '../../stores/config-store';
import { useKeybinding } from '../../hooks/useKeybinding';
import { DescriptionEditor } from '../DescriptionEditor';
import { AttachmentChipStrip } from '../dialogs/AttachmentChipStrip';
import { MAX_ATTACHMENT_BYTES, MEDIA_TYPE_EXT, resolveMediaType, isImageMediaType, pastedAttachmentPrefix, reserveNextPastedIndex, openAttachmentWithToast } from '../dialogs/attachment-utils';
import { compressClipboardImage } from '../dialogs/image-compress';
import { formatRelativeTime } from '../../lib/datetime';
import type { BacklogTask, BacklogTaskCreateInput, BacklogTaskUpdateInput } from '../../../shared/types';

interface PendingAttachment {
  id: string;
  filename: string;
  data: string; // base64
  media_type: string;
  previewUrl: string;
}

/** A saved attachment loaded from the backend (has no base64 data in memory). */
interface SavedAttachment {
  id: string;
  filename: string;
  media_type: string;
  previewUrl: string;
  saved: true;
}

type DisplayAttachment = PendingAttachment | SavedAttachment;

function isSavedAttachment(attachment: DisplayAttachment): attachment is SavedAttachment {
  return 'saved' in attachment && attachment.saved === true;
}

interface NewBacklogTaskDialogProps {
  onClose: () => void;
  onCreate: (input: BacklogTaskCreateInput) => Promise<unknown>;
  editTask?: BacklogTask;
  onUpdate?: (input: BacklogTaskUpdateInput) => Promise<unknown>;
  /** Edit mode only. Omit to leave the footer with no Delete affordance. */
  onDelete?: (id: string) => Promise<void>;
}

// Non-task sentinel key for the maximize toggle (the backlog dialog has no task
// row). One key covers both create and edit-backlog modes; it is one surface.
const NEW_BACKLOG_TASK_ENTITY_ID = 'new-backlog-task-dialog';

export function NewBacklogTaskDialog({ onClose, onCreate, editTask, onUpdate, onDelete }: NewBacklogTaskDialogProps) {
  const isEditMode = !!editTask;
  const currentProject = useProjectStore((state) => state.currentProject);
  const isMaximized = useSessionStore((state) => state.maximizedTasks.has(NEW_BACKLOG_TASK_ENTITY_ID));
  const toggleMaximized = useSessionStore((state) => state.toggleMaximized);
  const handleToggleMaximized = useCallback(() => toggleMaximized(NEW_BACKLOG_TASK_ENTITY_ID), [toggleMaximized]);
  const skipDeleteConfirm = useConfigStore((state) => state.config.skipDeleteConfirm);
  const updateConfig = useConfigStore((state) => state.updateConfig);
  const [title, setTitle] = useState(editTask?.title ?? '');
  const [description, setDescription] = useState(editTask?.description ?? '');
  const [priority, setPriority] = useState(editTask?.priority ?? 0);
  const [labels, setLabels] = useState<string[]>(editTask?.labels ?? []);
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [attachments, setAttachments] = useState<DisplayAttachment[]>([]);
  const [previewAttachment, setPreviewAttachment] = useState<DisplayAttachment | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const nextIdRef = useRef(0);
  // Highest pasted-filename index handed out so far, per prefix. Monotonic on
  // purpose - see reserveNextPastedIndex.
  const issuedPastedIndex = useRef<Record<string, number>>({});
  // Ref tracks current attachments for cleanup on unmount (avoids stale closure)
  const attachmentsRef = useRef<DisplayAttachment[]>([]);
  attachmentsRef.current = attachments;

  // Only PENDING attachments make the form dirty - a freshly loaded saved
  // attachment is not an edit the user made, so it must not trip the
  // discard-changes guard on arrival.
  const hasPendingAttachments = attachments.some((attachment) => !isSavedAttachment(attachment));

  const isDirty = isEditMode
    ? title.trim() !== (editTask?.title ?? '') ||
      description.trim() !== (editTask?.description ?? '') ||
      priority !== (editTask?.priority ?? 0) ||
      JSON.stringify(labels) !== JSON.stringify(editTask?.labels ?? []) ||
      hasPendingAttachments
    : title.trim() !== '' || description.trim() !== '' || labels.length > 0 || priority !== 0 || hasPendingAttachments;

  // Guard close gestures (X, Escape, backdrop, Ctrl+Shift+W) so unsaved work is
  // not lost: when the form is dirty, ask before discarding. Returns true to let
  // the caller proceed with the close, false when a confirm was shown instead.
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const handleCloseAttempt = useCallback(() => {
    if (confirmDiscard || confirmDelete) return false;
    if (isDirty) { setConfirmDiscard(true); return false; }
    return true;
  }, [confirmDiscard, confirmDelete, isDirty]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Reuse the shared panel.maximize / panel.close bindings (capture phase),
  // mirroring the task detail dialog and command terminal. panel.close and
  // Escape both route through the dirty-changes guard. No ad-hoc keydown listener.
  useKeybinding('panel.maximize', handleToggleMaximized, { capture: true });
  useKeybinding('panel.close', () => { if (handleCloseAttempt()) onClose(); }, { capture: true });

  // Cleanup object URLs on unmount using ref to avoid stale closure
  useEffect(() => {
    return () => {
      attachmentsRef.current.forEach((attachment) => {
        if (!isSavedAttachment(attachment)) URL.revokeObjectURL(attachment.previewUrl);
      });
    };
  }, []);

  // Close image preview on Escape
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

  // Load existing attachments in edit mode
  useEffect(() => {
    if (!isEditMode || !editTask) return;
    let cancelled = false;
    (async () => {
      try {
        const saved = await window.electronAPI.backlogAttachments.list(editTask.id);
        if (cancelled) return;
        const displayAttachments: SavedAttachment[] = [];
        for (const attachment of saved) {
          try {
            const isImage = isImageMediaType(attachment.media_type);
            const previewUrl = isImage
              ? await window.electronAPI.backlogAttachments.getDataUrl(attachment.id)
              : '';
            if (cancelled) return;
            displayAttachments.push({
              id: attachment.id,
              filename: attachment.filename,
              media_type: attachment.media_type,
              previewUrl,
              saved: true,
            });
          } catch (error) {
            console.error('[NewBacklogTaskDialog] Failed to load attachment preview:', error);
          }
        }
        setAttachments((previous) => [...displayAttachments, ...previous]);
      } catch (error) {
        console.error('[NewBacklogTaskDialog] Failed to load attachments:', error);
      }
    })();
    return () => { cancelled = true; };
  }, [isEditMode, editTask]);

  // --- File handling ---

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
      console.error('[NewBacklogTaskDialog] Failed to read attachment:', error);
      return;
    }
    const base64 = dataUrl.split(',')[1];
    const previewUrl = URL.createObjectURL(file);
    const id = `pending-${nextIdRef.current++}`;
    const filename = filenameOverride || file.name;
    setAttachments((previous) => [...previous, { id, filename, data: base64, media_type: mediaType, previewUrl }]);
  }, []);

  const removeAttachment = useCallback((id: string) => {
    const target = attachments.find((attachment) => attachment.id === id);
    if (!target) return;

    if (isSavedAttachment(target)) {
      // Delete from backend, then update UI on success
      window.electronAPI.backlogAttachments.remove(id).then(() => {
        setAttachments((previous) => previous.filter((attachment) => attachment.id !== id));
      }).catch((error: unknown) => {
        console.error('[NewBacklogTaskDialog] Failed to remove saved attachment:', error);
      });
    } else {
      URL.revokeObjectURL(target.previewUrl);
      setAttachments((previous) => previous.filter((attachment) => attachment.id !== id));
    }
  }, [attachments]);

  const handleOpenAttachment = useCallback(async (attachment: DisplayAttachment) => {
    if (isImageMediaType(attachment.media_type)) {
      setPreviewAttachment(attachment);
      return;
    }
    if (!isSavedAttachment(attachment)) return;
    await openAttachmentWithToast(attachment.filename, () =>
      window.electronAPI.backlogAttachments.open(attachment.id),
    );
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

  // --- Submit ---

  const handleSubmit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    // The delete/discard confirms render as siblings of this <form>, not inside
    // it, so an Enter keypress while one is open is not consumed by the confirm
    // and would otherwise reach this handler and save over a pending delete.
    if (confirmDelete || confirmDiscard) return;
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    try {
      // Collect only pending (unsaved) attachments to send to backend
      const pendingAttachments = attachments
        .filter((attachment): attachment is PendingAttachment => !isSavedAttachment(attachment))
        .map(({ filename, data, media_type }) => ({ filename, data, media_type }));

      if (isEditMode && onUpdate && editTask) {
        await onUpdate({
          id: editTask.id,
          title: title.trim(),
          description: description.trim(),
          priority,
          labels,
          pendingAttachments: pendingAttachments.length > 0 ? pendingAttachments : undefined,
        });
      } else {
        await onCreate({
          title: title.trim(),
          description: description.trim(),
          priority,
          labels,
          pendingAttachments: pendingAttachments.length > 0 ? pendingAttachments : undefined,
        });
      }
      attachments.forEach((attachment) => {
        if (!isSavedAttachment(attachment)) URL.revokeObjectURL(attachment.previewUrl);
      });
      onClose();
    } finally {
      setSubmitting(false);
    }
  };

  // --- Delete (edit mode only) ---

  const performDelete = useCallback(async (dontAskAgain: boolean) => {
    if (!editTask || !onDelete || deleting) return;
    setDeleting(true);
    try {
      await onDelete(editTask.id);
      // Persist "don't ask again" only after the delete actually lands. The
      // catch below keeps the confirm open so the user can retry, and arming
      // the global bypass on a FAILED delete would make that retry - and every
      // later delete - skip the confirmation the user was still looking at.
      if (dontAskAgain) updateConfig({ skipDeleteConfirm: true });
      setConfirmDelete(false);
      onClose();
    } catch (error) {
      console.error('[NewBacklogTaskDialog] Failed to delete backlog task:', error);
      useToastStore.getState().addToast({
        message: 'Failed to delete backlog task',
        variant: 'error',
      });
      setDeleting(false);
    }
  }, [editTask, onDelete, deleting, updateConfig, onClose]);

  const { dialogClassName, backdropPositionClass, backdropClassName, contentRadiusClass } =
    maximizedDialogLayout(isMaximized, 'w-[840px] max-w-[90vw] h-[80vh]');

  return (
    <>
      <form onSubmit={handleSubmit}>
        <BaseDialog
          onClose={onClose}
          onHeaderDoubleClick={handleToggleMaximized}
          onCloseRequest={handleCloseAttempt}
          title={
            <span className="flex items-center gap-2 min-w-0">
              <span className="flex-shrink-0">{isEditMode ? 'Edit Backlog Task' : 'New Backlog Task'}</span>
              {editTask?.external_source && editTask.external_url && (
                <button
                  type="button"
                  onClick={() => window.electronAPI.shell.openExternal(editTask.external_url!)}
                  className="flex-shrink-0 text-fg-faint hover:text-fg-secondary transition-colors"
                  title={`Open in ${editTask.external_source.startsWith('github') ? 'GitHub' : editTask.external_source}`}
                  data-testid="backlog-task-external-link"
                >
                  {editTask.external_source.startsWith('github')
                    ? <GitHubIcon size={13} />
                    : <ExternalLink size={13} />}
                </button>
              )}
              <PriorityBadge priority={priority} />
            </span>
          }
          icon={isEditMode
            ? <Pencil size={14} className="text-fg-muted" />
            : <Plus size={14} className="text-fg-muted" />}
          headerRight={
            <MaximizeToggleButton isMaximized={isMaximized} onToggle={handleToggleMaximized} />
          }
          className={dialogClassName}
          backdropPositionClass={backdropPositionClass}
          backdropClassName={backdropClassName}
          contentRadiusClass={contentRadiusClass}
          bodyClassName="flex-1 min-h-0 flex flex-col overflow-y-auto"
          closeHotkeyActionId="panel.close"
          testId="new-backlog-task-dialog"
          footer={
            <DialogFooterActions
              onCancel={onClose}
              submitLabel={isEditMode ? 'Save' : 'Create'}
              busyLabel={isEditMode ? 'Saving...' : 'Creating...'}
              busy={submitting}
              disabled={!title.trim()}
              submitTestId="create-backlog-task-btn"
              leading={isEditMode && onDelete ? (
                <button
                  type="button"
                  data-testid="delete-backlog-task-btn"
                  onClick={() => skipDeleteConfirm ? void performDelete(false) : setConfirmDelete(true)}
                  className="flex items-center gap-1.5 rounded px-3 py-1.5 text-xs text-fg-faint transition-colors hover:bg-danger/10 hover:text-danger"
                >
                  <Trash2 size={14} />
                  Delete
                </button>
              ) : undefined}
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
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Task title"
                className="flex-1 min-w-0 bg-surface-control border border-edge-input rounded px-3 py-2 text-sm text-fg placeholder-fg-faint focus:outline-none focus:border-accent"
                data-testid="backlog-task-title"
              />
              <NameFromPromptButton description={description} onTitle={setTitle} />
            </div>

            <DescriptionEditor
              value={description}
              onChange={setDescription}
              onPaste={handlePaste}
              testId="backlog-task-description"
              mentionSearchCwd={currentProject?.path ?? null}
              className="flex-1"
            />

            <AttachmentChipStrip
              attachments={attachments}
              onOpen={(attachment) => { void handleOpenAttachment(attachment); }}
              onRemove={removeAttachment}
            />

            <PriorityLabelsRow
              priority={priority}
              setPriority={setPriority}
              labels={labels}
              setLabels={setLabels}
              testIdPrefix="backlog-task-"
            />

            {isEditMode && editTask && (
              <div
                className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-fg-faint"
                data-testid="backlog-task-meta"
              >
                {/* One flowing sentence, not two adjacent label:value spans -
                    two capitalized chunks ("Created X" next to "Updated Y")
                    read as a stutter, especially right after creating an item
                    when the two times are seconds apart. Lowercasing "updated"
                    into a clause continuation reads as one fact with two parts
                    instead of two competing labels. */}
                <span>
                  Created {formatRelativeTime(editTask.created_at)}, updated{' '}
                  {formatRelativeTime(editTask.updated_at)}
                </span>
                {editTask.assignee && <span>@{editTask.assignee}</span>}
              </div>
            )}

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
          message={isEditMode
            ? 'Closing now will discard your unsaved edits to this backlog task.'
            : 'Closing now will discard this new backlog task and its unsaved changes.'}
          onConfirm={() => { setConfirmDiscard(false); onClose(); }}
          onCancel={() => setConfirmDiscard(false)}
        />
      )}

      {/* Delete confirmation */}
      {confirmDelete && (
        <ConfirmDialog
          title="Delete backlog task"
          message={<>
            <p>This will permanently delete the backlog task.</p>
            <p className="text-red-400 font-medium">This action cannot be undone.</p>
          </>}
          confirmLabel="Delete"
          variant="danger"
          showDontAskAgain
          onConfirm={(dontAskAgain) => { void performDelete(dontAskAgain); }}
          onCancel={() => setConfirmDelete(false)}
        />
      )}

      {/* Full-size preview overlay (images only) */}
      {previewAttachment && isImageMediaType(previewAttachment.media_type) && (
        <div
          data-testid="attachment-preview-overlay"
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

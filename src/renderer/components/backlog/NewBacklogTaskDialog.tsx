import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Plus, X } from 'lucide-react';
import { BaseDialog } from '../dialogs/BaseDialog';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { maximizedDialogLayout, MaximizeToggleButton } from '../dialogs/dialog-maximize';
import { PriorityLabelsRow } from '../dialogs/PriorityLabelsRow';
import { DialogFooterActions } from '../dialogs/DialogFooterActions';
import { useProjectStore } from '../../stores/project-store';
import { useSessionStore } from '../../stores/session-store';
import { useToastStore } from '../../stores/toast-store';
import { useKeybinding } from '../../hooks/useKeybinding';
import { DescriptionEditor } from '../DescriptionEditor';
import { AttachmentChipStrip } from '../dialogs/AttachmentChipStrip';
import { MAX_ATTACHMENT_BYTES, MEDIA_TYPE_EXT, resolveMediaType, isImageMediaType, pastedAttachmentPrefix, reserveNextPastedIndex, openAttachmentWithToast } from '../dialogs/attachment-utils';
import { compressClipboardImage } from '../dialogs/image-compress';
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
}

// Non-task sentinel key for the maximize toggle (the backlog dialog has no task
// row). One key covers both create and edit-backlog modes; it is one surface.
const NEW_BACKLOG_TASK_ENTITY_ID = 'new-backlog-task-dialog';

export function NewBacklogTaskDialog({ onClose, onCreate, editTask, onUpdate }: NewBacklogTaskDialogProps) {
  const isEditMode = !!editTask;
  const currentProject = useProjectStore((state) => state.currentProject);
  const isMaximized = useSessionStore((state) => state.maximizedTasks.has(NEW_BACKLOG_TASK_ENTITY_ID));
  const toggleMaximized = useSessionStore((state) => state.toggleMaximized);
  const handleToggleMaximized = useCallback(() => toggleMaximized(NEW_BACKLOG_TASK_ENTITY_ID), [toggleMaximized]);
  const [title, setTitle] = useState(editTask?.title ?? '');
  const [description, setDescription] = useState(editTask?.description ?? '');
  const [priority, setPriority] = useState(editTask?.priority ?? 0);
  const [labels, setLabels] = useState<string[]>(editTask?.labels ?? []);
  const [submitting, setSubmitting] = useState(false);
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

  const isDirty = isEditMode
    ? title.trim() !== (editTask?.title ?? '') ||
      description.trim() !== (editTask?.description ?? '') ||
      priority !== (editTask?.priority ?? 0) ||
      JSON.stringify(labels) !== JSON.stringify(editTask?.labels ?? []) ||
      attachments.length > 0
    : title.trim() !== '' || description.trim() !== '' || labels.length > 0 || priority !== 0 || attachments.length > 0;

  // Guard close gestures (X, Escape, backdrop, Ctrl+Shift+W) so unsaved work is
  // not lost: when the form is dirty, ask before discarding. Returns true to let
  // the caller proceed with the close, false when a confirm was shown instead.
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const handleCloseAttempt = useCallback(() => {
    if (confirmDiscard) return false;
    if (isDirty) { setConfirmDiscard(true); return false; }
    return true;
  }, [confirmDiscard, isDirty]);

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

  const { dialogClassName, backdropPositionClass, backdropClassName, contentRadiusClass } =
    maximizedDialogLayout(isMaximized, 'w-[840px] max-w-[90vw]');

  return (
    <>
      <form onSubmit={handleSubmit}>
        <BaseDialog
          onClose={onClose}
          onHeaderDoubleClick={handleToggleMaximized}
          onCloseRequest={handleCloseAttempt}
          title={isEditMode ? 'Edit Backlog Task' : 'New Backlog Task'}
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
          testId="new-backlog-task-dialog"
          footer={
            <DialogFooterActions
              onCancel={onClose}
              submitLabel={isEditMode ? 'Save' : 'Create'}
              busyLabel={isEditMode ? 'Saving...' : 'Creating...'}
              busy={submitting}
              disabled={!title.trim()}
              submitTestId="create-backlog-task-btn"
            />
          }
        >
          <div
            className="space-y-3 relative flex flex-col flex-1"
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <input
              ref={inputRef}
              type="text"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Task title"
              className="w-full bg-surface-control border border-edge-input rounded px-3 py-2 text-sm text-fg placeholder-fg-faint focus:outline-none focus:border-accent"
              data-testid="backlog-task-title"
            />

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

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Plus, X } from 'lucide-react';
import { BaseDialog } from '../dialogs/BaseDialog';
import { Select } from '../settings/shared';
import { LabelInput } from '../LabelInput';
import { useConfigStore } from '../../stores/config-store';
import { useToastStore } from '../../stores/toast-store';
import { useAllExistingLabels } from '../../hooks/useAllExistingLabels';
import { DescriptionEditor } from '../DescriptionEditor';
import { MAX_ATTACHMENT_BYTES, MEDIA_TYPE_EXT, resolveMediaType, isImageMediaType, getFileTypeIcon, getExtension } from '../dialogs/attachment-utils';
import { DEFAULT_PRIORITY_CONFIG } from '../../../shared/types';
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

export function NewBacklogTaskDialog({ onClose, onCreate, editTask, onUpdate }: NewBacklogTaskDialogProps) {
  const isEditMode = !!editTask;
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
  // Ref tracks current attachments for cleanup on unmount (avoids stale closure)
  const attachmentsRef = useRef<DisplayAttachment[]>([]);
  attachmentsRef.current = attachments;

  const labelColors = useConfigStore((state) => state.config.backlog?.labelColors) ?? {};

  // Read priority labels from config
  const priorities = useConfigStore((state) => state.config.backlog?.priorities) ?? DEFAULT_PRIORITY_CONFIG;

  const allExistingLabels = useAllExistingLabels();

  const isDirty = isEditMode
    ? title.trim() !== (editTask?.title ?? '') ||
      description.trim() !== (editTask?.description ?? '') ||
      priority !== (editTask?.priority ?? 0) ||
      JSON.stringify(labels) !== JSON.stringify(editTask?.labels ?? []) ||
      attachments.length > 0
    : title.trim() !== '' || description.trim() !== '' || labels.length > 0 || priority !== 0 || attachments.length > 0;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

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

  const addFile = useCallback((file: File, filenameOverride?: string) => {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      useToastStore.getState().addToast({
        message: `File "${file.name}" exceeds 10MB limit`,
        variant: 'warning',
      });
      return;
    }

    const mediaType = resolveMediaType(file);

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(',')[1];
      const previewUrl = URL.createObjectURL(file);
      const id = `pending-${nextIdRef.current++}`;
      const filename = filenameOverride || file.name;
      setAttachments((previous) => [...previous, { id, filename, data: base64, media_type: mediaType, previewUrl }]);
    };
    reader.readAsDataURL(file);
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
      const extension = MEDIA_TYPE_EXT[mediaType] || (extensionStart >= 0 ? file.name.slice(extensionStart) : '.bin');
      const name = (() => {
        const count = attachments.filter((attachment) => attachment.filename.startsWith(prefix)).length;
        return `${prefix}${count + 1}${extension}`;
      })();
      addFile(file, name);
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

  return (
    <>
      <form onSubmit={handleSubmit}>
        <BaseDialog
          onClose={onClose}
          preventBackdropClose={isDirty}
          title={isEditMode ? 'Edit Backlog Task' : 'New Backlog Task'}
          icon={<Plus size={14} className="text-fg-muted" />}
          className="w-[700px]"
          testId="new-backlog-task-dialog"
          footer={
            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-1.5 text-xs text-fg-muted hover:text-fg-secondary border border-edge-input hover:border-fg-faint rounded transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={!title.trim() || submitting}
                className="px-4 py-1.5 text-xs bg-accent-emphasis hover:bg-accent text-accent-on rounded transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                data-testid="create-backlog-task-btn"
              >
                {submitting ? (isEditMode ? 'Saving...' : 'Creating...') : (isEditMode ? 'Save' : 'Create')}
              </button>
            </div>
          }
        >
          <div
            className="space-y-3 relative"
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
              className="w-full bg-surface border border-edge-input rounded px-3 py-2 text-sm text-fg placeholder-fg-faint focus:outline-none focus:border-accent"
              data-testid="backlog-task-title"
            />

            <DescriptionEditor
              value={description}
              onChange={setDescription}
              onPaste={handlePaste}
              testId="backlog-task-description"
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
                        onClick={() => {
                          if (isImage) {
                            setPreviewAttachment(attachment);
                          } else if (isSavedAttachment(attachment)) {
                            window.electronAPI.backlogAttachments.open(attachment.id);
                          }
                        }}
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
                  data-testid="backlog-task-priority"
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
                testId="backlog-task-labels"
              />
            </div>

            {/* Drag overlay */}
            {isDragOver && (
              <div className="absolute inset-0 bg-accent/10 border-2 border-dashed border-accent rounded-lg flex items-center justify-center z-10 pointer-events-none">
                <span className="text-sm text-accent-fg font-medium">Drop files here</span>
              </div>
            )}
          </div>
        </BaseDialog>
      </form>

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

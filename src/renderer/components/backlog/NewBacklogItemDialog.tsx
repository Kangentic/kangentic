import React, { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import { Plus, X, Image } from 'lucide-react';
import { BaseDialog } from '../dialogs/BaseDialog';
import { Select } from '../settings/shared';
import { Pill } from '../Pill';
import { useBacklogStore } from '../../stores/backlog-store';
import { useConfigStore } from '../../stores/config-store';
import { useToastStore } from '../../stores/toast-store';
import type { BacklogItem, BacklogItemCreateInput } from '../../../shared/types';

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10MB

const MEDIA_TYPE_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

interface PendingAttachment {
  id: string;
  filename: string;
  data: string; // base64
  media_type: string;
  previewUrl: string;
}

interface NewBacklogItemDialogProps {
  onClose: () => void;
  onCreate: (input: BacklogItemCreateInput) => Promise<unknown>;
  editItem?: BacklogItem;
  onUpdate?: (input: { id: string; title?: string; description?: string; priority?: number; labels?: string[] }) => Promise<unknown>;
}

export function NewBacklogItemDialog({ onClose, onCreate, editItem, onUpdate }: NewBacklogItemDialogProps) {
  const isEditMode = !!editItem;
  const [title, setTitle] = useState(editItem?.title ?? '');
  const [description, setDescription] = useState(editItem?.description ?? '');
  const [priority, setPriority] = useState(editItem?.priority ?? 0);
  const [labels, setLabels] = useState<string[]>(editItem?.labels ?? []);
  const [labelInput, setLabelInput] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [previewAttachment, setPreviewAttachment] = useState<PendingAttachment | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [textareaFocused, setTextareaFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const labelInputRef = useRef<HTMLInputElement>(null);
  const suggestionsRef = useRef<HTMLDivElement>(null);
  const nextIdRef = useRef(0);
  // Ref tracks current attachments for cleanup on unmount (avoids stale closure)
  const attachmentsRef = useRef<PendingAttachment[]>([]);
  attachmentsRef.current = attachments;

  const labelColors = useConfigStore((state) => state.config.backlog?.labelColors) ?? {};

  // Read priority labels from config
  const priorities = useConfigStore((state) => state.config.backlog?.priorities) ?? [
    { label: 'None', color: '#6b7280' },
    { label: 'Low', color: '#3b82f6' },
    { label: 'Medium', color: '#eab308' },
    { label: 'High', color: '#f97316' },
    { label: 'Urgent', color: '#ef4444' },
  ];

  // Collect all unique labels from existing backlog items for auto-complete
  const existingItems = useBacklogStore((state) => state.items);
  const allExistingLabels = useMemo(() => {
    const labelSet = new Set<string>();
    for (const item of existingItems) {
      for (const label of item.labels) {
        labelSet.add(label);
      }
    }
    return [...labelSet].sort();
  }, [existingItems]);

  const filteredSuggestions = useMemo(() => {
    const query = labelInput.toLowerCase().trim();
    return allExistingLabels.filter(
      (label) => label.toLowerCase().includes(query) && !labels.includes(label),
    );
  }, [labelInput, allExistingLabels, labels]);

  const isDirty = isEditMode
    ? title.trim() !== (editItem?.title ?? '') ||
      description.trim() !== (editItem?.description ?? '') ||
      priority !== (editItem?.priority ?? 0) ||
      JSON.stringify(labels) !== JSON.stringify(editItem?.labels ?? []) ||
      attachments.length > 0
    : title.trim() !== '' || description.trim() !== '' || labels.length > 0 || priority !== 0 || attachments.length > 0;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Cleanup object URLs on unmount using ref to avoid stale closure
  useEffect(() => {
    return () => {
      attachmentsRef.current.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl));
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

  // Auto-expand textarea as user types
  useEffect(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = 'auto';
    element.style.height = `${Math.min(element.scrollHeight, 800)}px`;
  }, [description]);

  // Close suggestions on click outside
  useEffect(() => {
    if (!showSuggestions) return;
    const handleClick = (event: MouseEvent) => {
      if (
        suggestionsRef.current && !suggestionsRef.current.contains(event.target as Node) &&
        labelInputRef.current && !labelInputRef.current.contains(event.target as Node)
      ) {
        setShowSuggestions(false);
      }
    };
    document.addEventListener('mousedown', handleClick, true);
    return () => document.removeEventListener('mousedown', handleClick, true);
  }, [showSuggestions]);

  // --- Image handling ---

  const addImageFile = useCallback((file: File, filenameOverride?: string) => {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      useToastStore.getState().addToast({
        message: `Image "${file.name}" exceeds 10MB limit`,
        variant: 'warning',
      });
      return;
    }
    if (!file.type.startsWith('image/')) return;

    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(',')[1];
      const previewUrl = URL.createObjectURL(file);
      const id = `pending-${nextIdRef.current++}`;
      const filename = filenameOverride || file.name;
      setAttachments((previous) => [...previous, { id, filename, data: base64, media_type: file.type, previewUrl }]);
    };
    reader.readAsDataURL(file);
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
      if (item.type.startsWith('image/')) {
        event.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        const extension = MEDIA_TYPE_EXT[file.type] || '.png';
        const name = (() => {
          const count = attachments.filter((attachment) => attachment.filename.startsWith('pasted-image-')).length;
          return `pasted-image-${count + 1}${extension}`;
        })();
        addImageFile(file, name);
      }
    }
  }, [attachments, addImageFile]);

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
      const file = files[index];
      if (file.type.startsWith('image/')) addImageFile(file);
    }
  }, [addImageFile]);

  // --- Labels ---

  const addLabel = (label: string) => {
    const trimmed = label.trim();
    if (trimmed && !labels.includes(trimmed)) {
      setLabels([...labels, trimmed]);
    }
    setLabelInput('');
    setShowSuggestions(false);
    labelInputRef.current?.focus();
  };

  const removeLabel = (label: string) => {
    setLabels(labels.filter((existingLabel) => existingLabel !== label));
  };

  const handleLabelKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ',') {
      event.preventDefault();
      if (labelInput.trim()) {
        addLabel(labelInput);
      }
    } else if (event.key === 'Backspace' && !labelInput && labels.length > 0) {
      removeLabel(labels[labels.length - 1]);
    } else if (event.key === 'Escape' && showSuggestions) {
      event.stopPropagation();
      setShowSuggestions(false);
    }
  };

  // --- Submit ---

  const handleSubmit = async (event?: React.FormEvent) => {
    event?.preventDefault();
    if (!title.trim() || submitting) return;
    setSubmitting(true);
    const finalLabels = labelInput.trim()
      ? [...labels, labelInput.trim()].filter((label, index, array) => array.indexOf(label) === index)
      : labels;
    try {
      if (isEditMode && onUpdate && editItem) {
        await onUpdate({
          id: editItem.id,
          title: title.trim(),
          description: description.trim(),
          priority,
          labels: finalLabels,
        });
      } else {
        await onCreate({
          title: title.trim(),
          description: description.trim(),
          priority,
          labels: finalLabels,
        });
      }
      attachments.forEach((attachment) => URL.revokeObjectURL(attachment.previewUrl));
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
          className="w-[640px]"
          testId="new-backlog-item-dialog"
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
                data-testid="create-backlog-item-btn"
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
              data-testid="backlog-item-title"
            />

            <div className="relative">
              <textarea
                ref={textareaRef}
                value={description}
                onChange={(event) => setDescription(event.target.value)}
                onPaste={handlePaste}
                onFocus={() => setTextareaFocused(true)}
                onBlur={() => setTextareaFocused(false)}
                className="w-full bg-surface border border-edge-input rounded px-3 py-2 text-sm text-fg focus:outline-none focus:border-accent min-h-[200px] max-h-[800px] resize-y overflow-y-auto"
                data-testid="backlog-item-description"
              />
              {/* Visual placeholder with image drop hint */}
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

            {/* Thumbnail strip */}
            {attachments.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-xs text-fg-faint">{attachments.length} image{attachments.length !== 1 ? 's' : ''}</span>
                </div>
                <div className="flex gap-2.5 overflow-x-auto pb-1" data-testid="attachment-thumbnails">
                  {attachments.map((attachment) => (
                    <div
                      key={attachment.id}
                      className="relative flex-shrink-0 w-24 h-24 rounded-md border border-edge-input overflow-hidden group cursor-pointer"
                      onClick={() => setPreviewAttachment(attachment)}
                    >
                      <img
                        src={attachment.previewUrl}
                        alt={attachment.filename}
                        className="w-full h-full object-cover"
                      />
                      <button
                        type="button"
                        onClick={(buttonEvent) => { buttonEvent.stopPropagation(); removeAttachment(attachment.id); }}
                        className="absolute top-0 right-0 p-1 bg-black/70 text-white rounded-bl opacity-0 group-hover:opacity-100 transition-opacity"
                      >
                        <X size={14} />
                      </button>
                      <div className="absolute bottom-0 left-0 right-0 bg-black/50 px-1 py-0.5 text-[9px] text-fg-tertiary truncate opacity-0 group-hover:opacity-100 transition-opacity">
                        {attachment.filename}
                      </div>
                    </div>
                  ))}
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
                  data-testid="backlog-item-priority"
                >
                  {priorities.map((priorityEntry, index) => (
                    <option key={index} value={index}>{priorityEntry.label}</option>
                  ))}
                </Select>
              </div>

              <div className="flex-1 relative">
                <label className="text-xs text-fg-muted mb-1 block">Labels</label>
                <div className="flex flex-wrap items-center gap-1 bg-surface border border-edge-input rounded px-2 py-1 min-h-[32px] focus-within:border-accent">
                  {labels.map((label) => {
                    const color = labelColors[label];
                    return (
                    <Pill
                      key={label}
                      size="sm"
                      className={color ? 'font-medium' : 'bg-surface-raised text-fg-secondary font-medium border border-edge-input'}
                      style={color ? { backgroundColor: `${color}30`, color, border: `1px solid ${color}40` } : undefined}
                    >
                      {label}
                      <button
                        type="button"
                        onClick={() => removeLabel(label)}
                        className="ml-px rounded-full hover:bg-black/20 p-0.5 opacity-60 hover:opacity-100 transition-opacity"
                      >
                        <X size={12} />
                      </button>
                    </Pill>
                    );
                  })}
                  <input
                    ref={labelInputRef}
                    type="text"
                    value={labelInput}
                    onChange={(event) => {
                      setLabelInput(event.target.value);
                      setShowSuggestions(true);
                    }}
                    onFocus={() => setShowSuggestions(true)}
                    onKeyDown={handleLabelKeyDown}
                    placeholder={labels.length === 0 ? 'Type to add...' : ''}
                    className="flex-1 min-w-[80px] bg-transparent text-xs text-fg placeholder-fg-faint outline-none py-0.5"
                    data-testid="backlog-item-labels"
                  />
                </div>

                {/* Label suggestions dropdown */}
                {showSuggestions && filteredSuggestions.length > 0 && (
                  <div
                    ref={suggestionsRef}
                    className="absolute z-50 left-0 right-0 mt-1 bg-surface-raised border border-edge rounded-lg shadow-xl py-1 max-h-[150px] overflow-y-auto"
                  >
                    {filteredSuggestions.map((suggestion) => (
                      <button
                        key={suggestion}
                        type="button"
                        onClick={() => addLabel(suggestion)}
                        className="w-full px-3 py-1.5 text-xs text-fg-secondary text-left hover:bg-surface-hover/40"
                      >
                        {suggestion}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Drag overlay */}
            {isDragOver && (
              <div className="absolute inset-0 bg-accent/10 border-2 border-dashed border-accent rounded-lg flex items-center justify-center z-10 pointer-events-none">
                <span className="text-sm text-accent-fg font-medium">Drop images here</span>
              </div>
            )}
          </div>
        </BaseDialog>
      </form>

      {/* Full-size preview overlay */}
      {previewAttachment && (
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

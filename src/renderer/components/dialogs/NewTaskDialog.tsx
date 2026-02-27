import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Plus, ChevronRight, X, Image } from 'lucide-react';
import { useBoardStore } from '../../stores/board-store';
import { useConfigStore } from '../../stores/config-store';
import { useToastStore } from '../../stores/toast-store';
import { BaseDialog } from './BaseDialog';

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

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

interface NewTaskDialogProps {
  swimlaneId: string;
  onClose: () => void;
}

export function NewTaskDialog({ swimlaneId, onClose }: NewTaskDialogProps) {
  const createTask = useBoardStore((s) => s.createTask);
  const defaultBaseBranch = useConfigStore((s) => s.config.git.defaultBaseBranch);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [baseBranch, setBaseBranch] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [previewAttachment, setPreviewAttachment] = useState<PendingAttachment | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);
  const [textareaFocused, setTextareaFocused] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const nextIdRef = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Cleanup object URLs on unmount
  useEffect(() => {
    return () => {
      attachments.forEach((a) => URL.revokeObjectURL(a.previewUrl));
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-expand textarea as user types
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 800)}px`;
  }, [description]);

  const addImageFile = useCallback((file: File, filenameOverride?: string) => {
    if (file.size > MAX_IMAGE_SIZE) {
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
      setAttachments((prev) => [...prev, {
        id,
        filename,
        data: base64,
        media_type: file.type,
        previewUrl,
      }]);
    };
    reader.readAsDataURL(file);
  }, []);

  const removeAttachment = useCallback((id: string) => {
    setAttachments((prev) => {
      const removed = prev.find((a) => a.id === id);
      if (removed) URL.revokeObjectURL(removed.previewUrl);
      return prev.filter((a) => a.id !== id);
    });
  }, []);

  const handlePaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        const ext = MEDIA_TYPE_EXT[file.type] || '.png';
        // Count existing pasted images for sequential naming
        const name = (() => {
          const count = attachments.filter((a) => a.filename.startsWith('pasted-image-')).length;
          return `pasted-image-${count + 1}${ext}`;
        })();
        addImageFile(file, name);
      }
    }
  }, [attachments, addImageFile]);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);

    const files = e.dataTransfer?.files;
    if (!files) return;
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      if (file.type.startsWith('image/')) {
        addImageFile(file);
      }
    }
  }, [addImageFile]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    const taskTitle = title.trim();
    await createTask({
      title: taskTitle,
      description: description.trim(),
      swimlane_id: swimlaneId,
      ...(baseBranch.trim() ? { baseBranch: baseBranch.trim() } : {}),
      ...(attachments.length > 0 ? {
        pendingAttachments: attachments.map((a) => ({
          filename: a.filename,
          data: a.data,
          media_type: a.media_type,
        })),
      } : {}),
    });
    // Revoke all preview URLs
    attachments.forEach((a) => URL.revokeObjectURL(a.previewUrl));
    useToastStore.getState().addToast({
      message: `Created task "${taskTitle}"`,
      variant: 'info',
    });
    onClose();
  };

  return (
    <>
      <form onSubmit={handleSubmit}>
        <BaseDialog
          onClose={onClose}
          title="New Task"
          icon={<Plus size={14} className="text-zinc-400" />}
          className="w-[640px]"
          footer={
            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-1.5 text-xs text-zinc-400 hover:text-zinc-200 border border-zinc-600 hover:border-zinc-500 rounded transition-colors"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="px-4 py-1.5 text-xs bg-blue-600 hover:bg-blue-500 text-white rounded transition-colors"
              >
                Create
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
              placeholder="Task title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full bg-zinc-900 border border-zinc-600 rounded px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-blue-500"
            />
            <div className="relative">
              <textarea
                ref={textareaRef}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                onPaste={handlePaste}
                onFocus={() => setTextareaFocused(true)}
                onBlur={() => setTextareaFocused(false)}
                className="w-full bg-zinc-900 border border-zinc-600 rounded px-3 py-2 text-sm text-zinc-100 focus:outline-none focus:border-blue-500 min-h-[200px] max-h-[800px] resize-y overflow-y-auto"
              />
              {/* Custom visual placeholder — vanishes when user types */}
              {!description && (
                <div className={`absolute inset-0 flex flex-col pointer-events-none px-3 py-2 transition-opacity duration-200 ${textareaFocused ? 'opacity-100' : 'opacity-40'}`}>
                  <span className="text-sm text-zinc-500">Describe the task for the agent...</span>
                  <div className="flex-1 flex items-center justify-center">
                    <div className="flex flex-col items-center gap-1.5 border border-dashed border-zinc-700 rounded-lg px-6 py-4">
                      <Image size={20} className="text-zinc-600" />
                      <span className="text-xs text-zinc-600">Paste or drop images here</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Thumbnail strip */}
            {attachments.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-1.5">
                  <span className="text-[10px] text-zinc-500">{attachments.length} image{attachments.length !== 1 ? 's' : ''}</span>
                </div>
                <div className="flex gap-2.5 overflow-x-auto pb-1" data-testid="attachment-thumbnails">
                {attachments.map((att) => (
                  <div
                    key={att.id}
                    className="relative flex-shrink-0 w-24 h-24 rounded-md border border-zinc-600 overflow-hidden group cursor-pointer"
                    onClick={() => setPreviewAttachment(att)}
                  >
                    <img
                      src={att.previewUrl}
                      alt={att.filename}
                      className="w-full h-full object-cover"
                    />
                    <button
                      type="button"
                      onClick={(e) => { e.stopPropagation(); removeAttachment(att.id); }}
                      className="absolute top-0 right-0 p-1 bg-black/70 text-white rounded-bl opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <X size={14} />
                    </button>
                    <div className="absolute bottom-0 left-0 right-0 bg-black/50 px-1 py-0.5 text-[9px] text-zinc-300 truncate opacity-0 group-hover:opacity-100 transition-opacity">
                      {att.filename}
                    </div>
                  </div>
                ))}
                </div>
              </div>
            )}

            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-1 text-xs text-zinc-400 hover:text-zinc-200 transition-colors"
            >
              <ChevronRight size={12} className={`transition-transform ${showAdvanced ? 'rotate-90' : ''}`} />
              Advanced
            </button>
            {showAdvanced && (
              <div className="space-y-1">
                <label className="text-xs text-zinc-400">Base Branch</label>
                <input
                  type="text"
                  placeholder={defaultBaseBranch || 'main'}
                  value={baseBranch}
                  onChange={(e) => setBaseBranch(e.target.value)}
                  className="w-full bg-zinc-900 border border-zinc-600 rounded px-3 py-2 text-sm text-zinc-100 placeholder-zinc-500 focus:outline-none focus:border-blue-500"
                />
              </div>
            )}

            {/* Drag overlay */}
            {isDragOver && (
              <div className="absolute inset-0 bg-blue-500/10 border-2 border-dashed border-blue-500 rounded-lg flex items-center justify-center z-10 pointer-events-none">
                <span className="text-sm text-blue-400 font-medium">Drop images here</span>
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
            className="absolute top-4 right-4 p-2 text-zinc-400 hover:text-zinc-200 transition-colors"
            onClick={() => setPreviewAttachment(null)}
          >
            <X size={24} />
          </button>
          <img
            src={previewAttachment.previewUrl}
            alt={previewAttachment.filename}
            className="max-w-[90vw] max-h-[85vh] object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          <p className="mt-2 text-sm text-zinc-400">{previewAttachment.filename}</p>
        </div>
      )}
    </>
  );
}

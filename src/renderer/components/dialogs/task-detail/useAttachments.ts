import { useState, useRef, useEffect, useCallback } from 'react';
import { useToastStore } from '../../../stores/toast-store';
import type { TaskAttachment } from '../../../../shared/types';

const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024; // 10MB

const MEDIA_TYPE_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

export interface AttachmentWithPreview extends TaskAttachment {
  previewUrl?: string;
}

export function useAttachments(taskId: string, updateAttachmentCount: (taskId: string, delta: number) => void) {
  const [savedAttachments, setSavedAttachments] = useState<AttachmentWithPreview[]>([]);
  const [previewAttachment, setPreviewAttachment] = useState<{ url: string; filename: string } | null>(null);
  const previewOpenRef = useRef(false);
  const [isDragOver, setIsDragOver] = useState(false);

  // Load attachments on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await window.electronAPI.attachments.list(taskId);
        if (cancelled) return;
        // Load preview data URLs for each attachment
        const withPreviews = await Promise.all(
          list.map(async (att) => {
            try {
              const previewUrl = await window.electronAPI.attachments.getDataUrl(att.id);
              return { ...att, previewUrl };
            } catch {
              return { ...att, previewUrl: undefined };
            }
          }),
        );
        if (!cancelled) setSavedAttachments(withPreviews);
      } catch {
        // No attachments API (e.g. in tests) -- ignore
      }
    })();
    return () => { cancelled = true; };
  }, [taskId]);

  const addImageFile = useCallback(async (file: File, filenameOverride?: string) => {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      useToastStore.getState().addToast({
        message: `Image "${file.name}" exceeds 10MB limit`,
        variant: 'warning',
      });
      return;
    }
    if (!file.type.startsWith('image/')) return;

    const reader = new FileReader();
    reader.onload = async () => {
      const dataUrl = reader.result as string;
      const base64 = dataUrl.split(',')[1];
      const filename = filenameOverride || file.name;
      try {
        const attachment = await window.electronAPI.attachments.add({
          task_id: taskId,
          filename,
          data: base64,
          media_type: file.type,
        });
        const previewUrl = await window.electronAPI.attachments.getDataUrl(attachment.id);
        setSavedAttachments((prev) => [...prev, { ...attachment, previewUrl }]);
        updateAttachmentCount(taskId, 1);
      } catch (err) {
        console.error('Failed to add attachment:', err);
      }
    };
    reader.readAsDataURL(file);
  }, [taskId, updateAttachmentCount]);

  const removeAttachment = useCallback(async (id: string) => {
    try {
      await window.electronAPI.attachments.remove(id);
      setSavedAttachments((prev) => prev.filter((a) => a.id !== id));
      updateAttachmentCount(taskId, -1);
    } catch (err) {
      console.error('Failed to remove attachment:', err);
    }
  }, [taskId, updateAttachmentCount]);

  const handleAttachmentPaste = useCallback((e: React.ClipboardEvent) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (!file) continue;
        const ext = MEDIA_TYPE_EXT[file.type] || '.png';
        const count = savedAttachments.filter((a) => a.filename.startsWith('pasted-image-')).length;
        const name = `pasted-image-${count + 1}${ext}`;
        addImageFile(file, name);
      }
    }
  }, [savedAttachments, addImageFile]);

  const handleAttachmentDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleAttachmentDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleAttachmentDrop = useCallback((e: React.DragEvent) => {
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

  const handlePreview = useCallback(async (att: AttachmentWithPreview) => {
    if (att.previewUrl) {
      setPreviewAttachment({ url: att.previewUrl, filename: att.filename });
      previewOpenRef.current = true;
    }
  }, []);

  const closePreview = useCallback(() => {
    setPreviewAttachment(null);
    previewOpenRef.current = false;
  }, []);

  // Close image preview on Escape (capture phase -- fires before BaseDialog's handler)
  useEffect(() => {
    if (!previewAttachment) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setPreviewAttachment(null);
        previewOpenRef.current = false;
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [previewAttachment]);

  return {
    savedAttachments,
    previewAttachment,
    previewOpenRef,
    isDragOver,
    addImageFile,
    removeAttachment,
    handleAttachmentPaste,
    handleAttachmentDragOver,
    handleAttachmentDragLeave,
    handleAttachmentDrop,
    handlePreview,
    closePreview,
  };
}

export type AttachmentsState = ReturnType<typeof useAttachments>;

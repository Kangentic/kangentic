import { useState, useRef, useEffect, useCallback } from 'react';
import { useToastStore } from '../../../stores/toast-store';
import { MAX_ATTACHMENT_BYTES, MEDIA_TYPE_EXT, resolveMediaType, isImageMediaType, pastedAttachmentPrefix, reserveNextPastedIndex, openAttachmentWithToast } from '../attachment-utils';
import { compressClipboardImage } from '../image-compress';
import type { TaskAttachment } from '../../../../shared/types';

export interface AttachmentWithPreview extends TaskAttachment {
  previewUrl?: string;
}

export function useAttachments(taskId: string, updateAttachmentCount: (taskId: string, delta: number) => void) {
  const [savedAttachments, setSavedAttachments] = useState<AttachmentWithPreview[]>([]);
  const [previewAttachment, setPreviewAttachment] = useState<{ url: string; filename: string } | null>(null);
  const previewOpenRef = useRef(false);
  const [isDragOver, setIsDragOver] = useState(false);
  // Highest pasted-filename index handed out so far, per prefix. Monotonic on
  // purpose - see reserveNextPastedIndex.
  const issuedPastedIndex = useRef<Record<string, number>>({});

  // Load attachments on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await window.electronAPI.attachments.list(taskId);
        if (cancelled) return;
        // Load preview data URLs for image attachments
        const withPreviews = await Promise.all(
          list.map(async (attachment) => {
            if (!isImageMediaType(attachment.media_type)) {
              return { ...attachment, previewUrl: undefined };
            }
            try {
              const previewUrl = await window.electronAPI.attachments.getDataUrl(attachment.id);
              return { ...attachment, previewUrl };
            } catch {
              return { ...attachment, previewUrl: undefined };
            }
          }),
        );
        if (!cancelled) setSavedAttachments(withPreviews);
      } catch {
        // No attachments API (e.g. in tests) - ignore
      }
    })();
    return () => { cancelled = true; };
  }, [taskId]);

  const addFile = useCallback(async (file: File, filenameOverride?: string) => {
    if (file.size > MAX_ATTACHMENT_BYTES) {
      useToastStore.getState().addToast({
        message: `File "${file.name}" exceeds 10MB limit`,
        variant: 'warning',
      });
      return;
    }

    const mediaType = resolveMediaType(file);
    const filename = filenameOverride || file.name;

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

    try {
      const attachment = await window.electronAPI.attachments.add({
        task_id: taskId,
        filename,
        data: base64,
        media_type: mediaType,
      });
      let previewUrl: string | undefined;
      if (isImageMediaType(mediaType)) {
        try {
          previewUrl = await window.electronAPI.attachments.getDataUrl(attachment.id);
        } catch {
          // Preview not available
        }
      }
      setSavedAttachments((previous) => [...previous, { ...attachment, previewUrl }]);
      updateAttachmentCount(taskId, 1);
    } catch (error) {
      console.error('Failed to add attachment:', error);
    }
  }, [taskId, updateAttachmentCount]);

  const removeAttachment = useCallback(async (id: string) => {
    try {
      await window.electronAPI.attachments.remove(id);
      setSavedAttachments((previous) => previous.filter((attachment) => attachment.id !== id));
      updateAttachmentCount(taskId, -1);
    } catch (error) {
      console.error('Failed to remove attachment:', error);
    }
  }, [taskId, updateAttachmentCount]);

  const handleAttachmentPaste = useCallback((event: React.ClipboardEvent) => {
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
        savedAttachments.map((attachment) => attachment.filename),
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
  }, [savedAttachments, addFile]);

  const handleAttachmentDragOver = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(true);
  }, []);

  const handleAttachmentDragLeave = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleAttachmentDrop = useCallback((event: React.DragEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setIsDragOver(false);

    const files = event.dataTransfer?.files;
    if (!files) return;
    for (let index = 0; index < files.length; index++) {
      addFile(files[index]);
    }
  }, [addFile]);

  const handlePreview = useCallback(async (attachment: AttachmentWithPreview) => {
    if (isImageMediaType(attachment.media_type) && attachment.previewUrl) {
      setPreviewAttachment({ url: attachment.previewUrl, filename: attachment.filename });
      previewOpenRef.current = true;
    }
  }, []);

  const handleOpenExternal = useCallback(async (attachment: AttachmentWithPreview) => {
    await openAttachmentWithToast(attachment.filename, () =>
      window.electronAPI.attachments.open(attachment.id),
    );
  }, []);

  const closePreview = useCallback(() => {
    setPreviewAttachment(null);
    previewOpenRef.current = false;
  }, []);

  // Close image preview on Escape (capture phase - fires before BaseDialog's handler)
  useEffect(() => {
    if (!previewAttachment) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
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
    addFile,
    removeAttachment,
    handleAttachmentPaste,
    handleAttachmentDragOver,
    handleAttachmentDragLeave,
    handleAttachmentDrop,
    handlePreview,
    handleOpenExternal,
    closePreview,
  };
}

export type AttachmentsState = ReturnType<typeof useAttachments>;

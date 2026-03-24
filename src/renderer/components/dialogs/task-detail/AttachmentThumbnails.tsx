import { X } from 'lucide-react';
import { isImageMediaType, getFileTypeIcon, getExtension } from '../attachment-utils';
import type { AttachmentWithPreview } from './useAttachments';

interface AttachmentThumbnailsProps {
  attachments: AttachmentWithPreview[];
  isEditing: boolean;
  onPreview: (attachment: AttachmentWithPreview) => void;
  onOpenExternal: (attachment: AttachmentWithPreview) => void;
  onRemove: (id: string) => void;
}

export function AttachmentThumbnails({ attachments, isEditing, onPreview, onOpenExternal, onRemove }: AttachmentThumbnailsProps) {
  if (attachments.length === 0) return null;

  return (
    <div className="flex gap-2.5 overflow-x-auto pb-1" data-testid="attachment-thumbnails">
      {attachments.map((attachment) => {
        const isImage = isImageMediaType(attachment.media_type);
        const FileTypeIcon = getFileTypeIcon(attachment.media_type);

        return (
          <div
            key={attachment.id}
            className="relative flex-shrink-0 w-24 h-24 rounded-md border border-edge-input overflow-hidden group cursor-pointer"
            onClick={() => isImage ? onPreview(attachment) : onOpenExternal(attachment)}
          >
            {isImage && attachment.previewUrl ? (
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
            {isEditing && (
              <button
                onClick={(event) => { event.stopPropagation(); onRemove(attachment.id); }}
                className="absolute top-0 right-0 p-1 bg-black/70 text-white rounded-bl opacity-0 group-hover:opacity-100 transition-opacity"
              >
                <X size={14} />
              </button>
            )}
            {isImage && (
              <div className="absolute bottom-0 left-0 right-0 bg-black/50 px-1 py-0.5 text-[9px] text-fg-tertiary truncate opacity-0 group-hover:opacity-100 transition-opacity">
                {attachment.filename}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

import { X } from 'lucide-react';
import type { AttachmentWithPreview } from './useAttachments';

interface AttachmentThumbnailsProps {
  attachments: AttachmentWithPreview[];
  isEditing: boolean;
  onPreview: (attachment: AttachmentWithPreview) => void;
  onRemove: (id: string) => void;
}

export function AttachmentThumbnails({ attachments, isEditing, onPreview, onRemove }: AttachmentThumbnailsProps) {
  if (attachments.length === 0) return null;

  return (
    <div className="flex gap-2.5 overflow-x-auto pb-1" data-testid="attachment-thumbnails">
      {attachments.map((att) => (
        <div
          key={att.id}
          className="relative flex-shrink-0 w-24 h-24 rounded-md border border-edge-input overflow-hidden group cursor-pointer"
          onClick={() => onPreview(att)}
        >
          {att.previewUrl && (
            <img
              src={att.previewUrl}
              alt={att.filename}
              className="w-full h-full object-cover"
            />
          )}
          {isEditing && (
            <button
              onClick={(e) => { e.stopPropagation(); onRemove(att.id); }}
              className="absolute top-0 right-0 p-1 bg-black/70 text-white rounded-bl opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <X size={14} />
            </button>
          )}
          <div className="absolute bottom-0 left-0 right-0 bg-black/50 px-1 py-0.5 text-[9px] text-fg-tertiary truncate opacity-0 group-hover:opacity-100 transition-opacity">
            {att.filename}
          </div>
        </div>
      ))}
    </div>
  );
}

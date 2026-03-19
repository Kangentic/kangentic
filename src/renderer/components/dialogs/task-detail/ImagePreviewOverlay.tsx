import { X } from 'lucide-react';

interface ImagePreviewOverlayProps {
  url: string;
  filename: string;
  onClose: () => void;
}

export function ImagePreviewOverlay({ url, filename, onClose }: ImagePreviewOverlayProps) {
  return (
    <div
      className="fixed inset-0 bg-black/80 flex flex-col items-center justify-center z-[60]"
      onClick={onClose}
    >
      <button
        className="absolute top-4 right-4 p-2 text-fg-muted hover:text-fg-secondary transition-colors"
        onClick={onClose}
      >
        <X size={24} />
      </button>
      <img
        src={url}
        alt={filename}
        className="max-w-[90vw] max-h-[85vh] object-contain"
        onClick={(e) => e.stopPropagation()}
      />
      <p className="mt-2 text-sm text-fg-muted">{filename}</p>
    </div>
  );
}

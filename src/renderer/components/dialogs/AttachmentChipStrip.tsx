import { X } from 'lucide-react';
import { isImageMediaType, getFileTypeIcon } from './attachment-utils';

/**
 * The subset of an attachment this strip renders. Deliberately structural
 * rather than tied to one dialog's row type: the task-detail form, New Task,
 * and New Backlog Task all hold slightly different records (saved vs pending),
 * and each previously carried its own near-identical copy of this markup.
 */
export interface AttachmentChipItem {
  id: string;
  filename: string;
  media_type: string;
  previewUrl?: string;
}

/** Generic over the caller's own row type so each dialog keeps its richer
 *  record (saved vs pending) in the callbacks without casting at the call site. */
interface AttachmentChipStripProps<TAttachment extends AttachmentChipItem> {
  attachments: TAttachment[];
  /** Open/preview the attachment. Callers decide image-preview vs open-externally. */
  onOpen: (attachment: TAttachment) => void;
  /** Omit to render read-only (no remove control), e.g. the saved read view. */
  onRemove?: (id: string) => void;
  /** Defaults to the grid's old `attachment-thumbnails` id on purpose, so the
   *  existing specs keep addressing the strip as a whole; the per-file id is
   *  `attachment-chip`. */
  testId?: string;
}

/**
 * Compact one-row attachment strip.
 *
 * Replaces a 96px thumbnail grid that cost roughly 140px of vertical space for
 * a single file - real estate the description editor needs far more. Each chip
 * still carries a 20px image preview, because pasted screenshots are all named
 * `pasted-image-1/2/3.png` and would be indistinguishable from the filename
 * alone. There is deliberately no "N attachments" caption: the chips are
 * individually visible and countable, so a caption only repeats what the row
 * already shows. The remove control is always visible rather than
 * hover-revealed (see `.claude/rules/ui-conventions.md`).
 */
export function AttachmentChipStrip<TAttachment extends AttachmentChipItem>({
  attachments,
  onOpen,
  onRemove,
  testId = 'attachment-thumbnails',
}: AttachmentChipStripProps<TAttachment>) {
  if (attachments.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid={testId}>
      {attachments.map((attachment) => {
        const isImage = isImageMediaType(attachment.media_type);
        const FileTypeIcon = getFileTypeIcon(attachment.media_type);

        return (
          <span
            key={attachment.id}
            className="inline-flex max-w-[220px] items-center gap-1.5 rounded border border-edge-input bg-surface-input py-0.5 pl-1 pr-0.5 text-[11px] text-fg-tertiary"
            data-testid="attachment-chip"
          >
            <button
              type="button"
              onClick={() => onOpen(attachment)}
              className="flex min-w-0 items-center gap-1.5 rounded-sm text-left hover:text-fg"
              title={attachment.filename}
              data-testid="attachment-open"
            >
              {isImage && attachment.previewUrl ? (
                <img
                  src={attachment.previewUrl}
                  alt={attachment.filename}
                  className="h-5 w-5 flex-shrink-0 rounded-sm object-cover"
                />
              ) : (
                <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-sm bg-surface-secondary">
                  <FileTypeIcon size={12} className="text-fg-muted" />
                </span>
              )}
              <span className="truncate">{attachment.filename}</span>
            </button>
            {onRemove && (
              <button
                type="button"
                onClick={() => onRemove(attachment.id)}
                className="flex-shrink-0 rounded p-0.5 text-fg-muted transition-colors hover:bg-surface-hover hover:text-fg"
                title={`Remove ${attachment.filename}`}
                aria-label={`Remove ${attachment.filename}`}
                data-testid="attachment-remove"
              >
                <X size={12} />
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}

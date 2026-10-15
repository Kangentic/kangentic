import { Crosshair, Pencil, X } from 'lucide-react';
import type { BrowserPickedElement } from '../../../shared/types';

interface AttachmentChipsProps {
  strokeCount: number;
  pickedElement: BrowserPickedElement | null;
  onClearStrokes: () => void;
  onClearPicked: () => void;
}

/**
 * Strip of attachment chips above the note input. Shows what's queued
 * for the next Send so the user can review and remove individual
 * attachments before submitting.
 *
 * Renders nothing when nothing is queued.
 */
export function AttachmentChips({
  strokeCount,
  pickedElement,
  onClearStrokes,
  onClearPicked,
}: AttachmentChipsProps) {
  const hasContent = strokeCount > 0 || pickedElement !== null;
  if (!hasContent) return null;

  return (
    <div
      className="flex items-center gap-1.5 px-2 py-1.5 border-t border-edge flex-shrink-0 flex-wrap bg-accent/5"
      data-testid="browser-attachment-chips"
    >
      <span className="text-[11px] text-fg-faint mr-0.5">Will send:</span>
      {strokeCount > 0 && (
        <Chip
          icon={<Pencil size={11} />}
          label={`${strokeCount} stroke${strokeCount === 1 ? '' : 's'}`}
          onRemove={onClearStrokes}
          testId="chip-strokes"
        />
      )}
      {pickedElement && (
        <Chip
          icon={<Crosshair size={11} />}
          label={pickedElementLabel(pickedElement)}
          title={pickedElement.selector}
          onRemove={onClearPicked}
          testId="chip-picked"
        />
      )}
    </div>
  );
}

function pickedElementLabel(element: BrowserPickedElement): string {
  // Prefer the most specific identifier the agent can actually grep
  // the codebase with: testid > id > role+name > selector tail.
  if (element.testId) return `[data-testid="${truncate(element.testId, 28)}"]`;
  if (element.id) return `#${truncate(element.id, 28)}`;
  if (element.role && element.accessibleName) {
    return `${element.role} "${truncate(element.accessibleName, 22)}"`;
  }
  if (element.role) return element.role;
  // Fallback: last segment of the selector path
  const tail = element.selector.split(' > ').pop() ?? element.selector;
  return truncate(tail, 32);
}

function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

interface ChipProps {
  icon: React.ReactNode;
  label: string;
  title?: string;
  onRemove: () => void;
  testId?: string;
}

function Chip({ icon, label, title, onRemove, testId }: ChipProps) {
  return (
    <span
      className="inline-flex items-center gap-1 pl-1.5 pr-0.5 py-0.5 rounded border border-edge-input bg-surface-input text-[11px] text-fg-tertiary max-w-[260px]"
      title={title}
      data-testid={testId}
    >
      <span className="text-fg-muted flex-shrink-0">{icon}</span>
      <span className="font-mono truncate min-w-0">{label}</span>
      <button
        type="button"
        onClick={onRemove}
        className="flex-shrink-0 p-0.5 rounded hover:bg-surface-hover text-fg-muted hover:text-fg transition-colors"
        aria-label="Remove from queue"
        title="Remove from queue"
      >
        <X size={11} />
      </button>
    </span>
  );
}

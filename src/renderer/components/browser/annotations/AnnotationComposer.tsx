import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, Loader2, Pencil, Send, SquareMousePointer, Trash2, X } from 'lucide-react';
import { plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import { CountBadge } from '../../CountBadge';
import { OverlayPopover } from '../../OverlayPopover';
import { Tooltip } from '../../Tooltip';
import { usePopoverPosition } from '../../../hooks/usePopoverPosition';
import { tipLabel } from '../../../utils/tooltip';
import type { BrowserAnnotationItem } from '../../../../shared/types';
import type { AnnotationRowView } from './useBrowserAnnotations';

// The annotations composer: it replaces the single note row once something is
// marked. A header that folds the list, one row per annotation (its number,
// its note, what it holds, and its X), a dashed row that starts the next one,
// and a bottom row with Clear and Send that never moves. Decision 45 in
// docs/architecture/embedded-browser/decision-log.md has the reasoning.

/** Four rows and their padding: the tallest the list grows before it scrolls. */
export const ROWS_MAX_HEIGHT = 148;
/** One row and its padding: the least the list shows, so the active note is always there. */
const ROWS_MIN_HEIGHT = 42;
/** The pane chrome around the list: the URL bar (41), the header (30) and the bottom row (51). */
const PANE_CHROME_HEIGHT = 122;

/**
 * How tall the annotation list may grow in a pane this tall. The page keeps
 * at least 120px or 40% of the pane, whichever is more; the list gives way
 * first, down to one row. Measured at the 900x600 window floor the pane is
 * about 275px, where four rows would have left the page under 80px.
 */
export function annotationRowsMaxHeight(paneHeight: number): number {
  if (paneHeight <= 0) return ROWS_MAX_HEIGHT;
  const pageFloor = Math.max(120, paneHeight * 0.4);
  const room = paneHeight - PANE_CHROME_HEIGHT - pageFloor;
  return Math.round(Math.max(ROWS_MIN_HEIGHT, Math.min(ROWS_MAX_HEIGHT, room)));
}

/** The attribute every annotation note carries, so the pane's keys can tell one from any other field. */
export const ANNOTATION_NOTE_ATTRIBUTE = 'data-annotation-note';

interface AnnotationComposerProps {
  rows: AnnotationRowView[];
  canStartNext: boolean;
  atCap: boolean;
  /** A mode (Select element or Draw) is on: folded, the active row still shows. */
  modeActive: boolean;
  /** How tall the list may grow before it scrolls (`annotationRowsMaxHeight`). */
  rowsMaxHeight: number;
  sending: boolean;
  sendableCount: number;
  onSelect: (annotationId: string) => void;
  onNoteChange: (annotationId: string, note: string) => void;
  onNext: () => void;
  onRemove: (annotationId: string) => void;
  onRemoveItem: (annotationId: string, itemId: string) => void;
  onHoverAnnotation: (annotationId: string | null) => void;
  onHoverItem: (itemId: string | null) => void;
  onClear: () => void;
  onSend: () => void;
  /** The active note just took focus (a push-to-talk hold may follow it there). */
  onActiveNoteFocused: (input: HTMLInputElement) => void;
}

/** "localhost:5173/billing": where an annotation was made, short enough for a tip. */
function pageLabel(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname === '/' ? '' : parsed.pathname}`;
  } catch {
    return url;
  }
}

export function AnnotationComposer({
  rows,
  canStartNext,
  atCap,
  modeActive,
  rowsMaxHeight,
  sending,
  sendableCount,
  onSelect,
  onNoteChange,
  onNext,
  onRemove,
  onRemoveItem,
  onHoverAnnotation,
  onHoverItem,
  onClear,
  onSend,
  onActiveNoteFocused,
}: AnnotationComposerProps) {
  const { t } = useLingui();
  const [open, setOpen] = useState(true);
  const noteRefs = useRef(new Map<string, HTMLInputElement>());
  const activeRow = rows.find((row) => row.active) ?? null;
  const activeId = activeRow?.id ?? null;

  // The active note takes the cursor whenever another annotation becomes
  // active (a row click, a page badge, the dashed row, Enter), so typing and
  // dictation land in the annotation the marks are going into. Only while the
  // user is already working in this pane: a saved draft coming back when the
  // pane opens, which an agent's open_pane can do, never takes focus from
  // where the user is (.claude/rules/agent-driven-focus.md).
  useEffect(() => {
    if (!activeId) return;
    const input = noteRefs.current.get(activeId);
    if (!input) return;
    const pane = input.closest('[data-testid="browser-pane"]');
    if (!pane || !pane.contains(document.activeElement)) return;
    if (document.activeElement !== input) input.focus({ preventScroll: true });
    onActiveNoteFocused(input);
  }, [activeId, onActiveNoteFocused]);

  const visibleRows = open ? rows : (modeActive && activeRow ? [activeRow] : []);
  const nextNumber = rows.length + 1;
  const count = rows.filter((row) => row.note.trim() !== '' || row.items.length > 0).length;
  const capTip = t`20 annotations is the most one send carries. Send these, then start again.`;

  return (
    <div className="flex flex-col flex-shrink-0 border-t border-edge bg-surface" data-testid="annotation-composer">
      <Tooltip label={atCap ? capTip : ''}>
        <button
          type="button"
          onClick={() => setOpen((previous) => !previous)}
          className="flex items-center gap-1.5 h-[30px] px-3 text-xs font-semibold text-fg-muted hover:text-fg border-b border-edge"
          aria-expanded={open}
          data-testid="annotation-header"
        >
          {open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
          <Trans>Annotations</Trans>
          <CountBadge count={count} variant="tinted" size="pill" className="text-fg-muted" testId="annotation-count" />
        </button>
      </Tooltip>

      {visibleRows.length > 0 && (
        <div
          className="flex flex-col gap-1 px-2 py-1.5 overflow-y-auto"
          style={{ maxHeight: rowsMaxHeight }}
          data-testid="annotation-rows"
          data-compact={rowsMaxHeight < ROWS_MAX_HEIGHT ? 'true' : 'false'}
        >
          {visibleRows.map((row) => (
            <AnnotationRow
              key={row.id}
              row={row}
              noteRef={(element) => {
                if (element) noteRefs.current.set(row.id, element);
                else noteRefs.current.delete(row.id);
              }}
              canStartNext={canStartNext}
              onSelect={onSelect}
              onNoteChange={onNoteChange}
              onNext={onNext}
              onRemove={onRemove}
              onRemoveItem={onRemoveItem}
              onHoverAnnotation={onHoverAnnotation}
              onHoverItem={onHoverItem}
              madeOn={pageLabel(row.url)}
            />
          ))}
          {open && canStartNext && (
            <Tooltip label={t`Start the next annotation. Enter in a note does the same.`}>
              <button
                type="button"
                onClick={onNext}
                className="flex items-center gap-2 h-[30px] flex-shrink-0 px-2 rounded-md border border-dashed border-edge-input text-xs text-fg-muted hover:text-fg hover:border-fg-faint"
                data-testid="annotation-new"
              >
                <span className="inline-flex items-center justify-center w-[18px] h-[18px] rounded-[3px] border border-dashed border-fg-faint text-[11px] font-bold">
                  {nextNumber}
                </span>
                <span className="pl-2"><Trans>New annotation</Trans></span>
              </button>
            </Tooltip>
          )}
        </div>
      )}

      <div className="flex items-center justify-end gap-2 px-2 py-2 border-t border-edge">
        <button
          type="button"
          onClick={onClear}
          disabled={sending}
          className="flex items-center gap-1.5 h-[34px] px-3 rounded border border-edge-input text-[13px] text-fg-muted hover:text-fg hover:bg-surface-hover disabled:opacity-50"
          data-testid="annotation-clear"
        >
          <Trash2 size={13} />
          <Trans context="Action">Clear</Trans>
        </button>
        <Tooltip
          label={tipLabel({
            disabled: !sending && sendableCount === 0,
            disabledReason: t`Add a note or a mark to send`,
            tip: t`Send every annotation`,
          })}
          keys={sendableCount > 0 ? 'browser.sendAnnotations' : undefined}
        >
          <button
            type="button"
            onClick={onSend}
            disabled={sending || sendableCount === 0}
            className="flex items-center justify-center gap-1.5 h-[34px] min-w-[104px] px-[18px] rounded bg-accent-emphasis hover:bg-accent text-[13px] font-semibold text-accent-on disabled:opacity-50"
            data-testid="browser-send"
          >
            {sending ? <Loader2 size={13} className="animate-spin" /> : <Send size={13} />}
            <Trans>Send</Trans>
          </button>
        </Tooltip>
      </div>
    </div>
  );
}

interface AnnotationRowProps {
  row: AnnotationRowView;
  noteRef: (element: HTMLInputElement | null) => void;
  canStartNext: boolean;
  /** Where the annotation was made, for the "Not on page" tip. */
  madeOn: string;
  onSelect: (annotationId: string) => void;
  onNoteChange: (annotationId: string, note: string) => void;
  onNext: () => void;
  onRemove: (annotationId: string) => void;
  onRemoveItem: (annotationId: string, itemId: string) => void;
  onHoverAnnotation: (annotationId: string | null) => void;
  onHoverItem: (itemId: string | null) => void;
}

function AnnotationRow({
  row,
  noteRef,
  canStartNext,
  madeOn,
  onSelect,
  onNoteChange,
  onNext,
  onRemove,
  onRemoveItem,
  onHoverAnnotation,
  onHoverItem,
}: AnnotationRowProps) {
  const { t } = useLingui();
  const number = row.number;
  const badgeClass = !row.onPage
    ? 'border border-edge-input text-fg-muted'
    : row.active
      ? 'bg-accent-emphasis text-accent-on'
      : 'bg-surface-hover text-fg group-hover:bg-fg-faint group-hover:text-surface';
  return (
    <div
      className="group flex items-center gap-2 h-[30px] flex-shrink-0 px-2 rounded-md bg-surface-raised"
      onMouseEnter={() => onHoverAnnotation(row.id)}
      onMouseLeave={() => onHoverAnnotation(null)}
      data-testid={`annotation-row-${number}`}
      data-active={row.active ? 'true' : 'false'}
      data-on-page={row.onPage ? 'true' : 'false'}
    >
      <button
        type="button"
        onClick={() => onSelect(row.id)}
        className={`inline-flex items-center justify-center w-[18px] h-[18px] flex-shrink-0 rounded-[3px] text-[11px] font-bold ${badgeClass}`}
        aria-label={t`Annotation ${number}`}
        data-testid={`annotation-number-${number}`}
      >
        {number}
      </button>
      <input
        ref={noteRef}
        type="text"
        value={row.note}
        onFocus={() => onSelect(row.id)}
        onChange={(event) => onNoteChange(row.id, event.target.value)}
        onKeyDown={(event) => {
          // Enter starts the next annotation; Ctrl/Cmd+Enter (the pane's Send
          // key) is the keybinding's. Composition keeps its own Enter.
          if (event.key !== 'Enter' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return;
          if (event.nativeEvent.isComposing || event.defaultPrevented) return;
          event.preventDefault();
          if (canStartNext) onNext();
        }}
        placeholder={row.active ? t`What should change here?` : ''}
        spellCheck
        className={`flex-1 min-w-0 h-6 px-2 rounded text-xs focus:outline-none ${
          row.active
            ? 'bg-surface-input border border-accent/60 text-fg'
            : 'bg-transparent border border-transparent text-fg'
        } ${row.onPage ? '' : 'text-fg-muted'}`}
        aria-label={t`Note for annotation ${number}`}
        {...{ [ANNOTATION_NOTE_ATTRIBUTE]: '' }}
        data-testid={`annotation-note-${number}`}
      />
      {!row.onPage && (
        <Tooltip label={t`Made on ${madeOn}. Still sent, with the capture taken there.`}>
          <span className="flex-shrink-0 text-xs text-fg-muted" data-testid={`annotation-not-on-page-${number}`}>
            <Trans>Not on page</Trans>
          </span>
        </Tooltip>
      )}
      {row.items.length > 0 && (
        <AnnotationItemList
          number={number}
          items={row.items}
          onRemoveItem={(itemId) => onRemoveItem(row.id, itemId)}
          onHoverItem={onHoverItem}
        />
      )}
      <Tooltip label={t`Remove this annotation`}>
        <button
          type="button"
          onClick={() => onRemove(row.id)}
          className="flex-shrink-0 p-[3px] rounded text-fg-muted hover:text-fg hover:bg-surface-hover"
          aria-label={t`Remove annotation ${number}`}
          data-testid={`annotation-remove-${number}`}
        >
          <X size={12} />
        </button>
      </Tooltip>
    </div>
  );
}

interface AnnotationItemListProps {
  number: number;
  items: BrowserAnnotationItem[];
  onRemoveItem: (itemId: string) => void;
  onHoverItem: (itemId: string | null) => void;
}

/**
 * The row's summary: an icon and a count per kind. It is a button that opens
 * the annotation's items, one line each with its own X, so one item can go
 * while the rest stay (2g). Hovering a line shows that item alone on the page.
 */
function AnnotationItemList({ number, items, onRemoveItem, onHoverItem }: AnnotationItemListProps) {
  const { t } = useLingui();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const { style, placement } = usePopoverPosition(triggerRef, menuRef, open, {
    mode: 'dropdown',
    strategy: 'fixed',
    preferVertical: 'above',
  });
  const elementCount = items.filter((item) => item.kind === 'element').length;
  const drawingCount = items.length - elementCount;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    // An open menu takes Escape before the task window does.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown, true);
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown, true);
      document.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  useEffect(() => {
    if (!open) onHoverItem(null);
  }, [open, onHoverItem]);

  const describe = (item: BrowserAnnotationItem): string => {
    if (item.kind === 'drawing') {
      const strokeCount = item.strokes.length;
      return plural(strokeCount, { one: 'Drawing, # stroke', other: 'Drawing, # strokes' });
    }
    const element = item.element;
    const kind = element.role || element.tagName.toLowerCase();
    const name = (element.accessibleName || '').trim();
    const shortName = name.length > 40 ? `${name.slice(0, 40)}...` : name;
    return shortName ? `${kind} "${shortName}"` : kind;
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        className="flex flex-shrink-0 items-center gap-1 h-6 px-1.5 rounded bg-surface-hover/60 text-xs text-fg-muted hover:text-fg hover:bg-surface-hover"
        aria-label={t`What annotation ${number} holds`}
        aria-expanded={open}
        data-testid={`annotation-items-${number}`}
      >
        {elementCount > 0 && (
          <span className="flex items-center gap-0.5"><SquareMousePointer size={13} />{elementCount}</span>
        )}
        {drawingCount > 0 && (
          <span className="flex items-center gap-0.5"><Pencil size={13} />{drawingCount}</span>
        )}
        <ChevronDown size={12} />
      </button>
      <OverlayPopover
        open={open}
        popoverRef={menuRef}
        style={style}
        portal
        transformOrigin={placement.vertical === 'above' ? 'bottom center' : 'top center'}
        className="fixed z-[2147483646] min-w-[220px] max-w-[320px] max-h-[min(280px,var(--popover-available-height,280px))] overflow-y-auto rounded-md border border-edge bg-surface-raised p-1 shadow-lg"
        role="menu"
        data-testid={`annotation-item-list-${number}`}
      >
        {items.map((item) => {
          const itemLabel = describe(item);
          return (
          <div
            key={item.id}
            className="flex items-center gap-2 h-7 px-2 rounded text-xs text-fg hover:bg-surface-hover"
            onMouseEnter={() => onHoverItem(item.id)}
            onMouseLeave={() => onHoverItem(null)}
            data-testid={`annotation-item-${item.id}`}
          >
            {item.kind === 'element' ? <SquareMousePointer size={13} className="text-fg-muted" /> : <Pencil size={13} className="text-fg-muted" />}
            <span className="flex-1 min-w-0 truncate">{itemLabel}</span>
            <button
              type="button"
              onClick={() => onRemoveItem(item.id)}
              className="p-[3px] rounded text-fg-muted hover:text-fg hover:bg-surface"
              aria-label={t`Remove ${itemLabel}`}
              data-testid={`annotation-item-remove-${item.id}`}
            >
              <X size={12} />
            </button>
          </div>
          );
        })}
      </OverlayPopover>
    </>
  );
}

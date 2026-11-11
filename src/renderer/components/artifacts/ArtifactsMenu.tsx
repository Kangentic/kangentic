import { useCallback, useEffect, useRef, type KeyboardEvent, type RefObject, type SyntheticEvent } from 'react';
import { Pencil } from 'lucide-react';
import { Trans } from '@lingui/react/macro';
import { usePopoverPosition } from '../../hooks/usePopoverPosition';
import type { LinkOpener } from '../../hooks/useLinkOpener';
import { OverlayPopover } from '../OverlayPopover';
import { Tooltip } from '../Tooltip';
import { ArtifactPlatformLogo } from '../VendorMark';
import type { ArtifactListItem } from '../../../shared/task-artifacts';

interface ArtifactsMenuProps {
  open: boolean;
  onClose: () => void;
  /** The control the menu hangs from: positions it, and takes focus back when a key closes it. */
  anchorRef: RefObject<HTMLElement | null>;
  items: readonly ArtifactListItem[];
  opener: LinkOpener;
  /** Opens the task's edit form at Artifacts. Absent where the task cannot be edited. */
  onEdit?: () => void;
  testId: string;
}

/**
 * One artifact row's grid: the tool's mark, the name, the tool. Shared with the
 * task window's actions menu, whose Artifacts flyout draws the same row
 * (`ArtifactsKebabItems`).
 */
export const ARTIFACT_ROW_LAYOUT_CLASS = 'grid w-full grid-cols-[14px_minmax(0,1fr)_auto] items-center gap-2 px-3 py-1.5 text-left text-xs text-fg-tertiary transition-colors hover:bg-surface-hover hover:text-fg';

const ROW_CLASS = `${ARTIFACT_ROW_LAYOUT_CLASS} focus:outline-none focus-visible:bg-surface-hover focus-visible:text-fg focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent`;

/** What an artifact row holds, in the menu and in the actions menu's flyout. */
export function ArtifactRowContent({ item }: { item: ArtifactListItem }) {
  return (
    <>
      <span className="flex text-fg-muted"><ArtifactPlatformLogo platformId={item.platformId} size={14} /></span>
      <span className="truncate">{item.name}</span>
      <span className="whitespace-nowrap text-[11px] text-fg-faint">{item.tool}</span>
    </>
  );
}

/**
 * A task's artifacts as a menu (#1056): one row each, in the order added, with
 * the tool's own mark, the artifact's name and the tool in muted text. Built
 * like the task window's actions menu: the same surface, border, 12px rows and
 * hover.
 *
 * A click on a row opens it where the "Click opens links in" setting says and
 * Ctrl or Cmd click in the other browser, and Enter and Ctrl+Enter do the same
 * from the keyboard, since a key's click carries its modifiers. Arrow keys move
 * between rows. Escape closes the menu and not the window behind it.
 *
 * It portals to the body with fixed positioning, so a card at the board's edge
 * never clips it (`popover-escapes-clipping.md`). React still bubbles its events
 * to the control that opened it, which on a board card is the card: the menu's
 * own wrapper stops them, or a click on a row would open the task and a press
 * would start a drag.
 */
export function ArtifactsMenu({ open, onClose, anchorRef, items, opener, onEdit, testId }: ArtifactsMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const { style, placement } = usePopoverPosition(anchorRef, menuRef, open, { mode: 'dropdown', strategy: 'fixed' });

  // Outside click: the menu is portaled out of the anchor's subtree, so both refs count as inside.
  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (anchorRef.current?.contains(target) || menuRef.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('mousedown', handleMouseDown, true);
    return () => document.removeEventListener('mousedown', handleMouseDown, true);
  }, [open, onClose, anchorRef]);

  // The anchor wraps the control: a key that closes the menu hands the keyboard
  // back to the control itself, or focus is left on a row that is gone.
  const focusAnchor = useCallback(() => {
    const anchor = anchorRef.current;
    (anchor?.matches('button') ? anchor : anchor?.querySelector<HTMLElement>('button'))?.focus();
  }, [anchorRef]);

  // Escape closes the MENU, not the task window or the dialog behind it. An
  // open menu is the in-gesture shape `keybindings-registry.md` lists: a
  // capture-phase listener, registered only while open.
  useEffect(() => {
    if (!open) return;
    const handleEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      onClose();
      focusAnchor();
    };
    document.addEventListener('keydown', handleEscape, true);
    return () => document.removeEventListener('keydown', handleEscape, true);
  }, [open, onClose, focusAnchor]);

  // Opened from the keyboard or the mouse, the first row takes focus, so the arrows work at once.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const moveFocus = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Home' && event.key !== 'End') return;
    const rows = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    if (rows.length === 0) return;
    event.preventDefault();
    const lastIndex = rows.length - 1;
    // -1 when focus is in the menu but on no row (its scrollbar).
    const currentIndex = rows.indexOf(document.activeElement as HTMLElement);
    let nextIndex: number;
    if (event.key === 'Home') nextIndex = 0;
    else if (event.key === 'End') nextIndex = lastIndex;
    else if (event.key === 'ArrowDown') nextIndex = currentIndex >= lastIndex ? 0 : currentIndex + 1;
    // Up from the first row, or from no row, is the last one.
    else nextIndex = currentIndex <= 0 ? lastIndex : currentIndex - 1;
    rows[nextIndex].focus();
  };

  const stop = (event: SyntheticEvent) => event.stopPropagation();

  return (
    <OverlayPopover
      open={open}
      popoverRef={menuRef}
      style={style}
      portal
      role="menu"
      transformOrigin={placement.vertical === 'above' ? 'bottom center' : 'top center'}
      className="fixed z-[2147483646] flex w-[300px] max-w-[calc(100vw-16px)] flex-col rounded-md border border-edge-input bg-surface-raised py-1 shadow-xl"
      data-testid={testId}
    >
      {/* Stops the menu's events at the menu: see the component note. */}
      <div
        className="flex min-h-0 flex-col"
        onClick={stop}
        onMouseDown={stop}
        onPointerDown={stop}
        onDoubleClick={stop}
        onContextMenu={stop}
        onKeyDown={(event) => { moveFocus(event); event.stopPropagation(); }}
      >
        {/* Eight rows, then it scrolls, and never past the room the window leaves. */}
        <div className="flex max-h-[min(256px,var(--popover-available-height,256px))] flex-col overflow-y-auto">
          {items.map((item) => (
            <Tooltip
              key={item.artifact.url}
              label={`${item.name}, ${item.tool}`}
              destination={item.artifact.url}
              rows={opener.rows}
              describe={false}
            >
              <button
                type="button"
                role="menuitem"
                className={ROW_CLASS}
                onClick={(event) => {
                  opener.open(item.artifact.url, event);
                  onClose();
                  // Enter on a row is a click with no pointer behind it.
                  if (event.detail === 0) focusAnchor();
                }}
                data-testid={`${testId}-row`}
                data-artifact-url={item.artifact.url}
                data-artifact-platform={item.platformId ?? ''}
              >
                <ArtifactRowContent item={item} />
              </button>
            </Tooltip>
          ))}
        </div>
        {onEdit && (
          <>
            <div className="mx-2 my-1 border-t border-edge-input/50" />
            <button
              type="button"
              role="menuitem"
              className={ROW_CLASS}
              onClick={() => {
                onClose();
                onEdit();
              }}
              data-testid={`${testId}-edit`}
            >
              <span className="flex text-fg-muted"><Pencil size={14} /></span>
              <span><Trans>Edit artifacts</Trans></span>
            </button>
          </>
        )}
      </div>
    </OverlayPopover>
  );
}

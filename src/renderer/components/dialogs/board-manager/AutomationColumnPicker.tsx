/**
 * Move to column's Column field: a select that shows each column's COLOR dot
 * beside its name, the way the board's own column headers carry it.
 *
 * A native `<select>` cannot, for the reason `AutomationTypePicker` gives: an
 * `<option>` holds text and nothing else. This is that picker's shape (a
 * button-backed listbox, portaled and `position: fixed` per
 * `popover-escapes-clipping.md`), because it opens in the same nested dialog
 * whose body scrolls.
 *
 * The value is a column NAME, with Next column (empty) first. A name the board
 * no longer has stays listed and marked "(not on this board)", so opening the
 * dialog never silently re-points the row. Neither of those two carries a dot:
 * Next column is not one column, and a missing column has no color.
 */
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { OverlayPopover } from '../../OverlayPopover';
import { usePopoverPosition } from '../../../hooks/usePopoverPosition';

/** One column the field can point at. `color` is null for one the board store has not seen yet. */
export interface AutomationColumnChoice {
  name: string;
  color: string | null;
}

export interface AutomationColumnPickerProps {
  /** A column name, or '' for Next column. */
  value: string;
  /** The board's other columns, in board order. */
  columns: readonly AutomationColumnChoice[];
  onChange: (value: string) => void;
  testId: string;
  ariaLabel: string;
}

const NEXT_COLUMN_LABEL = 'Next column';

interface ListedChoice {
  value: string;
  label: string;
  color: string | null;
}

export function AutomationColumnPicker({ value, columns, onChange, testId, ariaLabel }: AutomationColumnPickerProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Set when the keyboard opened the menu, so focus moves onto the chosen
  // option once it mounts. A click leaves focus on the trigger, as a native
  // select does.
  const focusOptionOnOpenRef = useRef(false);
  const { style, placement } = usePopoverPosition(triggerRef, menuRef, open, {
    mode: 'dropdown',
    strategy: 'fixed',
    // Under the field, aligned to its left edge and as wide as it, like the
    // native select it replaces.
    preferRight: false,
    matchTriggerWidth: true,
  });

  // Both refs, because the menu is portaled OUT of the trigger's subtree: a
  // click inside it would otherwise read as "outside" and dismiss the menu
  // before the option's own click ran.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown, true);
    return () => document.removeEventListener('mousedown', onPointerDown, true);
  }, [open]);

  // Escape closes the menu, not the dialog under it, wherever focus sits: on
  // the trigger or on an option in the portaled menu. Capture phase on the
  // document, registered only while open, ahead of `BaseDialog`'s bubble-phase
  // Escape (the open-menu shape in `keybindings-registry.md`).
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open]);

  // The options are portaled to the end of the body, so Tab never reaches
  // them from the trigger: the keyboard gets there by this focus, and moves
  // between them with the arrows (`moveFocus`). Queried through `menuRef`,
  // since the menu is not inside the trigger's subtree.
  useEffect(() => {
    if (!open || !focusOptionOnOpenRef.current) return;
    focusOptionOnOpenRef.current = false;
    const menu = menuRef.current;
    const target = menu?.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]')
      ?? menu?.querySelector<HTMLButtonElement>('[role="option"]');
    // A plain focus, so a long list scrolls the menu to it. The menu is
    // `fixed`, so nothing behind it scrolls.
    target?.focus();
  }, [open]);

  const moveFocus = (current: HTMLButtonElement, step: 1 | -1): void => {
    const options = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
    options[options.indexOf(current) + step]?.focus();
  };

  const listed: ListedChoice[] = [
    { value: '', label: NEXT_COLUMN_LABEL, color: null },
    ...columns.map((column) => ({ value: column.name, label: column.name, color: column.color })),
  ];
  if (value !== '' && !columns.some((column) => column.name === value)) {
    listed.push({ value, label: `${value} (not on this board)`, color: null });
  }
  const selected = listed.find((choice) => choice.value === value) ?? listed[0];

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        data-testid={testId}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        data-value={value}
        onClick={() => setOpen((current) => !current)}
        onKeyDown={(event) => {
          if (event.key !== 'ArrowDown') return;
          event.preventDefault();
          if (open) {
            const menu = menuRef.current;
            (menu?.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]')
              ?? menu?.querySelector<HTMLButtonElement>('[role="option"]'))?.focus();
            return;
          }
          focusOptionOnOpenRef.current = true;
          setOpen(true);
        }}
        // The shared field fill, so this reads as the same control family as
        // the Type picker beside it.
        className="flex w-full cursor-pointer items-center gap-2 rounded border border-edge-input bg-surface-control px-3 py-1.5 text-left text-sm text-fg-tertiary focus:border-accent focus:outline-none"
      >
        {selected.color && <ColumnDot color={selected.color} />}
        <span className="min-w-0 flex-1 truncate">{selected.label}</span>
        <ChevronDown size={14} className="shrink-0 text-fg-muted" />
      </button>

      {/* Mounted only while open, as the Type picker is, for the reason its
          comment gives: OverlayPopover's exit never reaches `onClose()` here. */}
      {open && (
        <OverlayPopover
          open
          popoverRef={menuRef}
          style={style}
          portal
          transformOrigin={placement.vertical === 'above' ? 'bottom center' : 'top center'}
          className="fixed z-[2147483646] max-h-72 overflow-y-auto rounded-lg border border-edge bg-surface-raised py-1 shadow-xl"
          data-testid={`${testId}-menu`}
        >
          <div role="listbox" aria-label={ariaLabel}>
            {listed.map((choice) => {
              const isSelected = choice.value === value;
              return (
                <button
                  key={choice.value === '' ? '(next)' : choice.value}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  data-testid={`${testId}-option`}
                  data-value={choice.value}
                  onClick={() => { onChange(choice.value); setOpen(false); triggerRef.current?.focus(); }}
                  onKeyDown={(event) => {
                    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                      event.preventDefault();
                      moveFocus(event.currentTarget, event.key === 'ArrowDown' ? 1 : -1);
                    }
                  }}
                  className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-hover"
                >
                  {/* A fixed slot, so every name starts on one edge whether or not it has a dot. */}
                  <span className="flex w-2 shrink-0 justify-center" aria-hidden="true">
                    {choice.color && <ColumnDot color={choice.color} />}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-fg">{choice.label}</span>
                  {isSelected && <Check size={14} className="shrink-0 text-accent" />}
                </button>
              );
            })}
          </div>
        </OverlayPopover>
      )}
    </div>
  );
}

/** The column's own color, as the board header draws it. A user's color is data, so it is a style, not a class. */
function ColumnDot({ color }: { color: string }) {
  return (
    <span
      data-testid="automation-column-dot"
      aria-hidden="true"
      className="h-2 w-2 shrink-0 rounded-full"
      style={{ backgroundColor: color }}
    />
  );
}

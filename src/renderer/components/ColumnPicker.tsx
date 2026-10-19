/**
 * The one column picker: every field that chooses a board column (the Column
 * Manager's After Plan Mode, Move to column's Column) shows each column's own
 * glyph in its own color, the way the board's column headers and the Column
 * Manager's rail draw it (`ColumnGlyph`: its icon, else a dot in its color).
 *
 * A native `<select>` cannot: an `<option>` holds text and nothing else. So this
 * is a button-backed listbox, portaled and `position: fixed` per
 * `popover-escapes-clipping.md`, since both fields sit in dialogs whose bodies
 * scroll and clip.
 *
 * A caller may put one option ahead of the columns (`leadingOption`), drawn
 * apart from them: a muted arrow instead of a column's colors, and a divider
 * under it, because it is not one column (Move to column's Next column). A
 * value no column carries stays listed and marked "(not on this board)", with
 * no glyph, so opening a dialog never silently re-points what it stores.
 */
import { useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, ChevronDown } from 'lucide-react';
import type { Swimlane } from '../../shared/types';
import { OverlayPopover } from './OverlayPopover';
import { usePopoverPosition } from '../hooks/usePopoverPosition';
import { ColumnGlyph } from '../utils/swimlane-icons';

/** One column the field can point at. `color` is null for one the board store has not seen yet. */
export interface ColumnPickerChoice extends Pick<Swimlane, 'icon' | 'role'> {
  /** What the field stores: a column id or a column name, as the caller decides. */
  value: string;
  name: string;
  color: string | null;
}

export interface ColumnPickerProps {
  value: string;
  /** The columns, in board order. */
  columns: readonly ColumnPickerChoice[];
  onChange: (value: string) => void;
  /** An option listed before the columns and set apart from them. */
  leadingOption?: { value: string; label: string };
  testId: string;
  ariaLabel: string;
}

interface ListedChoice {
  value: string;
  label: string;
  kind: 'leading' | 'column' | 'missing';
  column: ColumnPickerChoice | null;
}

const GLYPH_SIZE = 14;

export function ColumnPicker({ value, columns, onChange, leadingOption, testId, ariaLabel }: ColumnPickerProps) {
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
  // since the menu is not inside the trigger's subtree. A plain focus, so a
  // long list scrolls the menu to it. The menu is `fixed`, so nothing behind
  // it scrolls.
  const focusSelectedOption = (): void => {
    const menu = menuRef.current;
    (menu?.querySelector<HTMLButtonElement>('[role="option"][aria-selected="true"]')
      ?? menu?.querySelector<HTMLButtonElement>('[role="option"]'))?.focus();
  };

  useEffect(() => {
    if (!open || !focusOptionOnOpenRef.current) return;
    focusOptionOnOpenRef.current = false;
    focusSelectedOption();
  }, [open]);

  const moveFocus = (current: HTMLButtonElement, step: 1 | -1): void => {
    const options = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
    options[options.indexOf(current) + step]?.focus();
  };

  const listed: ListedChoice[] = [
    ...(leadingOption ? [{ value: leadingOption.value, label: leadingOption.label, kind: 'leading' as const, column: null }] : []),
    ...columns.map((column) => ({ value: column.value, label: column.name, kind: 'column' as const, column })),
  ];
  if (!listed.some((choice) => choice.value === value)) {
    listed.push({ value, label: `${value} (not on this board)`, kind: 'missing', column: null });
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
            focusSelectedOption();
            return;
          }
          focusOptionOnOpenRef.current = true;
          setOpen(true);
        }}
        // The shared field fill, so this reads as the same control family as
        // the comboboxes beside it.
        className="flex w-full cursor-pointer items-center gap-2 rounded border border-edge-input bg-surface-control px-3 py-1.5 text-left text-sm text-fg-tertiary focus:border-accent focus:outline-none"
      >
        {selected && selected.kind !== 'missing' && <ChoiceGlyph choice={selected} />}
        <span className="min-w-0 flex-1 truncate">{selected?.label}</span>
        <ChevronDown size={14} className="shrink-0 text-fg-muted" />
      </button>

      {/* Mounted only while open: OverlayPopover's exit never reaches an onClose here. */}
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
            {listed.map((choice, index) => {
              const isSelected = choice.value === value;
              return (
                // The index too: Move to column values a column by NAME, and
                // two columns can share one.
                <div key={`${choice.kind}:${index}:${choice.value}`}>
                  <button
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
                    {/* A fixed slot, so every name starts on one edge, glyph or not. */}
                    <span className="flex shrink-0 justify-center" style={{ width: GLYPH_SIZE }} aria-hidden="true">
                      {choice.kind !== 'missing' && <ChoiceGlyph choice={choice} />}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-fg">{choice.label}</span>
                    {isSelected && <Check size={14} className="shrink-0 text-accent" />}
                  </button>
                  {choice.kind === 'leading' && <div data-testid={`${testId}-divider`} className="my-1 h-px bg-edge" aria-hidden="true" />}
                </div>
              );
            })}
          </div>
        </OverlayPopover>
      )}
    </div>
  );
}

/**
 * A column's glyph in its own color, or the leading option's muted arrow. A
 * user's color is data, so it is a style, not a class. `data-color` lets a test
 * read the color the field was handed.
 */
function ChoiceGlyph({ choice }: { choice: ListedChoice }) {
  if (choice.kind === 'leading' || !choice.column) {
    return (
      <span data-testid="column-picker-leading-glyph" aria-hidden="true" className="inline-flex shrink-0 text-fg-muted">
        <ArrowRight size={GLYPH_SIZE} />
      </span>
    );
  }
  return (
    <span
      data-testid="column-picker-glyph"
      data-color={choice.column.color ?? ''}
      aria-hidden="true"
      className="inline-flex shrink-0"
    >
      <ColumnGlyph column={choice.column} size={GLYPH_SIZE} color={choice.column.color} />
    </span>
  );
}

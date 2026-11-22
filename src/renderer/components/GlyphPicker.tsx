/**
 * A field that picks one of a short list of choices, each drawn with a glyph before
 * its name: the column picker (a column's glyph in its own color) and the priority
 * picker (a level's meter, #1160).
 *
 * A native `<select>` cannot: an `<option>` holds text and nothing else. So this is a
 * button-backed listbox, portaled and `position: fixed` per
 * `popover-escapes-clipping.md`, since every field that uses it sits in a dialog whose
 * body scrolls and clips. It behaves like the native select it replaces: a click opens
 * and leaves focus on the trigger, ArrowDown opens onto the chosen option, the arrows
 * move between options, Escape closes onto the trigger, and Tab closes rather than
 * leaving focus in a menu at the end of the body.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { OverlayPopover } from './OverlayPopover';
import { usePopoverPosition } from '../hooks/usePopoverPosition';

export interface GlyphPickerChoice {
  /** What the field stores. */
  value: string;
  label: string;
  /** Drawn before the name in its row, and in the field while chosen. Null draws none. */
  glyph: ReactNode;
  /** Draw a divider under this choice, to set it apart from the ones after it. */
  dividerAfter?: boolean;
}

export interface GlyphPickerProps {
  value: string;
  choices: readonly GlyphPickerChoice[];
  onChange: (value: string) => void;
  testId: string;
  ariaLabel: string;
  /** The width of each row's glyph slot, so every name starts on one edge, glyph or not. */
  glyphSlotWidth: number;
}

export function GlyphPicker({ value, choices, onChange, testId, ariaLabel, glyphSlotWidth }: GlyphPickerProps) {
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

  // Up from the first option goes back to the trigger, which ArrowDown leaves again.
  const moveFocus = (current: HTMLButtonElement, step: 1 | -1): void => {
    const options = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? []);
    const next = options[options.indexOf(current) + step];
    if (next) next.focus();
    else if (step === -1) triggerRef.current?.focus();
  };

  const selected = choices.find((choice) => choice.value === value) ?? choices[0];

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
        {selected?.glyph}
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
            {choices.map((choice, index) => {
              const isSelected = choice.value === value;
              return (
                // The index too: a caller may list two choices with one value
                // (Move to column values a column by NAME, and two columns can share one).
                <div key={`${index}:${choice.value}`}>
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
                      } else if (event.key === 'Tab') {
                        // The menu sits at the end of the body, so Tab would
                        // leave it open with focus outside the dialog: it
                        // closes onto its trigger instead.
                        event.preventDefault();
                        setOpen(false);
                        triggerRef.current?.focus();
                      }
                    }}
                    className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-sm hover:bg-surface-hover"
                  >
                    <span className="flex shrink-0 justify-center" style={{ width: glyphSlotWidth }} aria-hidden="true">
                      {choice.glyph}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-fg">{choice.label}</span>
                    {isSelected && <Check size={14} className="shrink-0 text-accent" />}
                  </button>
                  {choice.dividerAfter && <div data-testid={`${testId}-divider`} className="my-1 h-px bg-edge" aria-hidden="true" />}
                </div>
              );
            })}
          </div>
        </OverlayPopover>
      )}
    </div>
  );
}

/**
 * The automation Type field: a select that can show each type's ICON.
 *
 * A native `<select>` cannot. An `<option>` may contain text and nothing else,
 * so the one surface where the type is CHOSEN was the one surface with no
 * glyph, while the Add automation menu and the row itself both carry it. This
 * closes that gap rather than removing the icons from the other two.
 *
 * Not `Combobox`: that is a typeahead with a clear button and an inherit
 * placeholder, none of which a fixed four-item list wants. Not
 * `SegmentedControl` either, since the options are too wide to sit in a row.
 *
 * Portaled and `position: fixed`, per `popover-escapes-clipping.md`: this opens
 * inside a nested dialog whose body scrolls, and an in-flow menu would be
 * clipped to it.
 */
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { OverlayPopover } from '../../OverlayPopover';
import { usePopoverPosition } from '../../../hooks/usePopoverPosition';
import { AUTOMATION_MANIFEST } from '../../../../shared/automation-manifest';
import type { AutomationType } from '../../../../shared/types';
import { AutomationIcon } from './automation-icons';

export interface AutomationTypePickerProps {
  value: AutomationType;
  /** The types a user may pick. A legacy value shows but cannot be chosen. */
  options: readonly AutomationType[];
  onChange: (type: AutomationType) => void;
  testId: string;
  ariaLabel: string;
}

export function AutomationTypePicker({ value, options, onChange, testId, ariaLabel }: AutomationTypePickerProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const { style, placement } = usePopoverPosition(triggerRef, menuRef, open, {
    mode: 'dropdown',
    strategy: 'fixed',
    // Under the field, aligned to its left edge, like the native select it
    // replaces. `'auto'` would right-align it against a full-width trigger.
    preferRight: false,
  });

  // Both refs, because the menu is portaled OUT of the trigger's subtree: a
  // click inside it reads as "outside" to a container-only check and would
  // dismiss the menu before the option's own click ran. Same trap
  // `popover-escapes-clipping.md` records for every portaled menu.
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

  const selected = AUTOMATION_MANIFEST[value];
  // Deduped, because the current value is always listed and a caller that also
  // passes it in `options` would otherwise render it twice. Cheaper to be
  // tolerant here than to make every call site remember.
  const unique = Array.from(new Set(options));
  // A legacy type is shown so the row stays readable, and is never offered.
  const choosable = unique.filter((type) => AUTOMATION_MANIFEST[type].status !== 'legacy');
  const listed = choosable.includes(value) ? choosable : [value, ...choosable];

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
          if (event.key === 'Escape' && open) {
            // Before the dialog's own Escape handler, which would otherwise
            // close the whole editor because a menu was dismissed.
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
          }
          if (event.key === 'ArrowDown' && !open) setOpen(true);
        }}
        // The shared field fill, so this reads as the same control family as
        // the Name input and the manifest fields around it.
        className="flex w-full cursor-pointer items-center gap-2 rounded border border-edge-input bg-surface-control px-3 py-1.5 text-left text-sm text-fg-tertiary focus:border-accent focus:outline-none"
      >
        <AutomationIcon name={selected.icon} size={14} className="shrink-0 text-fg-muted" />
        <span className="min-w-0 flex-1 truncate">{selected.label}</span>
        <ChevronDown size={14} className="shrink-0 text-fg-muted" />
      </button>

      {/* Mounted only while open, rather than handing `open` to OverlayPopover
          and letting it play an exit. Measured: on this menu the exit class and
          its `popover-out` animation apply, the animation advances past its
          100ms duration, and `animationend` never fires - so the wrapper never
          reaches `onClose()` and the menu stays on screen with
          `aria-expanded="false"`. `AddAutomationPicker` beside it has always
          mounted conditionally and has never shown the fault, so this takes the
          shape that works. The cost is no exit motion. */}
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
          {listed.map((type) => {
            const entry = AUTOMATION_MANIFEST[type];
            const isLegacy = entry.status === 'legacy';
            const isSelected = type === value;
            return (
              <button
                key={type}
                type="button"
                role="option"
                aria-selected={isSelected}
                disabled={isLegacy}
                data-testid={`${testId}-option`}
                data-type={type}
                title={isLegacy ? 'This type is retired and cannot be chosen.' : undefined}
                onClick={() => { if (!isLegacy) { onChange(type); setOpen(false); } }}
                className={`flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm ${
                  isLegacy ? 'cursor-not-allowed opacity-55' : 'cursor-pointer hover:bg-surface-hover'
                }`}
              >
                <AutomationIcon name={entry.icon} size={14} className="shrink-0 text-fg-muted" />
                <span className="min-w-0 flex-1 truncate text-fg">{entry.label}</span>
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

import type { ReactNode } from 'react';
import type { useSuggestionMenu } from '../hooks/useSuggestionMenu';
import { OverlayPopover } from './OverlayPopover';

/**
 * The suggestions under a text field. A popover on the body, not a list in the form: a list that closes on blur
 * moves the controls below it between a press and its release, and the click is lost.
 */
export function SuggestionMenu({ menu, open, id, testId, children }: {
  menu: ReturnType<typeof useSuggestionMenu>;
  open: boolean;
  id?: string;
  testId: string;
  children: ReactNode;
}) {
  return (
    <OverlayPopover
      open={open}
      popoverRef={menu.popoverRef}
      style={menu.style}
      portal
      transformOrigin={menu.placement.vertical === 'above' ? 'bottom center' : 'top center'}
      className="fixed z-[2147483646] max-h-44 overflow-y-auto rounded border border-edge-input bg-surface-raised py-1 text-sm shadow-xl"
      role="listbox"
      id={id}
      data-testid={testId}
    >
      {children}
    </OverlayPopover>
  );
}

export function SuggestionOption({ selected, onChoose, testId, children }: {
  selected: boolean;
  onChoose: () => void;
  testId: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      // Pressing a suggestion must not take focus from the field, or its blur would close the list first.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onChoose}
      className={`flex w-full items-center justify-between gap-3 px-3 py-1.5 text-left font-mono text-fg-tertiary hover:bg-surface-hover ${selected ? 'bg-surface-hover' : ''}`}
      data-testid={testId}
    >
      {children}
    </button>
  );
}

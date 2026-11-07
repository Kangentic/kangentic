import { useRef, useState } from 'react';
import { usePopoverPosition } from './usePopoverPosition';

interface SuggestionMenuOptions {
  /** The field the menu opens under. */
  anchorRef: React.RefObject<HTMLElement | null>;
  itemCount: number;
  open: boolean;
  onChoose: (index: number) => void;
  /** Escape closed the menu. */
  onDismiss: () => void;
  /** An arrow key asked for the menu again. */
  onReopen: () => void;
}

/** The highlight, position and keys of the suggestion menu under a text field. `SuggestionMenu` draws it. */
export function useSuggestionMenu({ anchorRef, itemCount, open, onChoose, onDismiss, onReopen }: SuggestionMenuOptions) {
  const [highlight, setHighlight] = useState(-1);
  const popoverRef = useRef<HTMLDivElement>(null);
  const { style, placement } = usePopoverPosition(anchorRef, popoverRef, open, {
    mode: 'dropdown',
    strategy: 'fixed',
    preferVertical: 'below',
    preferRight: false,
    matchTriggerWidth: true,
  });

  /** Handle a key the menu owns, and say whether it did. Any other key stays the form's. */
  function handleMenuKey(event: React.KeyboardEvent<HTMLInputElement>): boolean {
    if (event.key === 'Escape' && open) {
      // The menu's Escape, not the form's: a panel and a dialog both dismiss on a bubble-phase document Escape.
      event.stopPropagation();
      onDismiss();
      setHighlight(-1);
      return true;
    }
    if (event.key === 'ArrowDown' && itemCount > 0) {
      event.preventDefault();
      onReopen();
      setHighlight((current) => Math.min(current + 1, itemCount - 1));
      return true;
    }
    if (event.key === 'ArrowUp' && itemCount > 0) {
      event.preventDefault();
      setHighlight((current) => Math.max(current - 1, 0));
      return true;
    }
    if (event.key === 'Enter' && open && highlight >= 0 && highlight < itemCount) {
      event.preventDefault();
      onChoose(highlight);
      setHighlight(-1);
      return true;
    }
    return false;
  }

  return { highlight, setHighlight, popoverRef, style, placement, handleMenuKey };
}

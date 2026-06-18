import { useRef, useEffect, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { usePopoverPosition } from '../../../hooks/usePopoverPosition';
import { CommandSearchList } from './CommandSearchList';
import type { AgentCommand } from '../../../../shared/types';

export interface CommandPalettePopoverProps {
  triggerRef: RefObject<HTMLElement | null>;
  cwd?: string;
  onSelect: (command: AgentCommand) => void;
  onClose: () => void;
}

/**
 * The header "Commands" pill's popover: a positioned, body-portaled surface
 * (fixed coordinates so it escapes the window frame's `overflow-hidden`) wrapping
 * the shared `CommandSearchList`. The kebab "Commands" flyout hosts the same list
 * with its own (flyout) positioning, so both entry points are identical.
 */
export function CommandPalettePopover({ triggerRef, cwd, onSelect, onClose }: CommandPalettePopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const { style: popoverStyle } = usePopoverPosition(triggerRef, popoverRef, true, { mode: 'dropdown', strategy: 'fixed' });

  // Click-outside closes.
  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClick, true);
    return () => document.removeEventListener('mousedown', handleClick, true);
  }, [onClose]);

  return createPortal(
    <div
      ref={popoverRef}
      style={{ ...popoverStyle, transformOrigin: 'top center' }}
      className="fixed w-[280px] max-h-[300px] bg-surface-raised border border-edge-input rounded-md shadow-xl z-[2147483646] flex flex-col overflow-hidden overlay-popover-in"
      data-testid="command-palette-popover"
    >
      <CommandSearchList cwd={cwd} onSelect={onSelect} onClose={onClose} />
    </div>,
    document.body,
  );
}

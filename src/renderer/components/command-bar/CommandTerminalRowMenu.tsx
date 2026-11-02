/**
 * The right-click menu on a terminal's Running row in the rail, or on its chip
 * in the collapsed rail: that terminal's whole ... menu, at the pointer
 * (`CommandTerminalMenuItems`, the same list its header's kebab shows).
 */

import { CommandTerminalContextMenu } from './CommandTerminalContextMenu';
import { CommandTerminalMenuItems, type CommandTerminalMenuActions } from './CommandTerminalMenuItems';

interface CommandTerminalRowMenuProps extends CommandTerminalMenuActions {
  /** Where the right-click landed, in viewport pixels. */
  position: { x: number; y: number };
  onClose: () => void;
}

export function CommandTerminalRowMenu({ position, onClose, ...actions }: CommandTerminalRowMenuProps) {
  return (
    <CommandTerminalContextMenu position={position} onClose={onClose} testId="command-terminal-row-menu">
      <CommandTerminalMenuItems close={onClose} testIdPrefix="command-terminal-row-menu" {...actions} />
    </CommandTerminalContextMenu>
  );
}

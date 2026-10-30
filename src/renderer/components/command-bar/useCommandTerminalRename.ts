/**
 * The inline rename a Command Terminal's title turns into, in its header and
 * in its Running row. Main holds the name (`commandTerminalLabel`), so a commit
 * sends it there and the title reads it back off the replica. The input opens
 * on the name shown, Enter or a blur saves it, Escape keeps the old one, and an
 * empty name clears it, so the terminal goes back to "Command Terminal N".
 *
 * The right-click context menu's position lives here too. The header and the
 * Running row open the same one-item menu whose only action is this rename, so
 * keeping its state beside the rename keeps both call sites from each
 * re-deriving it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSessionStore } from '../../stores/session-store';
import type { ContextMenuPosition } from './CommandTerminalContextMenu';

export interface CommandTerminalRenameInputProps {
  ref: React.RefObject<HTMLInputElement | null>;
  value: string;
  onChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onBlur: () => void;
  onClick: (event: React.MouseEvent<HTMLInputElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
}

export function useCommandTerminalRename(
  sessionId: string | null,
  label: string | null,
  displayName: string,
): {
  isRenaming: boolean;
  startRename: () => void;
  inputProps: CommandTerminalRenameInputProps;
  contextMenuAt: ContextMenuPosition | null;
  onContextMenu: (event: React.MouseEvent) => void;
  closeContextMenu: () => void;
} {
  const [isRenaming, setIsRenaming] = useState(false);
  const [editName, setEditName] = useState('');
  const [contextMenuAt, setContextMenuAt] = useState<ContextMenuPosition | null>(null);
  const [previousSessionId, setPreviousSessionId] = useState(sessionId);
  const inputRef = useRef<HTMLInputElement>(null);

  // A window keeps its slot but its session changes under it on a branch-switch
  // respawn or an in-place resume. End any open edit or menu aimed at the old
  // session, so a blur does not save its text onto the new session's id. React's
  // adjust-state-during-render pattern, not an effect, so the reset lands before
  // the stale input can paint.
  if (sessionId !== previousSessionId) {
    setPreviousSessionId(sessionId);
    setIsRenaming(false);
    setContextMenuAt(null);
  }

  useEffect(() => {
    if (!isRenaming) return;
    inputRef.current?.focus();
    inputRef.current?.select();
  }, [isRenaming]);

  const startRename = useCallback(() => {
    if (!sessionId) return;
    setEditName(displayName);
    setIsRenaming(true);
  }, [sessionId, displayName]);

  const closeContextMenu = useCallback(() => setContextMenuAt(null), []);
  const onContextMenu = useCallback((event: React.MouseEvent): void => {
    event.preventDefault();
    if (!sessionId) return;
    setContextMenuAt({ x: event.clientX, y: event.clientY });
  }, [sessionId]);

  const endRename = (save: boolean): void => {
    setIsRenaming(false);
    if (!save || !sessionId) return;
    const typedName = editName.trim();
    // Nothing to send when the text already matches what the title shows: the
    // slot default (`displayName`, on an unnamed terminal) or the current label.
    if (typedName === displayName || typedName === (label ?? '')) return;
    void useSessionStore.getState().setTransientSessionLabel(sessionId, typedName);
  };

  return {
    isRenaming,
    startRename,
    contextMenuAt,
    onContextMenu,
    closeContextMenu,
    inputProps: {
      ref: inputRef,
      value: editName,
      onChange: (event) => setEditName(event.target.value),
      onBlur: () => endRename(true),
      onClick: (event) => event.stopPropagation(),
      onKeyDown: (event) => {
        event.stopPropagation();
        if (event.key === 'Enter') endRename(true);
        if (event.key === 'Escape') endRename(false);
      },
    },
  };
}

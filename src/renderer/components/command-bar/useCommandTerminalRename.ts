/**
 * Renaming one Command Terminal, for each place its name can be edited: the
 * header (its pencil, or Rename in its ... menu) and its row in the rail's
 * Running list.
 *
 * Main owns the name (`SessionManager.renameCommandTerminal`) and announces it
 * on the session push, which the replica's `commandTerminalLabel` follows. The
 * committed name shows at once all the same, held here until that push lands,
 * so the field never closes onto the old name for a frame.
 */

import { useCallback, useState } from 'react';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import { useSessionStore } from '../../stores/session-store';
import { useToastStore } from '../../stores/toast-store';
import { commandTerminalDisplayName, normalizeCommandTerminalName } from '../../../shared/command-terminal-name';
import { asSentence, describeIpcError } from '../../lib/ipc-error';

export interface CommandTerminalRename {
  /** The name as stored (null: none), the committed one while it is on its way. */
  label: string | null;
  /** What the terminal is called: its name, else "Command Terminal N". */
  displayName: string;
  editing: boolean;
  /** Open the name field. Nothing happens before the terminal has a session. */
  startEditing: () => void;
  /** Save what the field holds; a value that changes nothing sends nothing. */
  commit: (value: string) => void;
  cancel: () => void;
}

export function useCommandTerminalRename(sessionId: string | null, slot: string): CommandTerminalRename {
  const storedLabel = useSessionStore((state) =>
    sessionId ? state.sessions.find((session) => session.id === sessionId)?.commandTerminalLabel ?? null : null);
  const [editing, setEditing] = useState(false);
  // The committed name until the push carrying it lands. State set during
  // render (React's "information from previous renders" pattern), as the
  // header's branch is: the push is what ends the hold.
  const [pending, setPending] = useState<{ label: string | null } | null>(null);
  if (pending && pending.label === storedLabel) setPending(null);
  const label = pending ? pending.label : storedLabel;

  const startEditing = useCallback(() => {
    if (sessionId) setEditing(true);
  }, [sessionId]);

  const cancel = useCallback(() => setEditing(false), []);

  const commit = useCallback((value: string) => {
    setEditing(false);
    if (!sessionId) return;
    const next = normalizeCommandTerminalName(value, slot);
    if (next === label) return;
    setPending({ label: next });
    window.electronAPI.sessions.renameTransient(sessionId, next)
      .then((changed) => {
        // Main refused it (the terminal ended meanwhile): show what it holds.
        if (!changed) setPending(null);
      })
      .catch((error: unknown) => {
        setPending(null);
        useToastStore.getState().addToast({
          title: i18n._(msg`Couldn't rename terminal`),
          message: asSentence(describeIpcError(error, String(error))),
          variant: 'error',
        });
      });
  }, [sessionId, slot, label]);

  return {
    label,
    displayName: commandTerminalDisplayName(label, slot),
    editing,
    startEditing,
    commit,
    cancel,
  };
}

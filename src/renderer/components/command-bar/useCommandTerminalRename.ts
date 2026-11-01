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
  /** Why Rename is off (the terminal has no session yet), or null when it is on. */
  disabledReason: string | null;
  /** Open the name field. Nothing happens before the terminal has a session. */
  startEditing: () => void;
  /**
   * Save what the field holds. A value that changes nothing sends nothing,
   * except an Enter (`byKey`) on a terminal the user has not named yet: that
   * saves its own number as the user's choice, so the namer stands down. A
   * click elsewhere never does, so opening the field and leaving it changes
   * nothing.
   */
  commit: (value: string, byKey: boolean) => void;
  cancel: () => void;
}

export function useCommandTerminalRename(sessionId: string | null, slot: string): CommandTerminalRename {
  const storedLabel = useSessionStore((state) =>
    sessionId ? state.sessions.find((session) => session.id === sessionId)?.commandTerminalLabel ?? null : null);
  const namedByUser = useSessionStore((state) =>
    sessionId ? state.sessions.find((session) => session.id === sessionId)?.commandTerminalNamedByUser === true : false);
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

  const commit = useCallback((value: string, byKey: boolean) => {
    setEditing(false);
    if (!sessionId) return;
    const next = normalizeCommandTerminalName(value, slot);
    if (next === label && (!byKey || namedByUser)) return;
    setPending({ label: next });
    window.electronAPI.sessions.renameTransient(sessionId, next)
      .then((changed) => {
        // Main refused it (the terminal ended meanwhile), or the name stayed
        // as it was: show what it holds.
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
  }, [sessionId, slot, label, namedByUser]);

  return {
    label,
    displayName: commandTerminalDisplayName(label, slot),
    editing,
    disabledReason: sessionId ? null : i18n._(msg`Available once the terminal starts`),
    startEditing,
    commit,
    cancel,
  };
}

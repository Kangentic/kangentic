/**
 * The project's ended Command Terminal conversations, newest first, for the
 * panel's Earlier list. Main owns the list (`commandTerminalHistory:list`) and
 * pushes `commandTerminalHistory:changed` when a terminal ends or a resume
 * claims or frees a conversation; this re-reads on that push. A conversation a
 * live session holds again (just resumed) is dropped here at once, and so is
 * one the user just clicked (`hide`), so a second click cannot start it twice
 * before main's push arrives.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useSessionStore } from '../../stores/session-store';
import type { CommandTerminalHistoryEntry } from '../../../shared/types';

export function useCommandTerminalHistory(projectId: string | null): {
  entries: CommandTerminalHistoryEntry[];
  /** Hide a conversation until main's next list, which says whether it is still free. */
  hide: (agentSessionId: string) => void;
} {
  // Keyed by the project it was read for, so a project switch never shows the
  // previous project's list while the new one loads. `hidden` belongs to the
  // list it was hidden from, so the next read clears it.
  const [loaded, setLoaded] = useState<{ projectId: string; entries: CommandTerminalHistoryEntry[]; hidden: ReadonlySet<string> } | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    const load = (): void => {
      window.electronAPI.sessions.listCommandTerminalHistory(projectId)
        .then((entries) => {
          if (!cancelled) setLoaded({ projectId, entries, hidden: new Set() });
        })
        // A failed read keeps the last list; the next push reads again.
        .catch(() => undefined);
    };
    load();
    const unsubscribe = window.electronAPI.sessions.onCommandTerminalHistoryChanged((changedProjectId) => {
      if (changedProjectId === projectId) load();
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [projectId]);

  const liveAgentSessionIds = useSessionStore(useShallow((state) =>
    state.sessions.flatMap((session) => (session.agentSessionId ? [session.agentSessionId] : []))));

  const hide = useCallback((agentSessionId: string) => {
    setLoaded((current) => (current ? { ...current, hidden: new Set([...current.hidden, agentSessionId]) } : current));
  }, []);

  const entries = useMemo(() => {
    if (!loaded || loaded.projectId !== projectId) return [];
    const live = new Set(liveAgentSessionIds);
    return loaded.entries.filter((entry) => !live.has(entry.agentSessionId) && !loaded.hidden.has(entry.agentSessionId));
  }, [loaded, projectId, liveAgentSessionIds]);

  return { entries, hide };
}

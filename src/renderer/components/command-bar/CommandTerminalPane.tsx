/**
 * The Command Terminal's xterm host, extracted from `CommandTerminalWindow` so
 * it can be mounted with `key={sessionId}`. `useTerminal` is unmount-only
 * teardown (see its dispose effect) - a host MUST remount per session, which
 * both task-detail terminal hosts already do (`TerminalTab` via
 * `key={sessionId}` / `key={session.id}` at their mount sites). The Command
 * Terminal used to swap `sessionId` in place on a branch switch instead,
 * leaving the old xterm's onData/onResize/clipboard/WebGL permanently bound to
 * the killed session (initTerminal's `if (xtermRef.current) return` guard
 * never lets a second session take over an existing instance).
 *
 * `CommandTerminalWindow` renders this GATED on `effectiveSessionId` (not just
 * keyed): `effectiveSessionId` goes `null` mid-switch, and keying a
 * still-mounted subtree on `null` would mount a throwaway Terminal with no
 * onData/onResize and a wasted WebGL attach, then immediately tear it down.
 * Gating means the pane only ever exists with a real session id, so
 * `sessionId` here is non-nullable.
 */
import { useEffect, useRef, type RefObject } from 'react';
import { useTerminal } from '../../hooks/useTerminal';
import { useTerminalRefit } from '../../hooks/useTerminalRefit';
import { useDeferredTerminalInit } from '../../hooks/useDeferredTerminalInit';
import { useTerminalFileDrop } from '../../hooks/useTerminalFileDrop';
import { FileDropOverlay } from '../terminal/FileDropOverlay';
import { useConfigStore } from '../../stores/config-store';
import { useSessionStore } from '../../stores/session-store';
import { useProjectStore } from '../../stores/project-store';

/** The terminal's current grid, published by the pane so a caller (a branch
 *  respawn) can seed the new PTY at the size the user is already looking at
 *  instead of the spawn defaults. Null before the terminal has initialized. */
export type TerminalGridGetter = () => { cols: number; rows: number } | null;

interface CommandTerminalPaneProps {
  sessionId: string;
  isMaximized: boolean;
  /** Parent-owned ref this pane publishes its live `getDimensions` into on
   *  mount, and clears on unmount. See `TerminalGridGetter`. */
  gridGetterRef: RefObject<TerminalGridGetter | null>;
}

export function CommandTerminalPane({ sessionId, isMaximized, gridGetterRef }: CommandTerminalPaneProps) {
  const config = useConfigStore((s) => s.config);
  const projectAgent = useProjectStore((s) => s.currentProject?.default_agent ?? null);
  // Adapter-declared: this agent needs an explicit reference (not a bare path) to
  // reliably read a pasted/dropped image. Never branch on agent name - see
  // .claude/rules/agent-adapters-boundary.md.
  const pasteImageTemplate = useConfigStore(
    (s) => s.agentList.find((a) => a.name === projectAgent)?.pastedImageReferenceTemplate,
  );
  const commandTerminalShell = useSessionStore(
    (s) => s.sessions.find((session) => session.id === sessionId)?.shell,
  );

  const { terminalRef, initTerminal, fit, flushResize, focus, getDimensions } = useTerminal({
    sessionId,
    fontFamily: config.terminal.fontFamily,
    fontSize: config.terminal.fontSize,
    cursorStyle: config.terminal.cursorStyle,
    colors: config.terminal.colors,
    shellName: commandTerminalShell ?? undefined,
    pasteImageTemplate,
    backspaceSendsCtrlH: config.terminal.backspaceSendsCtrlH,
  });

  const fileDrop = useTerminalFileDrop(sessionId, focus, commandTerminalShell ?? undefined, pasteImageTemplate);

  // Publish the live grid getter for the parent to read before a branch
  // respawn. Cleared on unmount so a stale getter from a disposed session is
  // never read.
  useEffect(() => {
    gridGetterRef.current = getDimensions;
    return () => {
      gridGetterRef.current = null;
    };
  }, [gridGetterRef, getDimensions]);

  // Init deferred one frame, shared with TerminalTab via
  // useDeferredTerminalInit so the two hosts cannot drift. The hand-rolled
  // synchronous init this replaces built a throwaway xterm under StrictMode
  // (mount inits, cleanup disposes, remount inits again) whose
  // geometry-changing work raced the surviving terminal through the settle
  // pipeline - the deferred shape cancels the first mount's init before it
  // ever runs.
  const { initializedRef: initialized } = useDeferredTerminalInit({
    terminalRef,
    initTerminal,
    onInit: () => {
      fit();
      focus();
    },
  });

  // Refit on any size change, shared with TerminalTab via useTerminalRefit so
  // the two hosts cannot drift:
  // - Engine commits (drag/resize/maximize/snap/tile) dispatch one coalesced
  //   `terminal-panel-resize`, handled synchronously (fit + immediate SIGWINCH).
  // - Container-only changes (the footer ContextBar growing as pills populate or
  //   wrap, the Changes panel toggling the column width) are caught by the hook's
  //   persistent ResizeObserver, which the old hand-rolled paths missed - that
  //   gap clipped the fullscreen TUI's bottom rows under the pane edge.
  useTerminalRefit({
    terminalRef,
    initializedRef: initialized,
    fit,
    flushResize,
    immediatePanelResize: true,
  });

  // Restore terminal focus after a maximize/restore toggle (the button, Ctrl+Shift+M,
  // and the header double-click all flip `isMaximized`), so the next keystroke lands
  // in the terminal instead of the maximize button. The command terminal OWNS the
  // xterm focus, so call `focus()` directly. Mirrors TaskDetailWindow's re-homing of
  // the PR #33 fix; keys on the maximize toggle (not `terminal-panel-resize`, which
  // also fires on drag/resize) and skips the initial mount.
  const wasMaximizedRef = useRef(isMaximized);
  useEffect(() => {
    if (wasMaximizedRef.current === isMaximized) return;
    wasMaximizedRef.current = isMaximized;
    if (initialized.current) focus();
    // `initialized` is the stable ref returned by useDeferredTerminalInit -
    // listed for exhaustive-deps (which cannot see through the hook), never
    // a re-run trigger.
  }, [isMaximized, focus, initialized]);

  return (
    <div className="h-full" data-testid="command-bar-terminal-pane" data-session-id={sessionId}>
      <FileDropOverlay {...fileDrop} />
      <div
        ref={terminalRef}
        className="h-full"
        data-testid="command-bar-terminal"
      />
    </div>
  );
}

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
 * `CommandTerminalWindow` renders this GATED on `sessionId` (not just keyed):
 * the id goes `null` mid-switch, and keying a still-mounted subtree on `null`
 * would mount a throwaway Terminal with no onData/onResize and a wasted WebGL
 * attach, then immediately tear it down. Gating means the pane only ever
 * exists with a real session id, so `sessionId` here is non-nullable.
 *
 * The pane mounts as soon as the session exists, behind its own launch
 * overlay, and drops PTY output until `ready` (the agent is on screen), as
 * `TerminalTab` does. Mounting early is what sizes the PTY: a cold
 * spawn starts at the 120x30 default, and the mount's fit resizes it to the
 * window before the agent draws its first frame. Mounting only once ready let
 * Claude compose that frame at 120x30, and xterm never reflows the alternate
 * buffer on the resize that followed. The overlay lives inside the
 * `data-terminal-host` pane so the arrival-focus visibility check counts it as
 * part of the terminal.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, type RefObject } from 'react';
import { resolveTerminalBackground, useTerminal } from '../../hooks/useTerminal';
import { LaunchOverlay } from '../LaunchOverlay';
import { mayTakeArrivalFocus, type ArrivalFocusSite } from '../../utils/terminal-arrival-focus';
import { useTerminalRefit } from '../../hooks/useTerminalRefit';
import { useDeferredTerminalInit } from '../../hooks/useDeferredTerminalInit';
import { useTerminalFileDrop } from '../../hooks/useTerminalFileDrop';
import { FileDropOverlay } from '../terminal/FileDropOverlay';
import { msUntilResizeVeilLifts, TERMINAL_JUMP_EVENT } from './resize-veil';
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
  /** One of the layer's terminals fills the panel over the others (Expand).
   *  While it does, every terminal is sized to the whole panel, so flipping
   *  this jumps each one between its tile and the panel. */
  layoutExpanded: boolean;
  /** The agent is on screen, or something else says the terminal may show
   *  (an exit, a reattach). Until then the launch overlay covers the pane and
   *  PTY output is dropped; the false-to-true edge replays the scrollback. */
  ready: boolean;
  /** The launch overlay's label, shared with the window's pre-spawn overlay. */
  launchLabel: string;
  /** Parent-owned ref this pane publishes its live `getDimensions` into on
   *  mount, and clears on unmount. See `TerminalGridGetter`. */
  gridGetterRef: RefObject<TerminalGridGetter | null>;
}

export function CommandTerminalPane({ sessionId, isMaximized, layoutExpanded, ready, launchLabel, gridGetterRef }: CommandTerminalPaneProps) {
  const config = useConfigStore((s) => s.config);
  const projectAgent = useProjectStore((s) => s.currentProject?.default_agent ?? null);
  // Adapter-declared image-paste capability (which extensions this agent attaches
  // natively from a pasted path, and the fallback text for the rest), read off the
  // project's default agent since a Command Terminal has no task to resolve
  // through. The list entry is selected whole (a stable reference). Never branch
  // on agent name - see .claude/rules/agent-adapters-boundary.md.
  const pasteImageCapability = useConfigStore(
    (s) => s.agentList.find((a) => a.name === projectAgent),
  );
  const commandTerminalShell = useSessionStore(
    (s) => s.sessions.find((session) => session.id === sessionId)?.shell,
  );

  // Arrival-focus policy, shared with TerminalTab. A Command Terminal window can
  // be remounted by the project-switch reconcile rather than by a user gesture,
  // so its arrivals are arbitrated like any other. A real Ctrl+Shift+P still
  // focuses: opening the layer focuses its window, which the arbiter resolves.
  const mayFocusOnArrival = useCallback(
    (site: ArrivalFocusSite, terminalElement: HTMLElement | null) => mayTakeArrivalFocus(sessionId, site, terminalElement),
    [sessionId],
  );

  // Up while the terminal settles after a jump in size (below). Raised and
  // lowered through `data-veiled`, which React never sets, so it goes up in the
  // same layout pass as the jump, before a paint.
  const paneRef = useRef<HTMLDivElement>(null);
  const resizeVeilRef = useRef<HTMLDivElement>(null);
  const liftResizeVeilRef = useRef<(() => void) | null>(null);

  const { terminalRef, initTerminal, fit, flushResize, focus, paste, getDimensions, reloadScrollback, suppressDataRef } = useTerminal({
    sessionId,
    fontFamily: config.terminal.fontFamily,
    fontSize: config.terminal.fontSize,
    cursorStyle: config.terminal.cursorStyle,
    colors: config.terminal.colors,
    shellName: commandTerminalShell ?? undefined,
    pasteImageCapability,
    mayTakeArrivalFocus: mayFocusOnArrival,
  });

  const fileDrop = useTerminalFileDrop(sessionId, focus, paste, commandTerminalShell ?? undefined, pasteImageCapability);

  // Drop PTY output while the overlay covers the pane: those bytes are the
  // shell's prompt and the typed spawn command. Written on commit, ahead of the
  // deferred init that reads it, so the mount replay skips the scrollback fetch
  // but still fits and resizes the PTY (see useTerminal's initTerminal).
  useLayoutEffect(() => {
    suppressDataRef.current = !ready;
  });

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
      if (mayFocusOnArrival('deferred-init', terminalRef.current)) focus();
    },
  });

  // The overlay lifting replays the PTY's current state, the agent's first
  // frame, into the terminal that dropped everything before it. A pane whose
  // init had not run yet needs nothing here: its mount replay reads the flag
  // above and fetches the scrollback itself.
  const wasReadyRef = useRef(ready);
  useEffect(() => {
    const wasReady = wasReadyRef.current;
    wasReadyRef.current = ready;
    if (!ready || wasReady) return;
    if (initialized.current) reloadScrollback();
    // `initialized` is the stable ref returned by useDeferredTerminalInit -
    // listed for exhaustive-deps (which cannot see through the hook), never
    // a re-run trigger.
  }, [ready, reloadScrollback, initialized]);

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

  // Expand, Restore and the swap drag's preview jump this terminal between
  // sizes in one step (a switch between expanded terminals jumps nothing:
  // behind an expanded one every terminal is already the panel's size). Until
  // the agent repaints at the new size, the terminal shows the old frame on the
  // new grid: the footer mid-panel, then dropped to the bottom. The veil covers
  // that and comes down on the rule in `resize-veil.ts`, which watches this
  // terminal's output, since main's repaint settle fires on ConPTY's redraw of
  // the old screen. The live bytes land under the veil, so nothing is replayed.
  // Not while the launch overlay still covers the pane (`suppressDataRef` is
  // set until the agent is on screen).
  const raiseResizeVeil = useCallback((): void => {
    const veil = resizeVeilRef.current;
    if (suppressDataRef.current || !initialized.current || !veil) return;
    liftResizeVeilRef.current?.();
    const jumpAt = performance.now();
    let lastOutputAt = jumpAt;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const stopListening = window.electronAPI.sessions.onData((outputSessionId) => {
      if (outputSessionId === sessionId) lastOutputAt = performance.now();
    });
    const lift = (): void => {
      if (timer) clearTimeout(timer);
      stopListening();
      veil.removeAttribute('data-veiled');
      liftResizeVeilRef.current = null;
    };
    const liftWhenSettled = (): void => {
      const wait = msUntilResizeVeilLifts(performance.now(), jumpAt, lastOutputAt);
      if (wait === 0) lift();
      else timer = setTimeout(liftWhenSettled, wait);
    };
    veil.setAttribute('data-veiled', '');
    liftResizeVeilRef.current = lift;
    liftWhenSettled();
    // `initialized` and `suppressDataRef` are stable refs - listed for
    // exhaustive-deps (which cannot see through the hooks), never re-run triggers.
  }, [sessionId, initialized, suppressDataRef]);

  // Expand and Restore: the layout going in or out of expanded resizes every
  // terminal in it. A layout effect, so the veil is up before the jump paints.
  const wasLayoutExpandedRef = useRef(layoutExpanded);
  useLayoutEffect(() => {
    if (wasLayoutExpandedRef.current === layoutExpanded) return;
    wasLayoutExpandedRef.current = layoutExpanded;
    raiseResizeVeil();
  }, [layoutExpanded, raiseResizeVeil]);

  // The swap drag's preview, which moves this terminal into another tile.
  useEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    pane.addEventListener(TERMINAL_JUMP_EVENT, raiseResizeVeil);
    return () => pane.removeEventListener(TERMINAL_JUMP_EVENT, raiseResizeVeil);
  }, [raiseResizeVeil]);
  useEffect(() => () => liftResizeVeilRef.current?.(), []);

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
    // arrival-focus-ok: follows the user's own maximize/restore toggle, and the ref
    // above skips the initial mount, so this is never an arrival.
    if (initialized.current) focus();
    // `initialized` is the stable ref returned by useDeferredTerminalInit -
    // listed for exhaustive-deps (which cannot see through the hook), never
    // a re-run trigger.
  }, [isMaximized, focus, initialized]);

  return (
    // `data-terminal-host`: the pane the arrival-focus visibility check measures against.
    <div ref={paneRef} className="relative h-full" data-testid="command-bar-terminal-pane" data-terminal-host data-session-id={sessionId}>
      <FileDropOverlay {...fileDrop} />
      <div
        ref={terminalRef}
        className="h-full"
        data-testid="command-bar-terminal"
      />
      <div
        ref={resizeVeilRef}
        data-testid="command-terminal-resize-veil"
        className="pointer-events-none absolute inset-0 z-10 hidden data-[veiled]:block"
        style={{ backgroundColor: resolveTerminalBackground(config.terminal.colors) }}
        aria-hidden
      />
      {!ready && <LaunchOverlay label={launchLabel} />}
    </div>
  );
}

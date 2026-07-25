import { useEffect, useRef, useCallback } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '../addons/fit-addon';
import { attachWebglRenderer, notifyFontChanged } from '../utils/terminal-webgl';
import { copySelectionToClipboard, enableTerminalClipboard, stripOsc52Sequences } from '../utils/terminal-clipboard';
import { createTerminalLinkHandler } from '../utils/terminal-link-handler';
import { createWriteBatcher, type WriteBatcher } from '../utils/write-batcher';
import { createIncomingWriteQueue, writeChunkedToTerminal } from '../utils/incoming-write-queue';
import { isBoardDragActive, onBoardDragEnd } from '../lib/session-update-coalescer';
import { isTerminalParked, onTerminalReveal } from '../utils/parked-terminals';
import { noteTerminalFocus } from '../utils/dictation-target';
import { registerTerminalCapture, unregisterTerminalCapture, type TerminalCaptureReader } from '../utils/terminal-capture-registry';
import type { TerminalColorOverrides } from '../../shared/types';
import '@xterm/xterm/css/xterm.css';

/** Delay before forwarding a resize to the PTY. Coalesces rapid resizes
 *  (panel drag, window resize) into a single PTY resize so the TUI
 *  (Claude Code) only redraws once and scrollback isn't churned. */
const PTY_RESIZE_DEBOUNCE_MS = 200;

/** Backstop for a scrollback replay whose chunked write never completes (e.g.
 *  a dropped xterm.write callback). Force-clears scrollbackPendingRef and
 *  resumes the incoming queue so live output isn't dropped indefinitely.
 *  Comfortably above a healthy replay (repaint-settle caps at 400ms, plus a
 *  512KB chunked write) and far below a pathological hang. */
const SCROLLBACK_WATCHDOG_MS = 5000;

/** Live xterm scrollback cap (lines), applied to every session terminal.
 *  Every terminal (re)creation - mount, tab/window switch, resize,
 *  park-then-reveal, ownership handoff - refills the visible buffer from the
 *  main-process 512KB raw-ANSI ring (MAX_SCROLLBACK in pty-buffer-manager.ts)
 *  regardless of this cap, so it only bounds a continuously-mounted,
 *  actively-streaming terminal's in-place scroll depth between replays. */
const TERMINAL_SCROLLBACK_LINES = 5000;

/** Scroll positions saved before xterm dispose, keyed by session ID.
 *  Preserved across HMR via import.meta.hot.data so terminals restore
 *  the user's viewport position instead of jumping to the bottom. */
// @ts-expect-error -- Vite handles import.meta.hot; tsc's "module": "commonjs" doesn't support it
const savedScrollPositions: Map<string, number> = import.meta.hot?.data?.savedScrollPositions ?? new Map();

// @ts-expect-error -- Vite handles import.meta.hot
if (import.meta.hot) {
  // @ts-expect-error -- Vite handles import.meta.hot
  import.meta.hot.dispose((data: Record<string, unknown>) => {
    data.savedScrollPositions = savedScrollPositions;
  });
}

// hmr-safe: a monotonic counter only used to mint a unique renderer-report key
// for a session-less (transient) terminal; resetting it on HMR at worst reuses
// a key for a terminal that has since disposed its report entry.
let transientRendererKeyCounter = 0;
function nextTransientRendererKey(): number {
  transientRendererKeyCounter += 1;
  return transientRendererKeyCounter;
}

/** Built-in terminal colors, used whenever the user hasn't customized a given
 *  slot (see TerminalColorOverrides in shared/types.ts). The ANSI 16 default to
 *  Windows Terminal's real "Campbell" scheme (learn.microsoft.com/windows/terminal
 *  /customize-settings/color-schemes) so an unconfigured terminal still reads as
 *  a real terminal, not an app panel with text in it. `black` is deliberately
 *  NOT Campbell's native black (`#0C0C0C`, identical to the default background):
 *  that would make black-on-default text and black fills invisible, so it's
 *  kept at the old zinc-900 tone instead, subdued but present. */
export const TERMINAL_DEFAULT_COLORS = {
  background: '#0c0c0c',
  foreground: '#e4e4e7',
  cursor: '#e4e4e7',
  selectionBackground: 'rgba(58, 130, 246, 0.35)',
  black: '#18181b',
  red: '#C50F1F', green: '#13A10E', yellow: '#C19C00', blue: '#0037DA', magenta: '#881798', cyan: '#3A96DD', white: '#CCCCCC',
  brightBlack: '#767676', brightRed: '#E74856', brightGreen: '#16C60C', brightYellow: '#F9F1A5', brightBlue: '#3B78FF', brightMagenta: '#B4009E', brightCyan: '#61D6D6', brightWhite: '#F2F2F2',
} as const;

/** Resolves the effective terminal background: the user's custom override, or
 *  the built-in default. Exported so surfaces that must paint the identical
 *  color BEFORE (or independent of) the xterm instance itself - the host
 *  container, the replay veil - stay in lockstep with whatever the user has
 *  configured, instead of drifting from a stale fixed constant. A veil or
 *  container using a different color than the live xterm theme would show a
 *  visible seam/flash; see TerminalTab.tsx and CommandTerminalWindow.tsx. */
export function resolveTerminalBackground(colors: TerminalColorOverrides | undefined): string {
  return colors?.background || TERMINAL_DEFAULT_COLORS.background;
}

/** Resolves the effective terminal foreground: the user's custom override, or
 *  the built-in default. Mirrors resolveTerminalBackground so a surface that
 *  must paint terminal-matching text (e.g. LaunchOverlay's terminal variant)
 *  stays in lockstep with the live xterm theme instead of a stale constant. */
export function resolveTerminalForeground(colors: TerminalColorOverrides | undefined): string {
  return colors?.foreground || TERMINAL_DEFAULT_COLORS.foreground;
}

/** Builds the full xterm theme: background/foreground/cursor layer the user's
 *  overrides over the defaults; the 16-color ANSI palette is always the fixed
 *  built-in scheme (not user-customizable - see TerminalColorOverrides).
 *  `cursorAccent` always tracks the resolved `background` (not a fixed value)
 *  so the glyph under a block cursor stays legible even when the user picks a
 *  custom background. */
export function buildTerminalTheme(colors: TerminalColorOverrides | undefined) {
  const background = resolveTerminalBackground(colors);
  return {
    ...TERMINAL_DEFAULT_COLORS,
    background,
    foreground: resolveTerminalForeground(colors),
    cursor: colors?.cursor || TERMINAL_DEFAULT_COLORS.cursor,
    cursorAccent: background,
  };
}

interface UseTerminalOptions {
  sessionId: string | null;
  fontFamily?: string;
  fontSize?: number;
  cursorStyle?: 'block' | 'underline' | 'bar';
  /** Global-only setting: per-slot custom terminal colors. Any unset slot
   *  falls back to TERMINAL_DEFAULT_COLORS. */
  colors?: TerminalColorOverrides;
  shellName?: string;
  /** Let Escape bubble (to close the containing dialog) when the mouse pointer
   *  is outside the terminal. Used by the task detail dialog. */
  releaseEscapeWhenPointerOutside?: boolean;
  /** Adapter-declared template (see `AgentDetectionInfo.pastedImageReferenceTemplate`) for
   *  the text injected when a pasted/dropped image is captured to a temp PNG. Read live via
   *  a ref (not captured at attach time) since the agent list loads asynchronously and can
   *  resolve after `enableTerminalClipboard` has already attached its key handler. */
  pasteImageTemplate?: string;
  /** When true, plain Backspace sends Ctrl+H (0x08) instead of xterm's default
   *  DEL (0x7f), matching native Windows conhost so Claude Code's TUI deletes
   *  the previous word. Read live via a ref (same pattern as
   *  pasteImageTemplate) so a settings toggle applies without remount. */
  backspaceSendsCtrlH?: boolean;
  /** Fired every time a scrollback operation (mount replay, reload, watchdog
   *  force-recovery, or IPC-rejection recovery) settles, i.e. whenever
   *  scrollbackPendingRef flips back to false. TerminalTab uses the first
   *  firing to lift its replay veil so only the settled frame is ever shown.
   *  Read live via a ref, so the callback never goes stale. */
  onScrollbackSettled?: () => void;
}

/** Restore a saved scroll position (from HMR) or pin to the bottom.
 *  Consumes and deletes the saved entry so it's only applied once.
 *  Returns true if the terminal ended up at the bottom. */
function restoreScrollPosition(terminal: Terminal, sessionId: string | null): boolean {
  const savedViewportY = sessionId
    ? savedScrollPositions.get(sessionId)
    : undefined;
  if (savedViewportY !== undefined) {
    terminal.scrollToLine(savedViewportY);
    savedScrollPositions.delete(sessionId!);
    return false;
  }
  terminal.scrollToBottom();
  return true;
}

/** Pure predicate for the hook's host contract (see the unmount-only dispose
 *  effect's eslint-disable below): a host must remount (key={sessionId})
 *  rather than swap `options.sessionId` to a different live session on the
 *  same instance. Swapping in place leaves `initTerminal`'s
 *  `if (xtermRef.current) return` guard permanently short-circuited, so
 *  onData/onResize/clipboard/WebGL stay bound to the dead session - the exact
 *  bug a Command Terminal branch switch shipped. Exported so the contract is
 *  unit-testable without mounting a real Terminal. */
export function isSessionSwapWithoutRemount(
  previousSessionId: string | null,
  nextSessionId: string | null,
  hasLiveTerminal: boolean,
): boolean {
  return (
    hasLiveTerminal
    && previousSessionId !== null
    && nextSessionId !== null
    && previousSessionId !== nextSessionId
  );
}

export function useTerminal(options: UseTerminalOptions) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const xtermRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const scrollbackPendingRef = useRef(false);
  /** Monotonic counter to abandon stale scrollback operations when a newer
   *  one starts (e.g. initTerminal and reloadScrollback racing). */
  const scrollbackGenerationRef = useRef(0);
  /** Backstop timer for a stuck replay (see SCROLLBACK_WATCHDOG_MS). Arming a
   *  new one clears any prior timer, so at most one is ever live - the one
   *  for the most recently started replay. */
  const scrollbackWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Resumes the incoming-write queue's held drain (set by the queue effect
   *  below). Used by the watchdog to flush replay-held live bytes when a
   *  stuck replay is force-cleared. */
  const incomingResumeRef = useRef<(() => void) | null>(null);
  const isAtBottomRef = useRef(true);
  /** When true, onData writes are suppressed. Controlled by the caller
   *  (e.g. TerminalTab) to gate PTY output while a loading overlay is shown. */
  const suppressDataRef = useRef(false);
  const resizeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Coalesces xterm onData bursts (paste, key-repeat, clipboard callback)
   *  into one IPC write per microtask. */
  const writeBatcherRef = useRef<WriteBatcher | null>(null);
  /** Tears down the WebGL renderer attachment (cancels retries, disposes addon). */
  const disposeWebglRef = useRef<(() => void) | null>(null);
  /** This terminal's key in the WebGL renderer report, so the font-family
   *  effect can force a fresh glyph rasterization after a live font change
   *  (see terminal-webgl.ts's notifyFontChanged). */
  const rendererKeyRef = useRef<string | null>(null);
  /** The font family/size last applied to xterm, so the apply effect can tell
   *  an actual font change (which needs the document.fonts.load race guard and
   *  a glyph-atlas re-rasterization) apart from a cursor/scrollback/color-only
   *  change (which reuses the existing atlas and applies synchronously). */
  const lastAppliedFontRef = useRef<{ family: string; size: number } | null>(null);
  /** Updated every render so the paste handler (attached once by initTerminal)
   *  always reads the current template, even though the agent list resolves
   *  asynchronously after the terminal has already initialized. */
  const pasteImageTemplateRef = useRef(options.pasteImageTemplate);
  pasteImageTemplateRef.current = options.pasteImageTemplate;
  /** Updated every render (same pattern as pasteImageTemplateRef) so the key
   *  handler attached once by initTerminal always reads the current setting. */
  const backspaceSendsCtrlHRef = useRef(options.backspaceSendsCtrlH);
  backspaceSendsCtrlHRef.current = options.backspaceSendsCtrlH;
  /** Updated every render (same pattern as pasteImageTemplateRef) so the settle
   *  paths attached by initTerminal/reloadScrollback always call the caller's
   *  current callback. */
  const onScrollbackSettledRef = useRef(options.onScrollbackSettled);
  onScrollbackSettledRef.current = options.onScrollbackSettled;

  /** Single chokepoint for "a scrollback operation has settled". Ordering is
   *  load-bearing: pending must clear BEFORE the kick (the incoming queue's
   *  shouldHold reads it), and the settle notification fires AFTER the kick so
   *  the held-byte drain has begun before the caller schedules any reveal
   *  render. The catch paths pass shouldKickIncomingQueue=false (an IPC
   *  rejection means the session is gone; there is nothing held worth
   *  flushing). */
  const settleScrollback = useCallback((shouldKickIncomingQueue: boolean) => {
    scrollbackPendingRef.current = false;
    if (shouldKickIncomingQueue) incomingResumeRef.current?.();
    onScrollbackSettledRef.current?.();
  }, []);

  // Dev-only host-contract tripwire (compiled out of production, where
  // import.meta.env.DEV is statically false). Registered before any effect the
  // host itself declares (useTerminal()'s own hooks always run first within a
  // render, since the host calls useTerminal() before its own useEffect
  // calls), so it observes xtermRef.current from the PRIOR commit - still the
  // old session's terminal - the same instant the host's init effect would.
  // Never fires for a correctly-keyed host (see isSessionSwapWithoutRemount).
  const lastNonNullSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    // @ts-expect-error -- Vite defines import.meta.env; tsc's "module": "commonjs" doesn't support it
    if (import.meta.env?.DEV && isSessionSwapWithoutRemount(lastNonNullSessionIdRef.current, options.sessionId, xtermRef.current !== null)) {
      console.error(
        `[useTerminal] sessionId changed from ${lastNonNullSessionIdRef.current} to ${options.sessionId} on a live terminal instance. `
        + 'A host must remount (key={sessionId}) instead of swapping sessionId in place - see the unmount-only dispose effect below.',
      );
    }
    if (options.sessionId !== null) lastNonNullSessionIdRef.current = options.sessionId;
  }, [options.sessionId]);

  // Destructured to PRIMITIVES, deliberately: `config.terminal.colors` is a
  // fresh object on every config refetch (updateConfig -> refreshConfigs
  // re-fetches the whole tree over IPC), so depending on the OBJECT would churn
  // initTerminal's identity on any unrelated settings write - including
  // background ones like model-discovery telemetry - and retrigger the callers'
  // mount effects (overlay flash + scrollback reload in TerminalTab, focus theft
  // in CommandTerminalWindow). Every other entry in those dep arrays is already
  // a primitive for the same reason.
  const customBackground = options.colors?.background;
  const customForeground = options.colors?.foreground;
  const customCursor = options.colors?.cursor;

  const initTerminal = useCallback(() => {
    if (!terminalRef.current || xtermRef.current) return;

    const xtermTheme = buildTerminalTheme({
      background: customBackground,
      foreground: customForeground,
      cursor: customCursor,
    });

    const terminal = new Terminal({
      fontFamily: options.fontFamily || 'Menlo, Consolas, "Courier New", monospace',
      fontSize: options.fontSize || 14,
      theme: xtermTheme,
      scrollback: TERMINAL_SCROLLBACK_LINES,
      cursorBlink: true,
      cursorStyle: options.cursorStyle || 'block',
      // HIDE the cursor when this terminal is BLURRED. Only the focused pane (where
      // you are typing) shows a cursor - a solid blinking block - so the cursor is a
      // clean "you are here" cue. The window's accent outline + pulsing line carry
      // the "which window is selected" cue for the unfocused panes.
      cursorInactiveStyle: 'none',
      allowProposedApi: true,
      linkHandler: createTerminalLinkHandler((url) => window.electronAPI.shell.openExternal(url)),
    });

    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);

    terminal.open(terminalRef.current);

    // Record this terminal as the last-focused one for dictation injection
    // target resolution. The textarea is xterm's focusable element, so this
    // fires on both a user click and a programmatic focus(); it is torn down
    // automatically when the terminal is disposed on unmount.
    if (options.sessionId) {
      const focusedSessionId = options.sessionId;
      terminal.textarea?.addEventListener('focus', () => noteTerminalFocus(focusedSessionId));
    }

    // Batch outgoing input into one IPC write per microtask. A paste or
    // programmatic terminal.paste() often dispatches onData multiple times
    // synchronously; concatenating those into a single ipcRenderer.invoke
    // avoids N round-trips across the process boundary. PTY byte order is
    // preserved for sequential pty.write calls, so concatenation is safe.
    const batcher = createWriteBatcher((payload) => {
      if (options.sessionId) {
        window.electronAPI.sessions.write(options.sessionId, payload);
      }
    });
    writeBatcherRef.current = batcher;

    // Enable Ctrl+C copy (when text selected), Ctrl+V paste, and Ctrl+Enter newline
    enableTerminalClipboard(
      terminal,
      terminalRef.current,
      batcher.schedule,
      options.shellName,
      options.sessionId ?? undefined,
      options.releaseEscapeWhenPointerOutside,
      () => pasteImageTemplateRef.current,
      () => backspaceSendsCtrlHRef.current ?? false,
    );

    terminal.onScroll(() => {
      const buffer = terminal.buffer.active;
      isAtBottomRef.current = buffer.viewportY >= buffer.baseY;
    });

    // Attach the WebGL renderer with context-loss recovery (retry + backoff,
    // logged, renderer type tracked). Keyed by session id, or a stable transient
    // key for a session-less pane so the devtools report can distinguish them.
    const rendererKey = options.sessionId ?? `transient-${nextTransientRendererKey()}`;
    disposeWebglRef.current = attachWebglRenderer(terminal, rendererKey);
    rendererKeyRef.current = rendererKey;

    xtermRef.current = terminal;
    fitAddonRef.current = fitAddon;

    // Send user input to PTY (via the microtask-batched queue above).
    if (options.sessionId) {
      terminal.onData(batcher.schedule);

      // Debounced PTY resize -- coalesces rapid dimension changes so the
      // TUI only redraws once after resizing settles.
      const sid = options.sessionId;
      terminal.onResize(({ cols, rows }) => {
        if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
        resizeTimerRef.current = setTimeout(() => {
          resizeTimerRef.current = null;
          window.electronAPI.sessions.resize(sid, cols, rows);
        }, PTY_RESIZE_DEBOUNCE_MS);
      });

      // Resize-first scrollback replay: fit the terminal to the container
      // FIRST, then fetch scrollback. The width change (if any) and the sample
      // are ordered on the main process, not here - see the parallel-IPC note
      // below.
      scrollbackPendingRef.current = true;
      const scrollbackGeneration = ++scrollbackGenerationRef.current;
      const suppressScrollback = suppressDataRef.current;
      if (scrollbackWatchdogRef.current) clearTimeout(scrollbackWatchdogRef.current);
      scrollbackWatchdogRef.current = setTimeout(() => {
        scrollbackWatchdogRef.current = null;
        if (scrollbackGenerationRef.current === scrollbackGeneration && scrollbackPendingRef.current) {
          // Invalidate the generation so a merely-delayed (not dropped) afterWrite
          // or catch for this replay bails at its generation guard instead of
          // re-running fit / scroll / focus after we already force-recovered.
          scrollbackGenerationRef.current += 1;
          settleScrollback(true);
        }
      }, SCROLLBACK_WATCHDOG_MS);

      // Fit immediately to calculate actual container cols/rows
      fitAddon.fit();
      const { cols, rows } = terminal;

      // Parallel IPCs: resize forwards SIGWINCH on main; getScrollback is a
      // pure in-memory read. Firing them together is safe because main
      // preserves per-renderer IPC order and the resize handler is synchronous,
      // so main records the width change before getScrollback runs. When cols
      // changed, main's getScrollback waits for the agent TUI's async SIGWINCH
      // repaint to land before sampling (PtyBufferManager.waitForResizeRepaint),
      // so the replay is at the fitted width - no stale frame, no compensating
      // resize needed here. The colsChanged field of the resize result is
      // therefore intentionally unused by the renderer.
      const resizePromise = window.electronAPI.sessions.resize(sid, cols, rows);
      const scrollbackPromise = suppressScrollback
        ? Promise.resolve<string | null>(null)
        : window.electronAPI.sessions.getScrollback(sid);

      Promise.all([resizePromise, scrollbackPromise])
        .then(([, scrollback]) => {
          // A newer scrollback operation has started; it owns clearing pending
          // (and the watchdog it armed), so this stale resolve must not touch
          // either - clearing them here would open the drop/hold gate early
          // for the newer replay still in flight.
          if (scrollbackGenerationRef.current !== scrollbackGeneration) return;

          const afterWrite = () => {
            // A newer replay may have started (and armed its own watchdog,
            // which already canceled ours) while this chunked write was in
            // flight; abandon so we don't clobber its pending/fit/focus.
            if (scrollbackGenerationRef.current !== scrollbackGeneration) return;
            if (scrollbackWatchdogRef.current) {
              clearTimeout(scrollbackWatchdogRef.current);
              scrollbackWatchdogRef.current = null;
            }
            // Re-fit to handle any layout shifts during the async gap
            if (fitAddonRef.current) {
              fitAddonRef.current.fit();
            }
            // Restore saved scroll position (HMR) or pin to bottom (cold start)
            if (xtermRef.current) {
              isAtBottomRef.current = restoreScrollPosition(xtermRef.current, options.sessionId);
            }
            // Flush any live bytes the incoming queue held during the replay
            // (see shouldHold in the queue effect below) now that the replay
            // frame is fully painted, so they apply strictly after it.
            settleScrollback(true);
            // Focus the terminal after the full init chain completes. No
            // corrective resize: main already sampled the settled frame at the
            // fitted width, and a same-dims resize is a documented no-op (POSIX
            // sends SIGWINCH only on a real size change; ConPTY likewise).
            requestAnimationFrame(() => {
              xtermRef.current?.focus();
            });
          };
          if (scrollback && xtermRef.current) {
            // Chunked so a 512KB replay doesn't parse in one synchronous write.
            // Strip OSC 52 so replaying recorded output never clobbers the live clipboard.
            // shouldAbort: a newer replay (reveal catch-up, reloadScrollback) may
            // start and bump the generation while this chunked write is still
            // draining; abandon rather than write a stale frame over the new one.
            writeChunkedToTerminal(
              xtermRef.current,
              stripOsc52Sequences(scrollback),
              afterWrite,
              undefined,
              () => scrollbackGenerationRef.current !== scrollbackGeneration,
            );
          } else {
            afterWrite();
          }
        })
        .catch(() => {
          // IPC may reject if session was killed during the async gap.
          // Unblock onData so the terminal isn't permanently silenced.
          if (scrollbackGenerationRef.current !== scrollbackGeneration) return;
          if (scrollbackWatchdogRef.current) {
            clearTimeout(scrollbackWatchdogRef.current);
            scrollbackWatchdogRef.current = null;
          }
          settleScrollback(false);
        });
    } else {
      // No session -- just fit immediately
      fitAddon.fit();
    }
  }, [options.sessionId, options.fontFamily, options.fontSize, options.cursorStyle, customBackground, customForeground, customCursor, options.shellName, options.releaseEscapeWhenPointerOutside, settleScrollback]);

  // Set up data listener. Inbound PTY data flows through a bounded queue that
  // writes capped slices paced by xterm.write's completion callback, yielding
  // to input/React between slices so a heavy output burst can't freeze the UI.
  // Each consumed slice is acked back to main, which drives per-session PTY
  // backpressure (pause when the renderer falls behind, resume as it drains).
  useEffect(() => {
    const sessionId = options.sessionId;
    if (!sessionId) return;

    const queue = createIncomingWriteQueue({
      getTerminal: () => xtermRef.current,
      // Drop (ack-and-discard) for states that can last indefinitely, where
      // holding would pause the PTY at the backpressure high-water and block
      // the agent's stdout: an overlay (agent startup) and a PARKED terminal
      // (window off-view on Backlog or occluded by a maximized window - see
      // parked-terminals.ts). Both are recovered by a reloadScrollback (on
      // overlay lift / on reveal): the main process keeps accumulating the
      // dropped bytes in the per-session scrollback ring. Dropped slices are
      // still acked inside the queue.
      shouldDrop: () => suppressDataRef.current || isTerminalParked(sessionId),
      // While a board drag OR a scrollback replay is in flight, HOLD (not
      // drop) inbound writes. For a replay, getScrollback() drains the
      // server-side pending buffer, so anything still arriving here is either
      // an in-flight duplicate of the replay (harmless to re-apply) or
      // genuinely new live output (e.g. a diff frame) that must not be lost -
      // dropping it (the prior behavior) could silently discard a selection
      // highlight in a fullscreen TUI. Held bytes are retained and resumed via
      // kick() on drag end, at the end of afterWrite, or by the stuck-replay
      // watchdog.
      shouldHold: () => isBoardDragActive() || scrollbackPendingRef.current,
      ack: (bytes) => window.electronAPI.sessions.ackData(sessionId, bytes),
    });
    incomingResumeRef.current = () => queue.kick();

    const cleanup = window.electronAPI.sessions.onData((incomingSessionId, data) => {
      if (incomingSessionId !== sessionId) return;
      queue.push(data);
    });
    // Resume the held drain the moment a board drag ends (also via the
    // coalescer's watchdog / window-blur backstops, which route through here).
    const unsubscribeDragEnd = onBoardDragEnd(() => queue.kick());

    cleanupRef.current = cleanup;
    return () => {
      cleanup();
      cleanupRef.current = null;
      incomingResumeRef.current = null;
      unsubscribeDragEnd();
      queue.reset();
    };
  }, [options.sessionId]);

  // Handle context-menu actions dispatched from the main process: Copy, Select
  // All, and Paste. The event detail carries the right-click coordinates so we
  // only act when the click landed inside THIS terminal's container.
  useEffect(() => {
    const isInside = (e: Event): boolean => {
      const el = terminalRef.current;
      if (!el || !xtermRef.current) return false;
      const { x, y } = (e as CustomEvent).detail || {};
      if (x == null || y == null) return false;
      const rect = el.getBoundingClientRect();
      return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom;
    };
    const handleCopy = (e: Event) => {
      if (!isInside(e)) return;
      // Write via the main process (focus-independent). The native context menu's
      // Menu.popup steals document focus, so navigator.clipboard.writeText would reject.
      copySelectionToClipboard(xtermRef.current!);
    };
    const handleSelectAll = (e: Event) => {
      if (!isInside(e)) return;
      xtermRef.current!.selectAll();
    };
    const handlePaste = (e: Event) => {
      if (!isInside(e)) return;
      navigator.clipboard.readText().then((text) => {
        if (text) xtermRef.current?.paste(text);
      }).catch(() => { /* clipboard access denied */ });
    };
    window.addEventListener('terminal-copy', handleCopy);
    window.addEventListener('terminal-select-all', handleSelectAll);
    window.addEventListener('terminal-paste', handlePaste);
    return () => {
      window.removeEventListener('terminal-copy', handleCopy);
      window.removeEventListener('terminal-select-all', handleSelectAll);
      window.removeEventListener('terminal-paste', handlePaste);
    };
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (resizeTimerRef.current) clearTimeout(resizeTimerRef.current);
      if (scrollbackWatchdogRef.current) clearTimeout(scrollbackWatchdogRef.current);
      // Flush any pending batched writes synchronously so keystrokes queued
      // just before unmount (sessionId change, HMR dispose) aren't dropped.
      writeBatcherRef.current?.flush();
      writeBatcherRef.current = null;
      // Save scroll position before dispose for HMR restoration.
      // Only save if the user scrolled up; at-bottom is the default.
      if (xtermRef.current && options.sessionId && !isAtBottomRef.current) {
        savedScrollPositions.set(options.sessionId, xtermRef.current.buffer.active.viewportY);
      } else if (options.sessionId) {
        savedScrollPositions.delete(options.sessionId);
      }
      // Tear down WebGL (cancel any pending re-init retry, drop the report entry)
      // before disposing the terminal it is attached to.
      disposeWebglRef.current?.();
      disposeWebglRef.current = null;
      rendererKeyRef.current = null;
      lastAppliedFontRef.current = null;
      xtermRef.current?.dispose();
      xtermRef.current = null;
      fitAddonRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount-only teardown; adding options.sessionId would dispose and recreate the xterm on every session switch. The scroll-save reads sessionId from the disposing render, which is correct because the component remounts per session (terminal ownership handoff)
  }, []);

  // Register a scrollback-viewport reader for the open-at-position feature:
  // captured at the moment a conversation viewer is opened from the task
  // header, so it can match the visible lines to a transcript turn (see
  // tui-anchor.ts). Deliberately its OWN effect, keyed only on sessionId -
  // NOT folded into initTerminal's one-shot creation, which guards itself
  // with `if (xtermRef.current) return` and so would only ever attempt this
  // once per component instance. A session-owning terminal's dimensions can
  // still be 0x0 on the first initTerminal() attempt (a task-detail dialog
  // that isn't laid out yet), in which case initTerminal defers its real
  // creation to a later ResizeObserver-driven retry - by which point
  // initTerminal's own registration attempt would already have been skipped
  // for good. Reading `xtermRef.current` lazily (inside the reader, not at
  // registration time) means this effect only needs sessionId to be known,
  // not the terminal to already exist yet.
  useEffect(() => {
    if (!options.sessionId) return undefined;
    const captureSessionId = options.sessionId;
    const reader: TerminalCaptureReader = () => {
      const terminal = xtermRef.current;
      if (!terminal) return { visibleLines: [], atBottom: true };
      const buffer = terminal.buffer.active;
      const visibleLines: string[] = [];
      for (let row = 0; row < terminal.rows; row += 1) {
        const line = buffer.getLine(buffer.viewportY + row);
        visibleLines.push(line ? line.translateToString(true) : '');
      }
      return { visibleLines, atBottom: buffer.viewportY >= buffer.baseY };
    };
    registerTerminalCapture(captureSessionId, reader);
    return () => {
      unregisterTerminalCapture(captureSessionId, reader);
    };
  }, [options.sessionId]);

  // fit() only refits xterm visually. The debounced onResize callback
  // forwards dimensions to the PTY automatically when cols/rows change.
  const fit = useCallback(() => {
    if (!fitAddonRef.current || !xtermRef.current) return;
    const wasAtBottom = isAtBottomRef.current;
    fitAddonRef.current.fit();
    if (wasAtBottom) {
      xtermRef.current.scrollToBottom();
    }
  }, []);

  // Live-apply display settings to an already-mounted terminal, mirroring how
  // an app theme change applies immediately (rather than requiring the
  // terminal to be reopened). xterm.js exposes `options` as a live-settable
  // object post-construction; `theme` specifically needs a FRESH object on
  // every assignment (a reference-equal object is a no-op per xterm's docs),
  // which buildTerminalTheme always returns. A no-op (xtermRef.current is
  // null) before initTerminal has run; initTerminal reads the same options
  // directly, so there is no gap once it does. Re-fit goes through the shared
  // fit() (not the raw addon) so a terminal pinned to the bottom stays pinned
  // when a font-size change alters the row count, and it picks up the cell-size
  // change through the existing debounced onResize -> PTY resize path (a no-op
  // if cols/rows did not change). Declared AFTER fit() so the callback is
  // initialized before this effect's dependency array references it. `shell` is
  // deliberately excluded: switching it means killing and respawning the PTY
  // process, not a rendering change, and is out of scope here.
  useEffect(() => {
    if (!xtermRef.current) return;
    const fontFamily = options.fontFamily || 'Menlo, Consolas, "Courier New", monospace';
    const fontSize = options.fontSize || 14;
    // Only an actual font family/size change needs the document.fonts.load
    // race guard and the glyph-atlas re-rasterization below. A cursor,
    // scrollback, or color change reuses the current font metrics and atlas,
    // so it applies synchronously with no load round trip and no atlas clear -
    // which also stops per-keystroke atlas thrash while a font name is being
    // typed in Settings (onChange commits per character, across every mounted
    // terminal).
    const fontChanged =
      !lastAppliedFontRef.current ||
      lastAppliedFontRef.current.family !== fontFamily ||
      lastAppliedFontRef.current.size !== fontSize;
    let cancelled = false;

    const applyOptions = () => {
      // Dropped if a newer font change superseded this one while the load
      // below was in flight (see the cleanup below), or if the terminal was
      // torn down in the meantime.
      if (cancelled || !xtermRef.current) return;
      xtermRef.current.options = {
        fontFamily,
        fontSize,
        cursorStyle: options.cursorStyle || 'block',
        scrollback: TERMINAL_SCROLLBACK_LINES,
        theme: buildTerminalTheme({
          background: customBackground,
          foreground: customForeground,
          cursor: customCursor,
        }),
      };
      fit();
      if (fontChanged) {
        lastAppliedFontRef.current = { family: fontFamily, size: fontSize };
        // xterm re-measures character size as soon as `options.fontFamily` is
        // assigned above. Force the WebGL renderer to re-rasterize every glyph
        // under the new metrics rather than risk it reusing a stale cache entry
        // from the previous font.
        if (rendererKeyRef.current) notifyFontChanged(rendererKeyRef.current);
      }
    };

    if (fontChanged) {
      // Make sure the browser has actually resolved/loaded this font BEFORE
      // letting xterm measure character size against it. Re-measuring mid-load
      // is what produces a transient 0-width glyph cell, which the WebGL
      // addon's texture-atlas rasterization then throws IndexSizeError on
      // ("source width is 0") - this closes that race, most reachable by
      // clicking rapidly through the Font Family picker's suggestions.
      // document.fonts.load() can reject (a font that fails to resolve
      // entirely); the options are applied either way rather than left stale.
      document.fonts.load(`${fontSize}px ${fontFamily}`).then(applyOptions, applyOptions);
    } else {
      // No font change: apply synchronously, exactly as before this effect
      // grew its font-load path.
      applyOptions();
    }

    return () => {
      cancelled = true;
    };
  }, [options.fontFamily, options.fontSize, options.cursorStyle, customBackground, customForeground, customCursor, fit]);

  // Flush a pending (debounced) PTY resize immediately, instead of waiting out
  // PTY_RESIZE_DEBOUNCE_MS. Window-hosted terminals fit synchronously on the
  // window manager's committed resize, and the manager-resize gate already
  // coalesces a gesture to a single dimension change, so for them the debounce is
  // pure latency: it delays Claude's SIGWINCH redraw well past the visual reflow,
  // which reads as "reflow ... then flash". Calling this right after fit() lands
  // the PTY resize (and Claude's redraw) in the same beat as the reflow. No-op if
  // no resize is pending (cols/rows did not change).
  const flushResize = useCallback(() => {
    if (!resizeTimerRef.current || !xtermRef.current || !options.sessionId) return;
    clearTimeout(resizeTimerRef.current);
    resizeTimerRef.current = null;
    const { cols, rows } = xtermRef.current;
    window.electronAPI.sessions.resize(options.sessionId, cols, rows);
  }, [options.sessionId]);

  // Re-fetch scrollback from the PTY and write it to xterm. Called when
  // the loading overlay lifts so that suppressed TUI output is recovered.
  //
  // `skipResize` re-renders the buffer at the CURRENT (already-synced) width
  // without sending any SIGWINCH. Used by the window manager to clean up a
  // full-screen TUI's accumulated resize redraws AFTER resizing has settled:
  // the PTY is already the right size, so a resize here would only trigger more
  // TUI redraws (re-polluting the buffer with duplicated frames).
  //
  // `skipFocus` suppresses the end-of-reload focus steal. Used by the
  // parked -> visible reveal catch-up: a Backlog -> Board switch can reveal
  // many windows at once, and N terminals must not fight over focus (and a
  // quiet arrival should not move focus at all - restore-no-animation-replay).
  const reloadScrollback = useCallback((reloadOptions?: { skipResize?: boolean; skipFocus?: boolean }) => {
    if (!options.sessionId || !xtermRef.current || !fitAddonRef.current) return;
    const skipResize = reloadOptions?.skipResize ?? false;
    const skipFocus = reloadOptions?.skipFocus ?? false;
    scrollbackPendingRef.current = true;
    const scrollbackGeneration = ++scrollbackGenerationRef.current;
    if (scrollbackWatchdogRef.current) clearTimeout(scrollbackWatchdogRef.current);
    scrollbackWatchdogRef.current = setTimeout(() => {
      scrollbackWatchdogRef.current = null;
      if (scrollbackGenerationRef.current === scrollbackGeneration && scrollbackPendingRef.current) {
        // Invalidate the generation so a merely-delayed (not dropped) afterWrite
        // or catch for this replay bails at its generation guard instead of
        // re-running fit / scroll / focus after we already force-recovered.
        scrollbackGenerationRef.current += 1;
        settleScrollback(true);
      }
    }, SCROLLBACK_WATCHDOG_MS);
    xtermRef.current.reset();

    // Resize-first: fit to container, then sync PTY dimensions before
    // fetching scrollback (clears stale buffer if cols changed). When
    // skipResize, the PTY is already synced; fit() is a no-op at the stable
    // width and we send no SIGWINCH.
    fitAddonRef.current.fit();
    const { cols, rows } = xtermRef.current;
    const sessionId = options.sessionId;

    // Parallel IPCs: same shape as initTerminal's mount-time path. Resize
    // forwards SIGWINCH on main; getScrollback is an in-memory read. When cols
    // changed, main waits for the agent TUI's repaint to settle before sampling
    // (see the initTerminal note), so the reload lands the fitted-width frame.
    // skipResize sends no SIGWINCH: the window manager calls it once resizing
    // has already settled, so there is nothing to wait for.
    const resizePromise = skipResize
      ? Promise.resolve(undefined)
      : window.electronAPI.sessions.resize(sessionId, cols, rows);
    const scrollbackPromise = window.electronAPI.sessions.getScrollback(sessionId);

    Promise.all([resizePromise, scrollbackPromise])
      .then(([, scrollback]) => {
        // A newer scrollback operation has started; it owns clearing pending
        // (and the watchdog it armed), so this stale resolve must not touch
        // either - clearing them here would open the drop/hold gate early
        // for the newer replay still in flight.
        if (scrollbackGenerationRef.current !== scrollbackGeneration) return;

        const afterWrite = () => {
          // A newer replay may have started (and armed its own watchdog,
          // which already canceled ours) while this chunked write was in
          // flight; abandon so we don't clobber its pending/fit/focus.
          if (scrollbackGenerationRef.current !== scrollbackGeneration) return;
          if (scrollbackWatchdogRef.current) {
            clearTimeout(scrollbackWatchdogRef.current);
            scrollbackWatchdogRef.current = null;
          }
          if (fitAddonRef.current) fitAddonRef.current.fit();
          // Restore saved scroll position (HMR) or pin to bottom
          if (xtermRef.current) {
            isAtBottomRef.current = restoreScrollPosition(xtermRef.current, options.sessionId);
          }
          // Flush any live bytes the incoming queue held during the reload
          // (see shouldHold in the queue effect below) now that the replay
          // frame is fully painted, so they apply strictly after it.
          settleScrollback(true);
          // Focus after the reload completes (unless the caller opted out).
          // No corrective resize: when a resize was sent above, main sampled
          // the settled frame; a same-dims resize is a no-op either way.
          if (!skipFocus) {
            requestAnimationFrame(() => {
              xtermRef.current?.focus();
            });
          }
        };
        if (scrollback && xtermRef.current) {
          // Chunked so a 512KB replay (tab/window switch, resize) doesn't parse
          // in one synchronous write that stalls the renderer mid-drag.
          // Strip OSC 52 so replaying recorded output never clobbers the live clipboard.
          // shouldAbort: see the matching call in initTerminal above.
          writeChunkedToTerminal(
            xtermRef.current,
            stripOsc52Sequences(scrollback),
            afterWrite,
            undefined,
            () => scrollbackGenerationRef.current !== scrollbackGeneration,
          );
        } else {
          afterWrite();
        }
      })
      .catch(() => {
        // IPC may reject if session was killed during the async gap.
        // Unblock onData so the terminal isn't permanently silenced.
        if (scrollbackGenerationRef.current !== scrollbackGeneration) return;
        if (scrollbackWatchdogRef.current) {
          clearTimeout(scrollbackWatchdogRef.current);
          scrollbackWatchdogRef.current = null;
        }
        settleScrollback(false);
      });
  }, [options.sessionId, settleScrollback]);

  // Reveal catch-up: when this session's terminal transitions parked ->
  // visible, repaint from scrollback. While parked, main dropped the session's
  // PTY data at the emit gate (focused-set narrowing) and this queue
  // acked-and-discarded any stragglers, so the xterm's content is stale; the
  // ring buffer has the truth. skipResize: the PTY was never resized while
  // parked (the window stayed mounted at its size). If the terminal has not
  // initialized yet, reloadScrollback's guards make this a no-op and the
  // mount-time replay paints instead.
  useEffect(() => {
    const sessionId = options.sessionId;
    if (!sessionId) return;
    return onTerminalReveal(sessionId, () => {
      reloadScrollback({ skipResize: true, skipFocus: true });
    });
  }, [options.sessionId, reloadScrollback]);

  const focus = useCallback(() => {
    xtermRef.current?.focus();
  }, []);

  // The terminal's current grid, read live off the xterm instance (the same
  // read flushResize already does). Used to seed a respawned PTY's dimensions
  // (e.g. a Command Terminal branch switch) so the new session starts at the
  // grid the user is already looking at instead of the spawn defaults.
  const getDimensions = useCallback((): { cols: number; rows: number } | null => {
    if (!xtermRef.current) return null;
    return { cols: xtermRef.current.cols, rows: xtermRef.current.rows };
  }, []);

  return {
    terminalRef,
    initTerminal,
    fit,
    flushResize,
    focus,
    reloadScrollback,
    scrollbackPending: scrollbackPendingRef,
    suppressDataRef,
    getDimensions,
  };
}

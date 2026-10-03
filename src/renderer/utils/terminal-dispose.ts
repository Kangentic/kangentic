/**
 * Turn a terminal's mouse reporting off so xterm drops the listeners it parked
 * on `document`. Call it on every opened `@xterm/xterm` Terminal before
 * `dispose()` (Sentry DESKTOP-1G).
 *
 * With mouse reporting on (Claude Code's fullscreen TUI sends `?1000h ?1002h
 * ?1003h ?1006h`), a mousedown on the terminal adds a `mouseup` listener to
 * `document`, plus a drag `mousemove` listener under `?1002h` / `?1003h`
 * (xterm 6.0.0 `CoreBrowserTerminal.bindMouse`). Neither is registered as a
 * disposable. Only two things remove them: that mouseup handler itself, AFTER
 * it reports the event, and the `onProtocolChange` subscription. Dispose a
 * terminal while one is pending and the next mouseup anywhere in the window
 * reports to a dead render service and throws at `RenderService.dimensions`,
 * before the removal runs. The listener then throws on every later click for
 * the life of the page and keeps the disposed terminal reachable.
 *
 * The listener does not need a button held at dispose time. In the field most
 * bursts start on the first click after the window regains focus: the listener
 * was armed long before (a release that never reached the page, such as a
 * right-click whose native menu opens on press on macOS and Linux), and the
 * terminal was disposed while the user was away. Switching the protocol to
 * NONE fires `onProtocolChange`, which removes both document listeners
 * whenever they were added.
 *
 * It has to happen synchronously, before `dispose()`, which tears down the
 * `onProtocolChange` subscription. That rules out writing `\x1b[?1000l`:
 * `write()` parses on a later task, after the terminal is already gone.
 */

/** The public fallback both `@xterm/xterm` and `@xterm/headless` terminals
 *  expose, so the unit tier can drive the helper with a headless terminal. */
export interface MouseTrackingHostTerminal {
  reset(): void;
}

/**
 * xterm has no public way to change the mouse protocol synchronously, so this
 * reads the private `_core`, as `terminal-grid-registry.ts` and
 * `src/renderer/addons/fit-addon.ts` do. The names survive minification in
 * the shipped bundle (its own `modes` getter reads
 * `this._core.coreMouseService.activeProtocol`).
 */
interface TerminalWithMouseService {
  _core?: { coreMouseService?: { activeProtocol: string } };
}

export function releaseMouseTracking(terminal: MouseTrackingHostTerminal): void {
  try {
    const mouseService = (terminal as unknown as TerminalWithMouseService)._core?.coreMouseService;
    if (mouseService) {
      mouseService.activeProtocol = 'NONE';
      return;
    }
    // A future xterm renamed the private service. `reset()` is public and
    // synchronous, and it resets the mouse service the same way, at the cost
    // of also clearing a buffer that is about to be thrown away.
    terminal.reset();
  } catch {
    // Teardown must never throw. A throw here would skip the dispose itself.
  }
}

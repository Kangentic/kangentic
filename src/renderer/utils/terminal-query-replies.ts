import type { IVtExtensions } from '@xterm/xterm';

/**
 * Keep the renderer terminal from answering the capability queries an agent
 * sends at boot. Call `swallowXtversionQuery` on every terminal whose `onData`
 * reaches a PTY, right after construction and before any write, and construct
 * it with `vtExtensions: TERMINAL_VT_EXTENSIONS`.
 *
 * Only the renderer xterm answers queries: `useTerminal`'s `onData` writes to
 * the PTY, and main's headless parser has no `onData` consumer. So whether a
 * session sees a reply depends on whether its terminal was on screen when the
 * agent booted. A reply that changes the agent's behaviour would split sessions
 * in two by that accident.
 *
 * XTVERSION (`CSI > q`) is that case. xterm answers it unconditionally since
 * 6.1 (xtermjs/xterm.js#5502), and Claude Code keys two behaviours on the one
 * handshake: sync-output awareness (DEC 2026) and its DECSTBM scroll region.
 * Measured with `claude --debug` up to 2.1.250 under xterm 6.0, it logged
 * `XTVERSION: no reply`, then `DECSTBM: gated` and
 * `DECRQM(2026): skipped (no XTVERSION reply)`. Opening the gate would also make
 * the replay scroll-region gap that `HeadlessFrameBuffer.scrollRegionSuffix`
 * guards against live. Turning XTVERSION on is its own decision, made with a
 * fresh `claude --debug` measurement, not a side effect of an xterm upgrade.
 *
 * The handler must be live before the first write, not only before the agent
 * boots. A raw scrollback replay re-parses the agent's boot bytes, and Claude
 * Code's carry the query (`\x1b[?u\x1b[>q`), so a late handler would type an
 * `ESC P >|xterm.js(...) ESC \` reply into a live agent's input.
 *
 * See .claude/rules/xterm-query-replies.md.
 */

/**
 * The optional VT extensions, each pinned off rather than left to xterm's
 * default. `colorSchemeQuery` defaults to TRUE in 6.1: it answers
 * `CSI ? 996 n` and, under DECSET 2031, pushes unsolicited color-scheme reports
 * into the PTY, the same split as XTVERSION. The kitty keyboard and
 * win32-input-mode protocols default to false today; naming them here keeps a
 * later default flip from turning either on silently.
 */
export const TERMINAL_VT_EXTENSIONS: Readonly<IVtExtensions> = {
  kittyKeyboard: false,
  win32InputMode: false,
  colorSchemeQuery: false,
};

/**
 * The parser surface `swallowXtversionQuery` needs. `@xterm/xterm` and
 * `@xterm/headless` declare nominally distinct `Terminal` types, and method
 * syntax compares parameters bivariantly, so both pass with no cast. The unit
 * tier drives the helper with a headless terminal.
 */
export interface CsiHandlerHostTerminal {
  parser: {
    registerCsiHandler(
      id: { prefix?: string; intermediates?: string; final: string },
      callback: (params: (number | number[])[]) => boolean,
    ): { dispose(): void };
  };
}

/**
 * Consume `CSI > q` before xterm's own handler sees it. A handler registered
 * later runs first, and returning true stops the chain, so xterm's reply never
 * fires. The registration lives as long as the terminal does.
 */
export function swallowXtversionQuery(terminal: CsiHandlerHostTerminal): void {
  terminal.parser.registerCsiHandler({ prefix: '>', final: 'q' }, () => true);
}

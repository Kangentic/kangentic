import { Unicode11Addon } from '@xterm/addon-unicode11';
import type { IUnicodeVersionProvider, Terminal as XtermTerminal } from '@xterm/xterm';

/**
 * One Unicode width table for every terminal parser in the app.
 *
 * xterm's built-in width table is Unicode V6, which scores modern emoji
 * (U+2705, U+274C, ...) as single width. Agent TUIs (Claude Code) pad each row
 * with spaces to the FULL terminal width counting those glyphs as double, and
 * reach the next row by autowrap rather than CR/LF - so under V6 every emoji
 * left the row one column short, the wrap fired one character late, and each
 * following row of the frame drifted one column further left (task #557).
 *
 * Every `new Terminal(` site must call `activateUnicode11` immediately after
 * construction, before any write or open, and hand-rolled parsers take their
 * widths from `wcwidthV11`. Lockstep matters more than the table itself: the
 * main-process headless parser serializes frames that renderer terminals (and
 * the phone's) replay with relative cursor moves, so two parsers disagreeing
 * on widths diverge worse than both being wrong together. Enforced by
 * tests/unit/xterm-unicode11-activation.test.ts; see
 * .claude/rules/xterm-unicode11-parity.md.
 */

/**
 * The minimal structural surface `activateUnicode11` needs. `@xterm/xterm` and
 * `@xterm/headless` declare nominally distinct `Terminal` / `ITerminalAddon`
 * types (the mismatch headless-frame.ts bridges with a cast for its serialize
 * addon), but method-syntax parameters compare bivariantly, so the `never`
 * addon parameter lets BOTH packages' terminals - and the `@xterm/xterm`-typed
 * `Unicode11Addon` - pass with no cast at any call site. `loadAddon` must stay
 * METHOD syntax: a property typed as a function is checked strictly, which
 * loses the bivariance this bridge depends on.
 */
export interface Unicode11HostTerminal {
  loadAddon(addon: { activate(terminal: never): void; dispose(): void }): void;
  unicode: { activeVersion: string };
}

/**
 * Switch a terminal to the Unicode 11 width table. Call immediately after
 * `new Terminal(...)`, before any write or `open()` - bytes already parsed
 * under V6 keep their V6 layout.
 *
 * Both lines are required: `loadAddon` only REGISTERS the provider (the
 * terminal stays on V6 without the second line), while setting `activeVersion`
 * to an unregistered version throws - so a registration that silently failed
 * cannot ship as a silent no-op. Requires `allowProposedApi: true` in the
 * constructor options (`unicode` is a proposed API).
 */
export function activateUnicode11(terminal: Unicode11HostTerminal): void {
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = '11';
}

/**
 * The addon publishes its table only through `activate`, which does exactly
 * `terminal.unicode.register(new UnicodeV11())` - so a stub terminal captures
 * the provider without constructing a real one.
 */
function captureUnicode11Provider(): IUnicodeVersionProvider {
  let captured: IUnicodeVersionProvider | undefined;
  const stub = {
    unicode: {
      register(provider: IUnicodeVersionProvider): void {
        captured = provider;
      },
    },
  };
  new Unicode11Addon().activate(stub as unknown as XtermTerminal);
  if (!captured) {
    throw new Error(
      'Unicode11Addon.activate registered no width provider; @xterm/addon-unicode11 changed shape',
    );
  }
  return captured;
}

const unicode11Provider = captureUnicode11Provider();

/**
 * Column width of one codepoint under the EXACT table the app's xterm
 * instances run (0 for controls and combining marks, 2 for wide glyphs).
 * Hand-rolled grid parsers (`src/main/pty/virtual-screen.ts`) use this instead
 * of their own ranges so they can never drift from the real terminals.
 */
export function wcwidthV11(codepoint: number): 0 | 1 | 2 {
  return unicode11Provider.wcwidth(codepoint);
}

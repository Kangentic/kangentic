import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { FitAddon } from '../../../addons/fit-addon';
import { buildTerminalTheme } from '../../../hooks/useTerminal';
import { useConfigStore } from '../../../stores/config-store';
import { rendererTerminalDefaults } from '../../../utils/native-terminal-defaults';
import { copySelectionToClipboard } from '../../../utils/terminal-clipboard';
import { resolveTerminalFontSize, resolveTerminalLineHeight } from '../../../utils/terminal-font-size';
import { swallowXtversionQuery, TERMINAL_VT_EXTENSIONS } from '../../../utils/terminal-query-replies';
import { activateUnicode11 } from '../../../../shared/xterm-unicode11';

/**
 * The terminal an account's sign-in runs in (task #1057). It shows an agent CLI's own login
 * (`claude auth login`), which is not an agent session: a raw PTY main owns, reached over the
 * `accounts:login*` channels, so `useTerminal` (which is a session's terminal) does not fit it.
 * Input here is a pasted code and Enter, so it rides ordinary IPC.
 *
 * It follows the same two rules every terminal that talks to a PTY does: Unicode 11 widths
 * (`xterm-unicode11-parity.md`) and no XTVERSION or optional VT replies
 * (`xterm-query-replies.md`), both before the first write.
 */
export function LoginTerminal({ loginId, label }: { loginId: string; label: string }) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalConfig = useConfigStore((state) => state.config.terminal);
  // Read once per sign-in: a font change mid sign-in is not worth a remount.
  const terminalConfigRef = useRef(terminalConfig);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return undefined;
    const settings = terminalConfigRef.current;
    const terminal = new Terminal({
      fontFamily: settings?.fontFamily || rendererTerminalDefaults().fontFamily,
      fontSize: resolveTerminalFontSize(settings?.fontSize),
      lineHeight: resolveTerminalLineHeight(settings?.lineHeight),
      theme: buildTerminalTheme(settings?.colors),
      cursorBlink: true,
      allowProposedApi: true,
      // No color-scheme, kitty keyboard, or win32-input replies into the PTY.
      vtExtensions: TERMINAL_VT_EXTENSIONS,
    });
    activateUnicode11(terminal);
    // Before any write: a CLI's boot bytes can carry the query.
    swallowXtversionQuery(terminal);
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(host);
    let disposed = false;

    const fit = (): void => {
      if (host.clientWidth === 0 || host.clientHeight === 0) return;
      fitAddon.fit();
      window.electronAPI.accounts.loginResize(loginId, terminal.cols, terminal.rows);
    };
    fit();
    const resizeObserver = new ResizeObserver(fit);
    resizeObserver.observe(host);

    const input = terminal.onData((data) => window.electronAPI.accounts.loginInput(loginId, data));

    // Paste and copy, in xterm's own key pipeline as the session terminals do it
    // (`terminal-clipboard.ts`). A sign-in whose browser cannot reach back to the CLI shows a
    // code to paste here, and xterm on its own sends Ctrl+V to the program as a control byte.
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== 'keydown') return true;
      const modifier = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      if (modifier && key === 'v') {
        event.preventDefault();
        void navigator.clipboard.readText().then((text) => {
          if (text && !disposed) terminal.paste(text);
        }).catch(() => undefined);
        return false;
      }
      // Ctrl+C copies a selection; with none it stays the program's interrupt.
      if (modifier && key === 'c' && (event.shiftKey || terminal.hasSelection())) {
        event.preventDefault();
        copySelectionToClipboard(terminal);
        terminal.clearSelection();
        return false;
      }
      return true;
    });

    // What the sign-in printed before this mounted, then its live output. Output that arrives
    // while the backlog is in flight is held and written after it, in order.
    let backlogWritten = false;
    const held: string[] = [];
    const stopOutput = window.electronAPI.accounts.onLoginOutput((outputLoginId, data) => {
      if (outputLoginId !== loginId || disposed) return;
      if (backlogWritten) terminal.write(data);
      else held.push(data);
    });
    void window.electronAPI.accounts.loginBacklog(loginId).then((backlog) => {
      if (disposed) return;
      // The held chunks are already at the end of the backlog main kept.
      terminal.write(backlog);
      backlogWritten = true;
      held.length = 0;
    }).catch(() => {
      backlogWritten = true;
      for (const chunk of held) terminal.write(chunk);
      held.length = 0;
    });

    // arrival-focus-ok: the dialog is modal and was opened for this sign-in by the user's own
    // click, so no other terminal arrives beside it, and a code the browser shows is pasted here.
    terminal.focus();

    return () => {
      disposed = true;
      stopOutput();
      input.dispose();
      resizeObserver.disconnect();
      terminal.dispose();
    };
  }, [loginId]);

  return (
    <div
      ref={hostRef}
      role="group"
      aria-label={label}
      className="h-[320px] w-full overflow-hidden rounded-md border border-edge"
      data-testid="account-login-terminal"
    />
  );
}

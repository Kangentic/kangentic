import { Terminal } from '@xterm/xterm';

/**
 * Clean a terminal selection string:
 * 1. Unwrap soft line breaks (lines that fill exactly `cols` are joined)
 * 2. Trim trailing whitespace from each line
 * 3. Trim leading/trailing empty lines
 */
export function cleanSelection(raw: string, cols: number): string {
  const lines = raw.split('\n');
  const result: string[] = [];
  let current = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    current += line;
    // If this line fills exactly the terminal width, the next line
    // is likely a soft wrap continuation -- join without a newline.
    if (line.length >= cols && i < lines.length - 1) {
      continue;
    }
    result.push(current.trimEnd());
    current = '';
  }
  if (current) result.push(current.trimEnd());

  return result.join('\n').trim();
}

/**
 * Enable clipboard copy support for an xterm.js Terminal instance.
 *
 * - Ctrl+C copies selected text instead of sending SIGINT (when selection exists)
 * - Ctrl+Shift+C always copies
 * - Right-click shows the browser's native context menu (with Copy)
 *
 * Call after `terminal.open(el)`.
 */
export function enableTerminalClipboard(
  terminal: Terminal,
  el: HTMLElement,
): void {
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;

    const isCopy =
      ((event.ctrlKey || event.metaKey) && event.key === 'c' && terminal.hasSelection()) ||
      ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key === 'C');

    if (isCopy) {
      const selection = terminal.getSelection();
      if (selection) {
        const cleaned = cleanSelection(selection, terminal.cols);
        if (cleaned) navigator.clipboard.writeText(cleaned);
      }
      return false;
    }

    // Ctrl+V / Cmd+V / Ctrl+Shift+V - paste from clipboard
    const isPaste =
      ((event.ctrlKey || event.metaKey) && event.key === 'v') ||
      ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key === 'V');

    if (isPaste) {
      navigator.clipboard.readText().then((text) => {
        if (text) terminal.paste(text);
      }).catch(() => { /* clipboard access denied */ });
      return false;
    }

    return true;
  });

  // Suppress xterm's built-in paste handler to prevent double-paste.
  // Our custom key handler above reads the clipboard and writes to the PTY
  // directly. Without this, the browser's paste event also reaches xterm's
  // internal textarea, causing xterm to send the pasted text through onData
  // a second time.
  const xtermTextarea = el.querySelector('.xterm-helper-textarea');
  if (xtermTextarea) {
    xtermTextarea.addEventListener('paste', (e) => {
      e.preventDefault();
      e.stopImmediatePropagation();
    }, true);
  }

  // Right-click: allow the browser's native context menu (Copy, etc.)
  // xterm.js suppresses the contextmenu event by default.
  // We capture it first and stop propagation so xterm doesn't prevent it.
  const xtermViewport = el.querySelector('.xterm-screen') || el;
  xtermViewport.addEventListener(
    'contextmenu',
    (e) => e.stopImmediatePropagation(),
    true,
  );
}

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

// ---------------------------------------------------------------------------
// Shell-aware path helpers (renderer-safe, no node:path dependency)
// ---------------------------------------------------------------------------

/**
 * True when the shell is Unix-like and expects POSIX-style paths.
 * Mirrors `isUnixLikeShell` from `src/shared/paths.ts` for renderer use.
 */
function isUnixLikeShell(shellName: string): boolean {
  const lower = shellName.toLowerCase();
  return !lower.includes('cmd') && !lower.includes('powershell') && !lower.includes('pwsh');
}

/**
 * Convert a Windows path to the format expected by the target shell.
 *
 * - WSL shells:        C:\Users\dev → /mnt/c/Users/dev
 * - Git Bash and other Unix-like: C:\Users\dev → /c/Users/dev
 * - cmd / PowerShell:  no conversion (native paths work)
 * - Non-Windows:       no conversion
 */
export function convertPathForShell(filePath: string, shellName: string): string {
  if (window.electronAPI.platform !== 'win32') return filePath;
  if (!isUnixLikeShell(shellName)) return filePath;

  const lower = shellName.toLowerCase();
  const prefix = lower.startsWith('wsl') ? '/mnt/' : '/';

  return filePath.replace(
    /^([A-Za-z]):(.*)/,
    (_match, drive: string, rest: string) =>
      `${prefix}${drive.toLowerCase()}${rest.replace(/\\/g, '/')}`,
  );
}

/**
 * Quote a file path for insertion into a terminal PTY.
 *
 * - Unix-like shells: single-quotes (no variable expansion)
 * - cmd / PowerShell: double-quotes with backtick/$ escaping
 * - No shell provided: simple space-only double-quoting (fallback)
 *
 * Mirrors `quoteArg` from `src/shared/paths.ts` for renderer use,
 * without the `node:path` or `process.platform` dependency.
 */
export function quoteForShell(filePath: string, shellName?: string): string {
  // Simple paths need no quoting (alphanumeric + common path chars).
  // Backslashes excluded - they're escape chars in Unix-like shells.
  // Regex matches quoteArg() in src/shared/paths.ts:161.
  if (/^[a-zA-Z0-9_./:-]+$/.test(filePath)) return filePath;

  if (!shellName) {
    // Fallback: quote if spaces present (best-effort without shell context)
    return filePath.includes(' ') ? `"${filePath}"` : filePath;
  }

  if (isUnixLikeShell(shellName)) {
    // Single-quotes, escape embedded single-quotes: ' → '\''
    return `'${filePath.replace(/'/g, "'\\''")}'`;
  }

  // PowerShell/cmd: double-quotes with backtick and $ escaping
  return `"${filePath.replace(/`/g, '``').replace(/\$/g, '`$').replace(/"/g, '\\"')}"`;
}

/**
 * Handle Ctrl+V / Cmd+V paste in the terminal.
 *
 * Priority 1: If the clipboard contains text, paste it into xterm.
 * Priority 2: If the clipboard contains an image (and no text), save it
 *   to a temp file and write the file path to the PTY so Claude Code
 *   can pick it up.
 */
async function handlePaste(
  terminal: Terminal,
  onWrite?: (data: string) => void,
  shellName?: string,
): Promise<void> {
  // Priority 1: text clipboard
  try {
    const text = await navigator.clipboard.readText();
    if (text) {
      terminal.paste(text);
      return;
    }
  } catch {
    // readText failed or denied - try image below
  }

  // Priority 2: image clipboard (only useful if we can write to PTY).
  // Read the image natively in the main process (Electron clipboard), which avoids
  // the document-focus requirement of the web clipboard API and behaves identically
  // across platforms, then write the saved file path to the PTY so Claude Code can
  // pick it up.
  if (!onWrite) return;

  try {
    let filePath = await window.electronAPI.clipboard.readImage();
    if (!filePath) return;
    if (shellName) filePath = convertPathForShell(filePath, shellName);
    onWrite(quoteForShell(filePath, shellName));
  } catch {
    // native clipboard read failed - silently fail
  }
}

/**
 * Enable clipboard copy support for an xterm.js Terminal instance.
 *
 * - Ctrl+C copies selected text instead of sending SIGINT (when a selection exists)
 * - Ctrl+Shift+C always copies the selection
 * - Ctrl+V / Cmd+V pastes text or image from clipboard
 * - Ctrl+Shift+V also pastes from clipboard
 * - Ctrl+Enter / Cmd+Enter sends a newline for the Claude Code TUI
 * - Right-click shows the browser's native context menu (with Copy)
 *
 * These combos are the embedded terminal's own; they are mirrored in the central
 * keybinding registry (`src/shared/keybindings.ts`) as `terminalUnsafe` entries so
 * the conflict checker can warn against assigning them to a global/dialog action.
 * Keep the two in sync; `tests/unit/keybindings-registry.test.ts` locks the set.
 *
 * `releaseEscapeWhenPointerOutside` (used by the task detail dialog) makes the
 * terminal decline Escape while the mouse pointer is outside its bounds, so the
 * event bubbles up and the containing dialog can close. While the pointer is
 * over the terminal, Escape is sent to the agent's TUI as usual.
 *
 * Call after `terminal.open(el)`.
 */
export function enableTerminalClipboard(
  terminal: Terminal,
  el: HTMLElement,
  onWrite?: (data: string) => void,
  shellName?: string,
  sessionId?: string,
  releaseEscapeWhenPointerOutside?: boolean,
): void {
  terminal.attachCustomKeyEventHandler((event) => {
    if (event.type !== 'keydown') return true;

    // Escape policy for a terminal embedded in a dialog (task detail). The
    // pointer-over-terminal test uses the live `:hover` state (el or any of its
    // descendants hovered):
    // - pointer outside the terminal: decline the key (return false) so it
    //   bubbles to the dialog and closes it. The agent does not receive Escape.
    // - pointer over the terminal: keep Escape for the agent's TUI and
    //   stopPropagation so the dialog's document listener does not also close it
    //   (xterm does not stop propagation on its own).
    if (releaseEscapeWhenPointerOutside && event.key === 'Escape') {
      if (!el.matches(':hover')) return false;
      event.stopPropagation();
      return true;
    }

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

    // Ctrl+V / Cmd+V / Ctrl+Shift+V - paste from clipboard (text or image)
    const isPaste =
      ((event.ctrlKey || event.metaKey) && event.key === 'v') ||
      ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key === 'V');

    if (isPaste) {
      handlePaste(terminal, onWrite, shellName).catch(() => { /* clipboard access denied */ });
      return false;
    }

    // Ctrl+Enter / Cmd+Enter: send LF (\n) instead of xterm's default CR (\r).
    // Real terminals send \n for Ctrl+Enter, which Claude Code's TUI interprets
    // as "new line in multiline input" rather than "submit prompt".
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && onWrite) {
      onWrite('\n');
      return false;
    }

    // Ctrl+C with no selection - xterm's default sends \x03 (SIGINT)
    // to the PTY. Notify the activity engine in parallel: gives it a
    // signal to recover quickly if the agent's PostToolUseFailure /
    // Stop hooks don't fire. Returning `true` lets xterm proceed with
    // its default \x03 behavior. Mac sends Cmd+C only as a copy
    // shortcut, never as SIGINT, so we restrict this to ctrlKey.
    if (event.ctrlKey && !event.metaKey && !event.shiftKey && event.key === 'c' && !terminal.hasSelection() && sessionId) {
      window.electronAPI.sessions.notifyUserInterrupt(sessionId).catch(() => {
        // Best-effort. The engine's 5-min stuck-pending-tools hatch
        // is the safety backstop if this IPC fails.
      });
      return true;
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

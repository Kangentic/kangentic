import { Terminal } from '@xterm/xterm';

// ---------------------------------------------------------------------------
// OSC 52 clipboard sequence handling
// ---------------------------------------------------------------------------

/**
 * Cap on the base64 payload of an OSC 52 write (~768KB of decoded text). Guards
 * against a malicious or runaway TUI streaming an enormous clipboard payload.
 */
const OSC52_MAX_BASE64_LENGTH = 1024 * 1024;

/**
 * Decode the data portion of an OSC 52 sequence ("<Pc>;<Pd>").
 *
 * Returns the decoded UTF-8 text for a write, or null for:
 * - a read request (`Pd === '?'`) - deliberately unsupported, so a TUI app can
 *   never READ the user's clipboard back out of the terminal,
 * - a missing separator, an empty payload, or an oversized payload,
 * - malformed base64.
 *
 * Pc (the clipboard selection: 'c', 'p', 's', combos, or empty) is ignored;
 * every write targets the system clipboard.
 */
export function decodeOsc52Payload(data: string): string | null {
  const separator = data.indexOf(';');
  if (separator === -1) return null;
  const payload = data.slice(separator + 1);
  if (!payload || payload === '?') return null;
  if (payload.length > OSC52_MAX_BASE64_LENGTH) return null;
  try {
    const binary = atob(payload);
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    const text = new TextDecoder().decode(bytes);
    return text || null;
  } catch {
    return null; // malformed base64
  }
}

/**
 * Matches complete OSC 52 sequences terminated by BEL, ESC\ (ST), C1 ST, or a
 * bare ESC that introduces the NEXT escape sequence. The bare-ESC case matters
 * because xterm's parser ends (and dispatches) an OSC string on any of
 * [0x9c, 0x1b, 0x18, 0x1a, 0x07] (EscapeSequenceParser transition table), so an
 * OSC 52 write followed directly by e.g. a CSI (`ESC[0m`) instead of a proper
 * BEL/ST is still dispatched on replay. The trailing `(?=\x1b)` alternative
 * matches that boundary with a zero-width lookahead, so the following escape
 * sequence is left intact for the terminal to interpret.
 */
const OSC52_SEQUENCE_RE = /\x1b\]52;[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c|(?=\x1b))/g;

/**
 * Remove OSC 52 sequences from recorded scrollback before replaying it into a
 * live terminal, so replaying a session that once copied text does not clobber
 * the user's CURRENT clipboard. Base64 never contains BEL/ESC/C1-ST, so the
 * payload match cannot over-run its terminator.
 */
export function stripOsc52Sequences(text: string): string {
  if (!text.includes('\x1b]52;')) return text; // fast path for the common replay
  return text.replace(OSC52_SEQUENCE_RE, '');
}

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
 * Copy the terminal's current selection to the system clipboard, cleaning soft
 * wraps first. Writes via the main process (window.electronAPI.clipboard.writeText),
 * which is focus- and permission-independent, rather than navigator.clipboard.writeText,
 * which rejects with NotAllowedError when the document lacks focus - exactly the state
 * during a native context-menu copy (Menu.popup steals document focus). Best-effort: a
 * failed write is swallowed. No-op when there is no selection.
 */
export function copySelectionToClipboard(terminal: Terminal): void {
  // Clean the raw selection: unwrap soft line breaks and trim surrounding blank lines.
  const cleaned = cleanSelection(terminal.getSelection(), terminal.cols);
  if (cleaned) window.electronAPI.clipboard.writeText(cleaned).catch(() => { /* best-effort */ });
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
 * Format the text injected into the PTY for a captured (pasted or dropped)
 * image file. With no template, this is just the bare shell-quoted path
 * (legacy behavior for adapters that have not declared
 * `pastedImageReferenceTemplate`). With a template, `{path}` is replaced by
 * the quoted path; a template lacking `{path}` has the quoted path appended.
 */
export function formatImageReference(quotedPath: string, template?: string): string {
  if (!template) return quotedPath;
  return template.includes('{path}')
    ? template.split('{path}').join(quotedPath)
    : `${template} ${quotedPath}`;
}

/**
 * Handle Ctrl+V / Cmd+V paste in the terminal.
 *
 * Priority 1: If the clipboard contains text, paste it into xterm.
 * Priority 2: If the clipboard contains an image (and no text), save it
 *   to a temp file and write a reference to it (see `formatImageReference`)
 *   to the PTY so the agent reliably reads it as an image.
 */
async function handlePaste(
  terminal: Terminal,
  onWrite?: (data: string) => void,
  shellName?: string,
  getImageReferenceTemplate?: () => string | undefined,
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
  // across platforms (and, unlike the agent CLI's own clipboard reader, reliably
  // captures a Windows Snipping Tool image), then write a reference to the saved
  // file path to the PTY so the agent picks it up as an image.
  if (!onWrite) return;

  try {
    let filePath = await window.electronAPI.clipboard.readImage();
    if (!filePath) return;
    if (shellName) filePath = convertPathForShell(filePath, shellName);
    const quotedPath = quoteForShell(filePath, shellName);
    onWrite(formatImageReference(quotedPath, getImageReferenceTemplate?.()));
  } catch {
    // native clipboard read failed - silently fail
  }
}

/**
 * Enable clipboard copy support for an xterm.js Terminal instance.
 *
 * - OSC 52 write sequences (ESC]52;c;<base64>BEL) from a TUI app write the system
 *   clipboard. This is how Claude Code's TUI copies a mouse selection; without a
 *   handler xterm silently drops the sequence. Write-only: read requests (Pd '?')
 *   are ignored so a TUI can never read the user's clipboard.
 * - Ctrl+C copies selected text instead of sending SIGINT (when a selection exists)
 * - Ctrl+Shift+C always copies the selection
 * - Ctrl+V / Cmd+V pastes text or image from clipboard
 * - Ctrl+Shift+V also pastes from clipboard
 * - Ctrl+Enter / Cmd+Enter sends a newline for the Claude Code TUI
 * - Backspace sends Ctrl+H (0x08) instead of DEL (0x7f), when enabled
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
  getImageReferenceTemplate?: () => string | undefined,
  getBackspaceSendsCtrlH?: () => boolean,
): void {
  // OSC 52 clipboard writes (write-only). Claude Code's TUI copies a selection by
  // emitting ESC]52;c;<base64>BEL alongside a fire-and-forget PowerShell Set-Clipboard;
  // without this handler the OSC channel is silently dropped and copy fails entirely on
  // machines where the PowerShell path fails. Read requests (Pd === '?') are deliberately
  // never answered - answering would let any TUI app silently read the user's clipboard.
  // The write routes through the main process (window.electronAPI.clipboard.writeText),
  // which is focus- and permission-independent unlike navigator.clipboard.writeText.
  // Disposed automatically with the terminal.
  terminal.parser.registerOscHandler(52, (data) => {
    const text = decodeOsc52Payload(data);
    if (text) {
      window.electronAPI.clipboard.writeText(text).catch(() => { /* best-effort */ });
    }
    return true; // consume the sequence either way
  });

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
      copySelectionToClipboard(terminal);
      return false;
    }

    // Ctrl+V / Cmd+V / Ctrl+Shift+V - paste from clipboard (text or image)
    const isPaste =
      ((event.ctrlKey || event.metaKey) && event.key === 'v') ||
      ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key === 'V');

    if (isPaste) {
      handlePaste(terminal, onWrite, shellName, getImageReferenceTemplate).catch(() => { /* clipboard access denied */ });
      return false;
    }

    // Ctrl+Enter / Cmd+Enter: send LF (\n) instead of xterm's default CR (\r).
    // Real terminals send \n for Ctrl+Enter, which Claude Code's TUI interprets
    // as "new line in multiline input" rather than "submit prompt".
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && onWrite) {
      onWrite('\n');
      return false;
    }

    // Backspace -> Ctrl+H (0x08) instead of xterm's default DEL (0x7f), when enabled.
    // Native Windows conhost sends 0x08 for plain Backspace, which Claude Code's TUI
    // reads as a modified backspace and routes to delete-word-before. Shells still
    // treat ^H as a single-char backspace via readline/PSReadLine. Modified Backspace
    // (Ctrl/Alt/Meta) is excluded so Ctrl+Backspace (already 0x08) and Alt+Backspace
    // (ESC 0x7f) keep their existing behavior unchanged.
    if (
      event.key === 'Backspace' &&
      !event.ctrlKey && !event.altKey && !event.metaKey &&
      onWrite && getBackspaceSendsCtrlH?.()
    ) {
      onWrite('\x08');
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

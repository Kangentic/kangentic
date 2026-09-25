import { Terminal } from '@xterm/xterm';
import { SerializeAddon } from '@xterm/addon-serialize';
import { activateUnicode11 } from '../../shared/xterm-unicode11';

/**
 * Creates a browser-based xterm ANSI filter for the aggregate terminal.
 *
 * Uses a real xterm.js terminal (hidden off-screen) to process all escape
 * sequences (cursor movement, screen clears, scroll regions, etc.), then
 * serializes the visible screen and diffs against the previous snapshot
 * to emit only genuinely new/changed content.
 *
 * Writes are debounced (32ms) so that multi-chunk TUI redraws are processed
 * atomically instead of emitting intermediate screen states.
 */

// Shared hidden container -- pointer-events:none prevents interference
// with the visible aggregate terminal's text selection / copy.
let hiddenContainer: HTMLDivElement | null = null;

function getHiddenContainer(): HTMLDivElement {
  if (!hiddenContainer) {
    hiddenContainer = document.createElement('div');
    hiddenContainer.style.cssText =
      'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;' +
      'overflow:hidden;opacity:0;pointer-events:none';
    hiddenContainer.setAttribute('aria-hidden', 'true');
    document.body.appendChild(hiddenContainer);
  }
  return hiddenContainer;
}

// Lines consisting only of box-drawing characters (U+2500-U+257F),
// spaces, dashes, equals, and underscores -- TUI decorative borders.
const DECORATIVE_RE = /^[\u2500-\u257F\s\-=_·•─]+$/;

export function createAnsiFilter(): {
  filter: (data: string, callback: (filtered: string) => void) => void;
  dispose: () => void;
} {
  const container = getHiddenContainer();
  const el = document.createElement('div');
  el.style.cssText = 'width:800px;height:400px';
  container.appendChild(el);

  // No `linkHandler` here, unlike useTerminal's real terminal: this instance is
  // a headless serializer sink parked off-screen with pointer-events:none, so an
  // OSC 8 hyperlink can never be activated in it. If this terminal ever becomes
  // user-visible or interactive, wire createTerminalLinkHandler in - otherwise a
  // link activation would fall through to xterm's built-in window.open fallback.
  const term = new Terminal({
    cols: 120,
    rows: 40,
    scrollback: 200,
    allowProposedApi: true,
  });
  // Unicode 11 widths, matching every other terminal parser in the app, so
  // emoji-bearing rows wrap where the producing TUI padded them to.
  activateUnicode11(term);
  const serializer = new SerializeAddon();
  term.loadAddon(serializer);
  term.open(el);

  let lastLines: string[] = [];
  let pendingCallback: ((filtered: string) => void) | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  function flush() {
    const raw = serializer.serialize({ excludeModes: true, excludeAltBuffer: true });

    // Normalize: trim each line, drop empty trailing lines
    const newLines = raw.split('\n').map((l) => l.trimEnd());
    while (newLines.length > 0 && newLines[newLines.length - 1] === '') {
      newLines.pop();
    }

    // Find the longest common prefix (unchanged lines at the top).
    // When the TUI redraws, only the changed lines differ.
    let common = 0;
    const min = Math.min(newLines.length, lastLines.length);
    for (let i = 0; i < min; i++) {
      if (newLines[i] === lastLines[i]) common++;
      else break;
    }

    // Nothing new?
    if (common === newLines.length && newLines.length === lastLines.length) {
      if (pendingCallback) pendingCallback('');
      pendingCallback = null;
      return;
    }

    lastLines = newLines.slice(); // snapshot

    // Emit lines after the common prefix, filtering artifacts
    const output = newLines
      .slice(common)
      .filter((l) => l.length > 0)
      .filter((l) => !DECORATIVE_RE.test(l))
      .join('\n');

    if (pendingCallback) pendingCallback(output);
    pendingCallback = null;
  }

  return {
    filter(data: string, callback: (filtered: string) => void): void {
      pendingCallback = callback;
      term.write(data);

      // Debounce: multi-chunk TUI redraws are processed atomically
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        flush();
      }, 32);
    },

    dispose() {
      if (debounceTimer !== null) clearTimeout(debounceTimer);
      serializer.dispose();
      term.dispose();
      el.remove();
    },
  };
}

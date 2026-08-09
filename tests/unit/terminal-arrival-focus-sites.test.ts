import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Enforces .claude/rules/terminal-arrival-focus.md. Every programmatic focus on an ARRIVING
// terminal (deferred init, mount replay, a reload the caller did not opt out of) must be
// arbitrated, or two terminals mounting together race and whichever replay settles last takes the
// user's keystrokes. Genuinely user-initiated focus stays unconditional and opts out with a
// `// arrival-focus-ok: <reason>` marker on the call line or the line above.
//
// Scope is the terminal HOSTS: files that call `useTerminal(` or reach for an xterm textarea
// directly. A focus call anywhere else in the renderer (form fields, dialogs, menus) is unrelated
// to this rule and is not scanned.
//
// The pattern deliberately matches a BARE `focus()` as well as `.focus()`. Three real sites call a
// destructured `focus` with no receiver (`TerminalTab`'s active effect, `CommandTerminalPane`'s
// onInit, `useTerminalFileDrop`'s `focusTerminal()`), so a `\.focus\(\)`-only scan would pass
// vacuously over exactly the sites this rule exists to protect.

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCAN_DIR = 'src/renderer';
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const OK_MARKER = /arrival-focus-ok/;
const ARBITER_GUARD = /mayTakeArrivalFocus|mayFocusOnArrival/;

/** The arbiter itself, and the hook option's own plumbing, are not call sites. */
const EXEMPT_FILES = new Set([
  'src/renderer/utils/terminal-arrival-focus.ts',
]);

/** A file is a terminal host if it constructs a terminal, reaches for its textarea, or is handed
 *  a terminal's focus function to call. */
function isTerminalHost(source: string): boolean {
  return source.includes('useTerminal(')
    || source.includes('.xterm-helper-textarea')
    || source.includes('focusTerminal');
}

/** `focus()` / `focusTerminal()` / `something.focus()`, but not `onFocus(` or `focusWindow(`. */
const FOCUS_CALL = /\b(?:focus|focusTerminal)\s*\(\s*\)/g;

/** Prose mentioning `focus()` is not a call site. Strips line comments and skips block-comment
 *  bodies, so only real code is matched. The `arrival-focus-ok` marker is still read from the
 *  ORIGINAL line, since it lives in exactly the comment this removes. */
function codeOnly(line: string): string {
  const trimmed = line.trim();
  if (trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('//')) return '';
  const commentIndex = line.indexOf('//');
  return commentIndex >= 0 ? line.slice(0, commentIndex) : line;
}

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function toPosix(relativePath: string): string {
  return relativePath.replace(/\\/g, '/');
}

describe('every arrival focus in a terminal host is arbitrated', () => {
  it('no unguarded, unmarked focus call in a terminal-host file', () => {
    const offenders: string[] = [];

    for (const filePath of collectSourceFiles(path.join(REPO_ROOT, SCAN_DIR))) {
      const relative = toPosix(path.relative(REPO_ROOT, filePath));
      if (EXEMPT_FILES.has(relative)) continue;

      const source = fs.readFileSync(filePath, 'utf8');
      if (!isTerminalHost(source)) continue;

      const lines = source.split('\n');
      lines.forEach((line, index) => {
        FOCUS_CALL.lastIndex = 0;
        if (!FOCUS_CALL.test(codeOnly(line))) return;

        // The guard may sit on the same line (`if (initialized.current && mayFocusOnArrival())`)
        // or on the line just above (the ref check inside a requestAnimationFrame body). An
        // opt-out marker may sit anywhere in the contiguous comment block directly above, since a
        // one-line reason is rarely enough to say WHY a focus is user-initiated.
        const context = [line];
        for (let above = index - 1; above >= 0; above--) {
          const trimmed = lines[above].trim();
          const isComment = trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
          if (!isComment && context.length > 1) break;
          context.unshift(lines[above]);
          if (!isComment) break;
        }
        const block = context.join('\n');
        if (ARBITER_GUARD.test(block)) return;
        if (OK_MARKER.test(block)) return;

        offenders.push(`${relative}:${index + 1}  ${line.trim()}`);
      });
    }

    expect(
      offenders,
      'Arrival focus must route through mayTakeArrivalFocus (see .claude/rules/terminal-arrival-focus.md).\n'
        + 'If this focus follows a real user gesture, mark it `// arrival-focus-ok: <reason>`.\n'
        + `Unguarded:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('every useTerminal host passes the arrival-focus policy', () => {
    // The focus-call scan above cannot see this gap. `useTerminal` owns two arrival
    // frames of its own (the mount replay and the reload), and both read the option
    // as `mayTakeArrivalFocusRef.current?.() === false` - so an ABSENT option is
    // `undefined === false`, i.e. allow. A new host that mounts useTerminal and never
    // calls the returned `focus` itself would therefore contain no focus call to
    // flag, pass the scan vacuously, and still take arrival focus unconditionally.
    const offenders: string[] = [];

    for (const filePath of collectSourceFiles(path.join(REPO_ROOT, SCAN_DIR))) {
      const relative = toPosix(path.relative(REPO_ROOT, filePath));
      // The hook itself declares the option; it does not pass one.
      if (relative === 'src/renderer/hooks/useTerminal.ts') continue;

      const source = fs.readFileSync(filePath, 'utf8');
      if (!source.includes('useTerminal(')) continue;
      if (source.includes('mayTakeArrivalFocus')) continue;

      offenders.push(relative);
    }

    expect(
      offenders,
      'A useTerminal() host must pass the `mayTakeArrivalFocus` option (see '
      + '.claude/rules/terminal-arrival-focus.md). Omitting it silently restores the '
      + `unconditional arrival focus this rule exists to prevent.\nMissing:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('scans the terminal hosts it is meant to cover', () => {
    // The scan is a no-op if `isTerminalHost` stops matching (a renamed hook, a moved file), and a
    // no-op scan passes silently. Pin the hosts so that failure is loud.
    const expectedHosts = [
      'src/renderer/hooks/useTerminal.ts',
      'src/renderer/hooks/useTerminalFileDrop.ts',
      'src/renderer/components/terminal/TerminalTab.tsx',
      'src/renderer/components/command-bar/CommandTerminalPane.tsx',
      'src/renderer/window-manager/components/WindowFrame.tsx',
      'src/renderer/window-manager/components/TaskDetailWindow.tsx',
      'src/renderer/window-manager/bridge/useWindowFocusReconcile.ts',
    ];

    const scanned = new Set(
      collectSourceFiles(path.join(REPO_ROOT, SCAN_DIR))
        .filter((filePath) => isTerminalHost(fs.readFileSync(filePath, 'utf8')))
        .map((filePath) => toPosix(path.relative(REPO_ROOT, filePath))),
    );

    const missing = expectedHosts.filter((host) => !scanned.has(host));
    expect(missing, `These terminal hosts are no longer being scanned: ${missing.join(', ')}`).toEqual([]);
  });
});

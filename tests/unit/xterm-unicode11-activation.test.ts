/**
 * Unicode 11 activation guard (task #557).
 *
 * xterm's built-in width table is Unicode V6, which scores modern emoji as
 * single width. Agent TUIs pad rows to the full terminal width counting them
 * double and reach the next row by autowrap, so a V6 parser wraps one
 * character late per emoji and every following row of the frame drifts one
 * column left. Worse than the drift itself is a MISMATCH: main's headless
 * parser serializes frames that renderer terminals replay, so two parsers on
 * different tables diverge (the replay stops matching the live view).
 *
 * Three checks keep every parser on one table:
 * 1. Site scan: every `new Terminal(` under src/ (INCLUDING src/devtools -
 *    the forensics re-parse diagnoses the other parsers and must not lie)
 *    calls activateUnicode11 from src/shared/xterm-unicode11.ts.
 * 2. The helper actually switches the table (loadAddon alone is a no-op).
 * 3. virtual-screen.ts takes its widths from wcwidthV11, not its own ranges.
 *
 * This scan is also the ONLY mechanical coverage for ansi-filter.ts, which
 * needs a DOM and cannot run in this tier. Behavioral red/green coverage
 * lives in headless-frame.test.ts ('Unicode 11 width parity') and the
 * VirtualScreen cases in claude-model-picker-probe.test.ts.
 *
 * See .claude/rules/xterm-unicode11-parity.md.
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Terminal } from '@xterm/headless';
import { activateUnicode11, wcwidthV11 } from '../../src/shared/xterm-unicode11';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SOURCE_ROOT = path.join(REPO_ROOT, 'src');
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const HELPER_RELATIVE_PATH = 'src/shared/xterm-unicode11.ts';

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

function isCommentLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

/**
 * Drop inline comment text from a code line, so a trailing
 * `// activateUnicode11(...) below` note on a construction line cannot count
 * as a real activation and silently satisfy the scan. Naive about `//` inside
 * string literals, which errs toward counting FEWER activations - a loud
 * false failure, never a silent pass.
 */
function stripInlineComments(line: string): string {
  return line.replace(/\/\*.*?\*\//gu, '').replace(/\/\/.*$/u, '');
}

function countMatches(lines: string[], pattern: RegExp): number {
  let count = 0;
  for (const line of lines) {
    if (isCommentLine(line)) continue;
    count += [...stripInlineComments(line).matchAll(pattern)].length;
  }
  return count;
}

describe('xterm Unicode 11 activation', () => {
  it('every `new Terminal(` construction site activates Unicode 11 via the shared helper', () => {
    const violations: string[] = [];
    for (const filePath of collectSourceFiles(SOURCE_ROOT)) {
      const relativePath = path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
      if (relativePath === HELPER_RELATIVE_PATH) continue;
      const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
      const constructions = countMatches(lines, /\bnew Terminal\s*\(/g);
      if (constructions === 0) continue;
      const activations = countMatches(lines, /\bactivateUnicode11\s*\(/g);
      const importsHelper = lines.some(
        (line) => !isCommentLine(line) && stripInlineComments(line).includes('shared/xterm-unicode11'),
      );
      if (!importsHelper || activations < constructions) {
        violations.push(
          `${relativePath}: ${constructions} \`new Terminal(\` but ` +
          `${activations} activateUnicode11(...) call(s)` +
          (importsHelper ? '' : ' and no import of shared/xterm-unicode11'),
        );
      }
    }
    expect(
      violations,
      'Every xterm Terminal must call activateUnicode11(terminal) immediately after ' +
      'construction (before any write or open), or its row layout drifts one column left ' +
      'per emoji against every other terminal parser in the app. ' +
      'See .claude/rules/xterm-unicode11-parity.md.',
    ).toEqual([]);
  });

  it('activateUnicode11 switches a real terminal to the Unicode 11 table', () => {
    const terminal = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
    expect(terminal.unicode.activeVersion).toBe('6');
    activateUnicode11(terminal);
    expect(terminal.unicode.activeVersion).toBe('11');
    terminal.dispose();
  });

  it('fails fast at module load if the addon never registers a width provider', async () => {
    // vi.doMock (not the hoisted vi.mock) so only THIS test's dynamic import
    // sees the fake addon; the file's other tests import activateUnicode11
    // and wcwidthV11 from the static top-level import and need the real
    // addon's real width table, unaffected by this test's mock.
    vi.doMock('@xterm/addon-unicode11', () => ({
      Unicode11Addon: class {
        activate(): void {
          // Deliberately never calls terminal.unicode.register, standing in
          // for an @xterm/addon-unicode11 release that changed activate()'s
          // shape.
        }
        dispose(): void {}
      },
    }));
    try {
      vi.resetModules();
      await expect(import('../../src/shared/xterm-unicode11')).rejects.toThrow(
        /registered no width provider/,
      );
    } finally {
      vi.doUnmock('@xterm/addon-unicode11');
      vi.resetModules();
    }
  });

  it('wcwidthV11 scores the width classes the drift bug hinges on', () => {
    expect(wcwidthV11(0x41)).toBe(1);     // 'A'
    expect(wcwidthV11(0x2705)).toBe(2);   // the check mark that drifted the frames
    expect(wcwidthV11(0x274c)).toBe(2);   // the cross mark from the same capture
    expect(wcwidthV11(0xfe0f)).toBe(0);   // VS16, a combining mark
    expect(wcwidthV11(0x1f600)).toBe(2);  // astral emoji
  });

  it('virtual-screen.ts takes its widths from wcwidthV11, never its own ranges', () => {
    const source = fs.readFileSync(
      path.join(SOURCE_ROOT, 'main', 'pty', 'virtual-screen.ts'),
      'utf-8',
    );
    expect(
      source.includes('wcwidthV11'),
      'VirtualScreen must import wcwidthV11 from src/shared/xterm-unicode11.ts so its grid ' +
      'can never disagree with the xterm parsers about a character width.',
    ).toBe(true);
  });
});

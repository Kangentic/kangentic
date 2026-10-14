import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';
import { Terminal } from '@xterm/headless';
import {
  registerTerminalCapture,
  unregisterTerminalCapture,
  captureTerminalScrollback,
  readViewportLines,
} from '../../src/renderer/utils/terminal-capture-registry';
import { activateUnicode11 } from '../../src/shared/xterm-unicode11';

function writeAndFlush(terminal: Terminal, data: string): Promise<void> {
  return new Promise<void>((resolve) => {
    terminal.write(data, () => resolve());
  });
}

/**
 * `unregisterTerminalCapture` must be safe against a STALE unmount cleanup
 * firing after a newer mount has already registered its own reader for the
 * same session id - the exact race that let the open-at-TUI-position feature
 * silently end up with no reader registered at all (see the bottom-panel /
 * task-dialog terminal ownership handoff, and React StrictMode's dev-only
 * double-invoke cleanup).
 */
describe('terminal-capture-registry identity-guarded unregister', () => {
  const sessionId = 'sess-registry-test';

  beforeEach(() => {
    unregisterTerminalCapture(sessionId);
  });

  it('captures the registered reader for a session', () => {
    const reader = () => ({ visibleLines: ['hello'], atBottom: false });
    registerTerminalCapture(sessionId, reader);

    expect(captureTerminalScrollback(sessionId)).toEqual({ visibleLines: ['hello'], atBottom: false });
  });

  it('unregisters by identity: a stale reader does not clobber a newer registration', () => {
    const staleReader = () => ({ visibleLines: ['stale'], atBottom: true });
    const freshReader = () => ({ visibleLines: ['fresh'], atBottom: false });

    registerTerminalCapture(sessionId, staleReader);
    registerTerminalCapture(sessionId, freshReader);

    // The stale mount's cleanup fires AFTER the fresh mount already
    // registered - it must not delete the fresh registration.
    unregisterTerminalCapture(sessionId, staleReader);

    expect(captureTerminalScrollback(sessionId)).toEqual({ visibleLines: ['fresh'], atBottom: false });
  });

  it('unregisters normally when the identity matches the current reader', () => {
    const reader = () => ({ visibleLines: ['only'], atBottom: true });
    registerTerminalCapture(sessionId, reader);

    unregisterTerminalCapture(sessionId, reader);

    expect(captureTerminalScrollback(sessionId)).toBeNull();
  });

  it('falls back to an unconditional delete when no reader is passed', () => {
    const reader = () => ({ visibleLines: ['x'], atBottom: false });
    registerTerminalCapture(sessionId, reader);

    unregisterTerminalCapture(sessionId);

    expect(captureTerminalScrollback(sessionId)).toBeNull();
  });

  it('returns null for a session with no registered reader, or when the reader itself throws', () => {
    expect(captureTerminalScrollback('sess-never-registered')).toBeNull();
    expect(captureTerminalScrollback(null)).toBeNull();

    registerTerminalCapture(sessionId, () => {
      throw new Error('boom');
    });
    expect(captureTerminalScrollback(sessionId)).toBeNull();
  });
});

/**
 * xterm never trims alt-buffer lines on a column shrink (it trims only inside
 * its reflow branch, and the alt buffer has no scrollback), so a renderer
 * terminal whose fullscreen TUI was narrowed keeps the old width's cells past
 * `cols`. They are not on screen, so the viewport reader must not return them.
 * The conversation anchor matches these lines against the transcript.
 */
describe('readViewportLines', () => {
  it('returns only the first cols cells of each row after a shrink inside the alt screen', async () => {
    const terminal = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
    activateUnicode11(terminal);
    await writeAndFlush(
      terminal,
      '\x1b[?1049h\x1b[1;1Hwide row zero\x1b[2;1Hwide row one\x1b[3;1Hwide row two\x1b[4;1Hwide row three',
    );
    terminal.resize(10, 4);

    expect(readViewportLines(terminal)).toEqual(['wide row z', 'wide row o', 'wide row t', 'wide row t']);

    terminal.dispose();
  });

  it('keeps written trailing spaces and drops never-written cells, as translateToString(true) does', async () => {
    const terminal = new Terminal({ cols: 10, rows: 2, allowProposedApi: true });
    activateUnicode11(terminal);
    await writeAndFlush(terminal, 'ab  \r\ncd');

    expect(readViewportLines(terminal)).toEqual(['ab  ', 'cd']);

    terminal.dispose();
  });
});

/**
 * Static pins for the three call sites that adopted the cut. None of them can be driven at the
 * unit tier. `useTerminal` needs a real DOM and a live xterm. `terminal-grid-registry` fills its
 * registry only inside `registerDevtoolsTerminal`, which `vitest.config.ts` compiles to a no-op,
 * because `__KANGENTIC_DEV__` is a transform-time `false` there.
 *
 * The scan reads the TypeScript AST, so a comment that quotes the old form and the
 * `ViewportReadableTerminal` signature are not calls. It fires only when a read goes back to a
 * `translateToString` call with no end column, which is the shape every site had before the fix.
 * The scope is these three files. A scan of all of `src/renderer` would be a new repo-wide
 * convention and would need its own rule file.
 */
describe('renderer viewport reads are cut to the grid at every call site', () => {
  const REPO_ROOT = path.resolve(__dirname, '../..');
  const HELPER_FILE = 'src/renderer/utils/terminal-capture-registry.ts';
  const GRID_REGISTRY_FILE = 'src/renderer/utils/terminal-grid-registry.ts';
  const VIEWPORT_READING_FILES = [HELPER_FILE, GRID_REGISTRY_FILE, 'src/renderer/hooks/useTerminal.ts'];

  interface TranslateToStringScan {
    /** Every `x.translateToString` access. */
    reads: number;
    /** One `file:line` entry per access that is not a call with an end column. */
    uncut: string[];
  }

  function readRepoSource(relativePath: string): string {
    return fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf8');
  }

  /** With no end column, xterm reads to `line.length`, which includes the stale off-grid cells. */
  function scanTranslateToStringReads(source: string, fileLabel: string): TranslateToStringScan {
    const sourceFile = ts.createSourceFile(fileLabel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const scan: TranslateToStringScan = { reads: 0, uncut: [] };
    const visit = (node: ts.Node): void => {
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'translateToString') {
        scan.reads += 1;
        const call = node.parent;
        const hasEndColumn = ts.isCallExpression(call) && call.expression === node && call.arguments.length >= 3;
        if (!hasEndColumn) {
          const lineNumber = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
          scan.uncut.push(`${fileLabel}:${lineNumber}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    return scan;
  }

  it('flags a read with no end column and ignores the same text in a comment', () => {
    const source = [
      '/** Reads with `line.translateToString(true)` as xterm does. */',
      'const uncut = line.translateToString(true);',
      'const cut = line?.translateToString(true, 0, terminal.cols);',
    ].join('\n');

    expect(scanTranslateToStringReads(source, 'snippet.ts')).toEqual({ reads: 2, uncut: ['snippet.ts:2'] });
  });

  it.each(VIEWPORT_READING_FILES)('%s passes an end column to every translateToString call', (relativePath) => {
    const { uncut } = scanTranslateToStringReads(readRepoSource(relativePath), relativePath);

    expect(
      uncut,
      'A viewport read went back to translateToString without an end column, so after a column '
      + 'shrink inside the alt screen it returns cells past `cols` that are not on screen. Read '
      + 'through `readViewportLines`, or pass `terminal.cols` as the third argument.',
    ).toEqual([]);
  });

  it('still finds the direct reads it pins', () => {
    // A scan that matches nothing passes silently. The helper's own read and the whole-buffer
    // count in the devtools grid report are the two direct reads left.
    for (const relativePath of [HELPER_FILE, GRID_REGISTRY_FILE]) {
      expect(scanTranslateToStringReads(readRepoSource(relativePath), relativePath).reads, relativePath).toBeGreaterThan(0);
    }
  });
});

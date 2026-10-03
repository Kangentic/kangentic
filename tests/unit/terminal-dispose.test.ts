/**
 * Mouse tracking is released before an opened xterm is disposed (Sentry DESKTOP-1G).
 *
 * With mouse reporting on, xterm parks a `mouseup` (and, under ?1002h / ?1003h, a
 * drag `mousemove`) listener on `document` that only its own handler or a protocol
 * change removes. Disposing the terminal while one is pending made every later click
 * in the window throw at `RenderService.dimensions`. `releaseMouseTracking` switches
 * the protocol to NONE first, which removes them.
 *
 * The unit tier has no DOM, so the behavior cases drive a real `@xterm/headless`
 * terminal, which shares xterm's CoreMouseService. It cannot show the document
 * listeners themselves: tests/ui/terminal-dispose-mouse-tracking.spec.ts does that
 * against the browser bundle. See .claude/rules/xterm-dispose-releases-mouse.md.
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { Terminal } from '@xterm/headless';
import { releaseMouseTracking } from '../../src/renderer/utils/terminal-dispose';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCAN_ROOTS = [path.join(REPO_ROOT, 'src'), path.join(REPO_ROOT, 'demo')];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const USE_TERMINAL_PATH = path.join(REPO_ROOT, 'src', 'renderer', 'hooks', 'useTerminal.ts');

/** What Claude Code's fullscreen TUI sends: click, drag, any-motion, SGR encoding. */
const CLAUDE_MOUSE_MODES = '\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1006h';

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

/** Source with comment lines and inline comments dropped, so a note that names a
 *  call can never satisfy the scan. */
function codeOnly(source: string): string {
  return source
    .split(/\r?\n/u)
    .filter((line) => {
      const trimmed = line.trim();
      return !(trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*'));
    })
    .map((line) => line.replace(/\/\*.*?\*\//gu, '').replace(/\/\/.*$/u, ''))
    .join('\n');
}

function writeAndWait(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

describe('releaseMouseTracking', () => {
  it('switches a real terminal with Claude Code\'s mouse modes back to no tracking', async () => {
    const terminal = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
    try {
      await writeAndWait(terminal, CLAUDE_MOUSE_MODES);
      // Positive control: the modes really took, so the flip below is not vacuous.
      expect(terminal.modes.mouseTrackingMode).toBe('any');
      // Rename tripwire: the private `_core.coreMouseService` path did the work,
      // not the reset() fallback. Headless 6.0.0 only; the browser bundle's
      // name is not visible from this tier.
      const resetSpy = vi.spyOn(terminal, 'reset');
      releaseMouseTracking(terminal);
      expect(terminal.modes.mouseTrackingMode).toBe('none');
      expect(resetSpy).not.toHaveBeenCalled();
    } finally {
      terminal.dispose();
    }
  });

  it('falls back to the public reset() when the private mouse service is missing', () => {
    const reset = vi.fn();
    releaseMouseTracking({ reset });
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('relies on the public reset() turning mouse tracking off, which is what the fallback calls', async () => {
    // The fallback case above only shows reset() is called. This shows the premise:
    // on a real terminal with Claude Code's mouse modes on, reset() alone ends tracking.
    const terminal = new Terminal({ cols: 20, rows: 4, allowProposedApi: true });
    try {
      await writeAndWait(terminal, CLAUDE_MOUSE_MODES);
      // Positive control: the modes really took, so the flip below is not vacuous.
      expect(terminal.modes.mouseTrackingMode).toBe('any');
      terminal.reset();
      expect(terminal.modes.mouseTrackingMode).toBe('none');
    } finally {
      terminal.dispose();
    }
  });

  it('never throws, so the dispose that follows it always runs', () => {
    const throwingService = {
      get activeProtocol(): string { return 'ANY'; },
      set activeProtocol(_protocol: string) { throw new Error('protocol change handler threw'); },
    };
    const terminal = { _core: { coreMouseService: throwingService }, reset: vi.fn() };
    expect(() => releaseMouseTracking(terminal)).not.toThrow();
    expect(() => releaseMouseTracking({ reset: () => { throw new Error('reset threw'); } })).not.toThrow();
  });
});

describe('every opened xterm releases mouse tracking before dispose', () => {
  it('each file that constructs and opens an @xterm/xterm Terminal calls releaseMouseTracking', () => {
    const visited: string[] = [];
    const violations: string[] = [];
    for (const filePath of SCAN_ROOTS.flatMap((root) => collectSourceFiles(root))) {
      const source = fs.readFileSync(filePath, 'utf-8');
      if (!source.includes('@xterm/xterm')) continue;
      const code = codeOnly(source);
      // A value import of the browser package (headless has no DOM listeners).
      if (!/import\s*\{[^}]*\bTerminal\b[^}]*\}\s*from\s*'@xterm\/xterm'/u.test(code)) continue;
      if (!/\bnew Terminal\s*\(/u.test(code)) continue;
      // Never opened means never bound to the DOM, so it parks no listener
      // (demo/replay-emulator.ts).
      if (!/\.open\s*\(/u.test(code)) continue;
      const relativePath = path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
      visited.push(relativePath);
      if (!/\breleaseMouseTracking\s*\(/u.test(code)) violations.push(relativePath);
    }
    // Pins that the scan still finds the real sites, so it cannot pass vacuously.
    expect(visited).toEqual(expect.arrayContaining(['src/renderer/hooks/useTerminal.ts']));
    expect(
      violations,
      'An opened @xterm/xterm Terminal must call releaseMouseTracking(terminal) ' +
      '(src/renderer/utils/terminal-dispose.ts) before dispose(), or a document mouse ' +
      'listener outlives it and every later click throws (DESKTOP-1G). ' +
      'See .claude/rules/xterm-dispose-releases-mouse.md.',
    ).toEqual([]);
  });

  it('useTerminal\'s unmount cleanup releases first, ahead of the dispose', () => {
    const source = fs.readFileSync(USE_TERMINAL_PATH, 'utf-8');
    const start = source.indexOf('// Cleanup on unmount');
    expect(start, 'unmount cleanup marker not found in useTerminal.ts').toBeGreaterThan(-1);
    const end = source.indexOf('\n  }, []);', start);
    expect(end, 'unmount cleanup effect has no closing dependency array').toBeGreaterThan(start);
    const cleanup = codeOnly(source.slice(start, end));
    const body = cleanup.slice(cleanup.indexOf('return () => {') + 'return () => {'.length);
    const statements = body.split('\n').map((line) => line.trim()).filter((line) => line.length > 0);
    // First, so no earlier teardown step that throws can skip it.
    expect(statements[0]).toBe('if (xtermRef.current) releaseMouseTracking(xtermRef.current);');
    const disposeIndex = body.indexOf('xtermRef.current?.dispose()');
    expect(disposeIndex).toBeGreaterThan(body.indexOf('releaseMouseTracking('));
  });
});

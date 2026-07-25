import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createTerminalLinkHandler } from '../../src/renderer/utils/terminal-link-handler';

const fakeEvent = {} as MouseEvent;
const fakeRange = {} as never;

describe('createTerminalLinkHandler', () => {
  it.each([
    ['http', 'http://localhost:3000'],
    ['https', 'https://kangentic.com/docs'],
  ])('opens %s links via the injected openExternal', (_label, url) => {
    const openExternal = vi.fn();
    const handler = createTerminalLinkHandler(openExternal);
    handler.activate(fakeEvent, url, fakeRange);
    expect(openExternal).toHaveBeenCalledWith(url);
  });

  it.each([
    ['javascript', 'javascript:alert(1)'],
    ['file', 'file:///etc/passwd'],
    ['data', 'data:text/html,<script>alert(1)</script>'],
    ['mailto', 'mailto:someone@example.com'],
    ['unparseable', 'not a url'],
  ])('does not open %s links', (_label, url) => {
    const openExternal = vi.fn();
    const handler = createTerminalLinkHandler(openExternal);
    handler.activate(fakeEvent, url, fakeRange);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('does not set allowNonHttpProtocols', () => {
    const handler = createTerminalLinkHandler(vi.fn());
    expect(handler.allowNonHttpProtocols).toBeUndefined();
  });
});

// allowNonHttpProtocols disables xterm's own http(s)-only OSC 8 filter (see
// OscLinkProvider in @xterm/xterm). It is one word away from being flipped by
// a future "why isn't my file:// link clickable" fix, which would remove an
// independent layer of the scheme check this handler relies on. Guard it
// with a static scan rather than trusting review alone.
describe('allowNonHttpProtocols is never set under src/renderer', () => {
  it('scans for the flag', () => {
    const REPO_ROOT = path.resolve(__dirname, '../..');
    const scanDir = path.join(REPO_ROOT, 'src/renderer');
    const offenders: string[] = [];

    // Matches the flag being SET (`allowNonHttpProtocols: true`, `.allowNonHttpProtocols =`), not a
    // prose mention in a comment explaining why it must stay unset.
    const ALLOW_NON_HTTP_ASSIGNMENT = /allowNonHttpProtocols\s*[:=]/;

    function isCommentLine(line: string): boolean {
      const trimmed = line.trim();
      return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
    }

    function walk(directory: string): void {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const fullPath = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) {
          const lines = fs.readFileSync(fullPath, 'utf-8').split('\n');
          lines.forEach((line, index) => {
            if (isCommentLine(line)) return;
            if (ALLOW_NON_HTTP_ASSIGNMENT.test(line)) {
              offenders.push(`${path.relative(REPO_ROOT, fullPath).replace(/\\/g, '/')}:${index + 1}`);
            }
          });
        }
      }
    }
    walk(scanDir);

    expect(
      offenders,
      `allowNonHttpProtocols must never be set on a terminal linkHandler - it disables xterm's own scheme filter.\nOffenders:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});

// createTerminalLinkHandler is fully covered above in isolation, but nothing
// asserted it is actually WIRED into the constructed Terminal. Without this
// scan, deleting the `linkHandler: createTerminalLinkHandler(...)` line from
// useTerminal.ts silently restores xterm's built-in OSC 8 fallback (a native
// confirm() dialog plus a bare chrome-less window.open()) while every other
// test stays green.
describe('useTerminal wires createTerminalLinkHandler into the xterm Terminal constructor', () => {
  it('passes linkHandler: createTerminalLinkHandler(...) in the `new Terminal({` options', () => {
    const REPO_ROOT = path.resolve(__dirname, '../..');
    const useTerminalPath = path.join(REPO_ROOT, 'src/renderer/hooks/useTerminal.ts');
    const source = fs.readFileSync(useTerminalPath, 'utf-8');

    const constructorStart = source.indexOf('new Terminal({');
    expect(constructorStart, 'expected to find `new Terminal({` in useTerminal.ts').toBeGreaterThanOrEqual(0);

    const constructorEnd = source.indexOf('});', constructorStart);
    expect(constructorEnd, 'expected a closing `});` after `new Terminal({`').toBeGreaterThan(constructorStart);

    const constructorOptions = source.slice(constructorStart, constructorEnd);

    expect(
      constructorOptions,
      "useTerminal.ts must pass linkHandler: createTerminalLinkHandler(...) into the Terminal constructor options, otherwise OSC 8 link clicks fall back to xterm's built-in confirm() dialog plus a bare chrome-less window.open()",
    ).toMatch(/linkHandler:\s*createTerminalLinkHandler\(/);
  });
});

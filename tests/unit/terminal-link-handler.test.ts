import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// link-targets reads the click setting from the config store; every test here
// hands it in instead, so the store only has to import.
vi.mock('../../src/renderer/stores/config-store', () => ({ useConfigStore: { getState: () => ({}) } }));

import { createTerminalLinkHandler } from '../../src/renderer/utils/terminal-link-handler';
import { createTerminalLinkTargets, type TerminalLinkBrowser } from '../../src/renderer/utils/terminal-links/link-targets';
import type { LinkClickTarget } from '../../src/shared/types';

const ctrlClick = { ctrlKey: true, metaKey: false, altKey: false, shiftKey: false } as MouseEvent;
const shiftClick = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: true } as MouseEvent;
const altClick = { ctrlKey: false, metaKey: false, altKey: true, shiftKey: false } as MouseEvent;
const plainClick = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false } as MouseEvent;
const fakeRange = {} as never;

function targets(openExternal: (url: string) => void, browser: TerminalLinkBrowser | null = null, clickOpens: LinkClickTarget = 'default') {
  return createTerminalLinkTargets({ getBrowser: () => browser, openExternal, readClickTarget: () => clickOpens });
}

describe('createTerminalLinkHandler', () => {
  it('opens on a plain click and on Ctrl+click, and leaves Shift and Alt clicks to selection', () => {
    const openExternal = vi.fn();
    const handler = createTerminalLinkHandler(targets(openExternal));
    handler.activate(shiftClick, 'https://kangentic.com', fakeRange);
    handler.activate(altClick, 'https://kangentic.com', fakeRange);
    expect(openExternal).not.toHaveBeenCalled();
    handler.activate(plainClick, 'https://kangentic.com', fakeRange);
    handler.activate(ctrlClick, 'https://kangentic.com', fakeRange);
    expect(openExternal).toHaveBeenCalledTimes(2);
  });

  it('opens a click in the browser the setting names and Ctrl+click in the other, and in the default browser where the terminal has none', () => {
    const openExternal = vi.fn();
    const browser = { open: vi.fn() };
    createTerminalLinkHandler(targets(openExternal, browser)).activate(ctrlClick, 'http://localhost:5173/', fakeRange);
    expect(browser.open).toHaveBeenCalledWith('http://localhost:5173/');
    expect(openExternal).not.toHaveBeenCalled();

    createTerminalLinkHandler(targets(openExternal, browser, 'kangentic')).activate(plainClick, 'http://localhost:5173/', fakeRange);
    expect(browser.open).toHaveBeenCalledTimes(2);
    expect(openExternal).not.toHaveBeenCalled();

    createTerminalLinkHandler(targets(openExternal, null, 'kangentic')).activate(plainClick, 'http://localhost:5173/', fakeRange);
    expect(openExternal).toHaveBeenCalledWith('http://localhost:5173/');
  });

  it('opens nothing when the gesture says the click was a drag, or only brought the terminal forward', () => {
    const openExternal = vi.fn();
    const gesture = { noteLinkHover: vi.fn(), noteLinkLeave: vi.fn(), opensOnRelease: vi.fn(() => false) };
    createTerminalLinkHandler(targets(openExternal), gesture).activate(plainClick, 'https://kangentic.com', fakeRange);
    expect(gesture.opensOnRelease).toHaveBeenCalledWith(plainClick);
    expect(openExternal).not.toHaveBeenCalled();

    gesture.opensOnRelease.mockReturnValue(true);
    createTerminalLinkHandler(targets(openExternal), gesture).activate(plainClick, 'https://kangentic.com', fakeRange);
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it('tells the gesture about a hover with the link\'s URI, so the tip can say where it goes', () => {
    const gesture = { noteLinkHover: vi.fn(), noteLinkLeave: vi.fn(), opensOnRelease: vi.fn(() => true) };
    const handler = createTerminalLinkHandler(targets(vi.fn()), gesture);
    handler.hover?.(ctrlClick, 'https://kangentic.com', fakeRange);
    handler.leave?.(ctrlClick, 'https://kangentic.com', fakeRange);
    expect(gesture.noteLinkHover).toHaveBeenCalledTimes(1);
    expect(gesture.noteLinkHover).toHaveBeenCalledWith({ event: ctrlClick, range: fakeRange, kind: 'url', osc8Uri: 'https://kangentic.com' });
    expect(gesture.noteLinkLeave).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['http', 'http://localhost:3000'],
    ['https', 'https://kangentic.com/docs'],
  ])('opens %s links', (_label, url) => {
    const openExternal = vi.fn();
    const handler = createTerminalLinkHandler(targets(openExternal));
    handler.activate(ctrlClick, url, fakeRange);
    expect(openExternal).toHaveBeenCalledWith(url);
  });

  it.each([
    ['javascript', 'javascript:alert(1)'],
    ['file', 'file:///etc/passwd'],
    ['data', 'data:text/html,<script>alert(1)</script>'],
    ['mailto', 'mailto:someone@example.com'],
    ['unparseable', 'not a url'],
  ])('does not open %s links, in either browser', (_label, url) => {
    const openExternal = vi.fn();
    const browser = { open: vi.fn() };
    const handler = createTerminalLinkHandler(targets(openExternal, browser));
    handler.activate(ctrlClick, url, fakeRange);
    handler.activate(plainClick, url, fakeRange);
    expect(openExternal).not.toHaveBeenCalled();
    expect(browser.open).not.toHaveBeenCalled();
  });

  it('does not set allowNonHttpProtocols', () => {
    const handler = createTerminalLinkHandler(targets(vi.fn()));
    expect(handler.allowNonHttpProtocols).toBeUndefined();
  });

  it('warns with the [terminal-link-handler] prefix for a blocked link', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const handler = createTerminalLinkHandler(targets(vi.fn()));

    handler.activate(ctrlClick, 'javascript:alert(1)', fakeRange);

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('[terminal-link-handler] Blocked link with disallowed scheme: javascript:alert(1)'),
    );

    warnSpy.mockRestore();
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

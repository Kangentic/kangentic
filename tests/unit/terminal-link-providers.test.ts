import { describe, expect, it, vi } from 'vitest';
import type { ILink } from '@xterm/xterm';
import { Terminal } from '@xterm/headless';
import { activateUnicode11 } from '../../src/shared/xterm-unicode11';

// link-targets reads the click setting from the config store; every test here
// hands it in instead, so the store only has to import.
vi.mock('../../src/renderer/stores/config-store', () => ({ useConfigStore: { getState: () => ({}) } }));

import { isLinkOpenGesture } from '../../src/renderer/utils/link-open';
import { createTerminalLinkGesture, type TerminalLinkGesture } from '../../src/renderer/utils/terminal-links/link-gesture';
import { EXISTING_PATH_TTL_MS, MAX_CACHED_PATHS, MISSING_PATH_TTL_MS, createLinkPathCache } from '../../src/renderer/utils/terminal-links/link-path-cache';
import { createPathLinkProvider, createUrlLinkProvider, type LinkTerminal } from '../../src/renderer/utils/terminal-links/link-providers';
import { createTerminalLinkTargets, type TerminalLinkBrowser } from '../../src/renderer/utils/terminal-links/link-targets';
import type { LinkClickTarget } from '../../src/shared/types';

const noGesture: TerminalLinkGesture = {
  noteLinkHover: () => {},
  noteLinkLeave: () => {},
  attach: () => {},
  isClickingLink: () => false,
  opensOnRelease: () => true,
  onClaimReleased: () => {},
};

const ctrlClick = { ctrlKey: true, metaKey: false, altKey: false, shiftKey: false } as MouseEvent;
const cmdClick = { ctrlKey: false, metaKey: true, altKey: false, shiftKey: false } as MouseEvent;
const plainClick = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false } as MouseEvent;
const shiftClick = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: true } as MouseEvent;

function targets(openExternal: (url: string) => void, browser: TerminalLinkBrowser | null = null, clickOpens: LinkClickTarget = 'default') {
  return createTerminalLinkTargets({ getBrowser: () => browser, openExternal, readClickTarget: () => clickOpens });
}

async function terminalWith(text: string): Promise<Terminal> {
  const terminal = new Terminal({ cols: 40, rows: 6, allowProposedApi: true });
  activateUnicode11(terminal);
  await new Promise<void>((resolve) => terminal.write(text, resolve));
  return terminal;
}

function asLinkTerminal(terminal: Terminal): LinkTerminal {
  return terminal as unknown as LinkTerminal;
}

function linksFrom(provider: { provideLinks(row: number, callback: (links: ILink[] | undefined) => void): void }, row: number): Promise<ILink[] | undefined> {
  return new Promise((resolve) => provider.provideLinks(row, resolve));
}

describe('createUrlLinkProvider', () => {
  it('answers in the same tick, because the Linkifier waits on every provider', async () => {
    const terminal = await terminalWith('https://example.com/a');
    const callback = vi.fn();
    createUrlLinkProvider(asLinkTerminal(terminal), noGesture, targets(vi.fn())).provideLinks(1, callback);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('opens on a plain click and on Ctrl+click, and not on a Shift click', async () => {
    const terminal = await terminalWith('https://example.com/a');
    const openExternal = vi.fn();
    const [link] = (await linksFrom(createUrlLinkProvider(asLinkTerminal(terminal), noGesture, targets(openExternal)), 1))!;
    link.activate(shiftClick, link.text);
    expect(openExternal).not.toHaveBeenCalled();
    link.activate(plainClick, link.text);
    link.activate(ctrlClick, link.text);
    expect(openExternal.mock.calls).toEqual([['https://example.com/a'], ['https://example.com/a']]);
  });

  it('opens a click in the browser the setting names and Ctrl+click in the other, when the terminal has a Kangentic browser', async () => {
    const terminal = await terminalWith('http://localhost:5173/signup');
    const openExternal = vi.fn();
    const browser = { open: vi.fn() };
    const [link] = (await linksFrom(createUrlLinkProvider(asLinkTerminal(terminal), noGesture, targets(openExternal, browser)), 1))!;
    link.activate(ctrlClick, link.text);
    expect(browser.open).toHaveBeenCalledWith('http://localhost:5173/signup');
    link.activate(plainClick, link.text);
    expect(openExternal).toHaveBeenCalledWith('http://localhost:5173/signup');

    openExternal.mockClear();
    browser.open.mockClear();
    const [swapped] = (await linksFrom(createUrlLinkProvider(asLinkTerminal(terminal), noGesture, targets(openExternal, browser, 'kangentic')), 1))!;
    swapped.activate(plainClick, swapped.text);
    expect(browser.open).toHaveBeenCalledTimes(1);
    swapped.activate(ctrlClick, swapped.text);
    expect(openExternal).toHaveBeenCalledTimes(1);
  });

  it('opens nothing when the gesture says the click was a drag, or only brought the terminal forward', async () => {
    const terminal = await terminalWith('https://example.com/a');
    const openExternal = vi.fn();
    const refusing = { ...noGesture, opensOnRelease: () => false };
    const [link] = (await linksFrom(createUrlLinkProvider(asLinkTerminal(terminal), refusing, targets(openExternal)), 1))!;
    link.activate(plainClick, link.text);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('routes through the terminal scheme allowlist', async () => {
    const terminal = await terminalWith('https://example.com/a');
    const openExternal = vi.fn();
    const [link] = (await linksFrom(createUrlLinkProvider(asLinkTerminal(terminal), noGesture, targets(openExternal)), 1))!;
    link.activate(ctrlClick, 'javascript:alert(1)');
    expect(openExternal).not.toHaveBeenCalled();
  });

  it.each([
    ['the main screen, as Gemini draws', ''],
    ['the alternate screen, as Codex, Copilot and Grok draw', '\x1b[?1049h\x1b[1;1H'],
  ])('opens the whole URL a TUI wrapped itself on %s, from either row', async (_label, prefix) => {
    const head = `https://example.com/${'d'.repeat(20)}`;
    const terminal = await terminalWith(`${prefix}${head}\x1b[2;3Hremainder?a=1 then prose`);
    const provider = createUrlLinkProvider(asLinkTerminal(terminal), noGesture, targets(vi.fn()));
    for (const row of [1, 2]) {
      const [link] = (await linksFrom(provider, row))!;
      expect(link.text).toBe(`${head}remainder?a=1`);
      expect(link.range).toMatchObject({ start: { x: 1, y: 1 }, end: { y: 2 } });
    }
  });

  it('tells the gesture when the pointer is on a link', async () => {
    const terminal = await terminalWith('https://example.com/a');
    const noteLinkHover = vi.fn();
    const noteLinkLeave = vi.fn();
    const [link] = (await linksFrom(createUrlLinkProvider(asLinkTerminal(terminal), { ...noGesture, noteLinkHover, noteLinkLeave }, targets(vi.fn())), 1))!;
    link.hover?.(plainClick, link.text);
    link.leave?.(plainClick, link.text);
    expect(noteLinkHover).toHaveBeenCalledTimes(1);
    // The tip reads where the link is and what a click on it does. A printed URL is its own text.
    expect(noteLinkHover).toHaveBeenCalledWith({ event: plainClick, range: link.range, kind: 'url' });
    expect(noteLinkLeave).toHaveBeenCalledTimes(1);
  });
});

describe('createPathLinkProvider', () => {
  it('links only what main says exists, and reveals the printed text', async () => {
    const terminal = await terminalWith('src/real.ts:42 src/gone.ts');
    const askMain = vi.fn(async (paths: string[]) => paths.map((path) => path === 'src/real.ts'));
    const revealPath = vi.fn();
    const provider = createPathLinkProvider(asLinkTerminal(terminal), noGesture, createLinkPathCache(askMain), revealPath);
    const links = await linksFrom(provider, 1);
    expect(links?.map((link) => link.text)).toEqual(['src/real.ts:42']);
    links![0].activate(plainClick, links![0].text);
    expect(revealPath).not.toHaveBeenCalled();
    links![0].activate(ctrlClick, links![0].text);
    expect(revealPath).toHaveBeenCalledWith('src/real.ts');
  });

  it('tells the gesture when the pointer is on a path link', async () => {
    const terminal = await terminalWith('src/real.ts');
    const noteLinkHover = vi.fn();
    const noteLinkLeave = vi.fn();
    const provider = createPathLinkProvider(
      asLinkTerminal(terminal),
      { ...noGesture, noteLinkHover, noteLinkLeave },
      createLinkPathCache(async (paths) => paths.map(() => true)),
      vi.fn(),
    );
    const [link] = (await linksFrom(provider, 1))!;
    expect(noteLinkHover).not.toHaveBeenCalled();
    link.hover?.(plainClick, link.text);
    expect(noteLinkHover).toHaveBeenCalledTimes(1);
    expect(noteLinkHover).toHaveBeenCalledWith({ event: plainClick, range: link.range, kind: 'path' });
    expect(noteLinkLeave).not.toHaveBeenCalled();
    link.leave?.(plainClick, link.text);
    expect(noteLinkLeave).toHaveBeenCalledTimes(1);
  });

  it('resolves a long path a TUI wrapped across rows as one path', async () => {
    const head = `src/${'e'.repeat(36)}`;
    const terminal = await terminalWith(`${head}\x1b[2;3Hfile.ts:12`);
    const askMain = vi.fn(async (paths: string[]) => paths.map(() => true));
    const revealPath = vi.fn();
    const provider = createPathLinkProvider(asLinkTerminal(terminal), noGesture, createLinkPathCache(askMain), revealPath);
    const [link] = (await linksFrom(provider, 2))!;
    link.activate(ctrlClick, link.text);
    expect(revealPath).toHaveBeenCalledWith(`${head}file.ts`);
  });

  it('asks about a whole row in one call, and a second hover reaches main no more', async () => {
    const terminal = await terminalWith('src/a.ts src/b.ts src/c.ts');
    const askMain = vi.fn(async (paths: string[]) => paths.map(() => true));
    const provider = createPathLinkProvider(asLinkTerminal(terminal), noGesture, createLinkPathCache(askMain), vi.fn());
    await linksFrom(provider, 1);
    await linksFrom(provider, 1);
    expect(askMain).toHaveBeenCalledTimes(1);
    expect(askMain.mock.calls[0][0]).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  });

  it('answers when main fails, since the Linkifier holds every link until it does', async () => {
    const terminal = await terminalWith('src/a.ts');
    const cache = createLinkPathCache(async () => { throw new Error('no reply'); });
    expect(await linksFrom(createPathLinkProvider(asLinkTerminal(terminal), noGesture, cache, vi.fn()), 1)).toBeUndefined();
  });

  it('asks main nothing for a row with no candidates', async () => {
    const terminal = await terminalWith('nothing to see here');
    const askMain = vi.fn(async () => []);
    await linksFrom(createPathLinkProvider(asLinkTerminal(terminal), noGesture, createLinkPathCache(askMain), vi.fn()), 1);
    expect(askMain).not.toHaveBeenCalled();
  });
});

describe('createLinkPathCache', () => {
  it('forgets a missing path quickly and an existing one slowly', async () => {
    let clock = 1000;
    const cache = createLinkPathCache(async (paths) => paths.map((path) => path === 'there'), () => clock);
    await cache.resolve(['there', 'gone']);
    expect([cache.peek('there'), cache.peek('gone')]).toEqual([true, false]);
    clock += MISSING_PATH_TTL_MS;
    expect(cache.peek('gone')).toBeUndefined();
    expect(cache.peek('there')).toBe(true);
    clock += EXISTING_PATH_TTL_MS;
    expect(cache.peek('there')).toBeUndefined();
  });

  it('shares one call between two rows asking about the same path', async () => {
    let finish: (answers: boolean[]) => void = () => {};
    const askMain = vi.fn(() => new Promise<boolean[]>((resolve) => { finish = resolve; }));
    const cache = createLinkPathCache(askMain);
    const first = cache.resolve(['shared']);
    const second = cache.resolve(['shared']);
    finish([true]);
    await Promise.all([first, second]);
    expect(askMain).toHaveBeenCalledTimes(1);
    expect(cache.peek('shared')).toBe(true);
  });

  it('asks about a path once when a row prints it twice', async () => {
    const askMain = vi.fn(async (paths: string[]) => paths.map(() => true));
    await createLinkPathCache(askMain).resolve(['src/a.ts', 'src/a.ts', 'src/b.ts']);
    expect(askMain.mock.calls[0][0]).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('holds a bounded number of paths, dropping the oldest', async () => {
    const cache = createLinkPathCache(async (paths) => paths.map(() => true));
    await cache.resolve(['oldest']);
    await cache.resolve(Array.from({ length: MAX_CACHED_PATHS }, (_unused, index) => `path-${index}`));
    expect(cache.peek('oldest')).toBeUndefined();
    expect(cache.peek(`path-${MAX_CACHED_PATHS - 1}`)).toBe(true);
  });
});

describe('isLinkOpenGesture', () => {
  it.each([
    ['Ctrl off a Mac', ctrlClick, false, true],
    ['Cmd off a Mac', cmdClick, false, true],
    ['Cmd on a Mac', cmdClick, true, true],
    ['Ctrl on a Mac, which is a right click', ctrlClick, true, false],
    ['a plain click', plainClick, false, false],
    ['a plain click on a Mac', plainClick, true, false],
  ])('reads %s', (_label, event, isMac, expected) => {
    expect(isLinkOpenGesture(event, isMac)).toBe(expected);
  });
});

describe('createTerminalLinkGesture', () => {
  /** A stand-in element and window that hold the listeners the gesture registers. */
  const windowStub = {
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'>;
  const focusedElement = (addEventListener: (type: string, listener: unknown) => void) => ({
    addEventListener,
    contains: () => true,
    ownerDocument: { activeElement: {} },
  }) as unknown as HTMLElement;

  function harness(): { gesture: TerminalLinkGesture; press: (init: Partial<MouseEvent>) => void; release: () => void } {
    let pressListener: (event: MouseEvent) => void = () => {};
    let releaseListener: () => void = () => {};
    const gesture = createTerminalLinkGesture({
      addEventListener: (type: string, listener: unknown) => { if (type === 'mouseup') releaseListener = listener as () => void; },
      removeEventListener: () => {},
    } as unknown as Pick<Window, 'addEventListener' | 'removeEventListener'>);
    gesture.attach(focusedElement((_type, listener) => { pressListener = listener as (event: MouseEvent) => void; }));
    return {
      gesture,
      press: (init) => pressListener({ button: 0, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, clientX: 0, clientY: 0, ...init } as MouseEvent),
      release: () => releaseListener(),
    };
  }

  it.each([
    ['Ctrl', { ctrlKey: true }],
    ['Cmd, which no mouse report can carry', { metaKey: true }],
  ])('claims a %s press on a link until its release has been dispatched', async (_label, init) => {
    vi.useFakeTimers();
    try {
      const { gesture, press, release } = harness();
      gesture.noteLinkHover();
      press(init);
      expect(gesture.isClickingLink()).toBe(true);
      release();
      // Still set for the report xterm makes later in this same mouseup dispatch.
      expect(gesture.isClickingLink()).toBe(true);
      await vi.runAllTimersAsync();
      expect(gesture.isClickingLink()).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ['a plain click on a link that only opens on Ctrl or Cmd (the default claim)', true, {}],
    ['Ctrl off any link', false, { ctrlKey: true }],
    ['a right click on a link', true, { ctrlKey: true, button: 2 }],
  ])('leaves %s to the TUI', (_label, hovering, init) => {
    const { gesture, press } = harness();
    if (hovering) gesture.noteLinkHover();
    press(init);
    expect(gesture.isClickingLink()).toBe(false);
  });

  it('stops claiming after the pointer leaves the link', () => {
    const { gesture, press } = harness();
    gesture.noteLinkHover();
    gesture.noteLinkLeave();
    press({ ctrlKey: true });
    expect(gesture.isClickingLink()).toBe(false);
  });

  it('answers each press afresh, so a lost release cannot hold it', () => {
    const { gesture, press } = harness();
    gesture.noteLinkHover();
    press({ ctrlKey: true });
    gesture.noteLinkLeave();
    press({});
    expect(gesture.isClickingLink()).toBe(false);
  });

  it('hands a hovered link to the tip, and tells it when the pointer leaves', () => {
    const gesture = createTerminalLinkGesture(windowStub);
    const tip = { show: vi.fn(), leave: vi.fn(), dispose: vi.fn() };
    gesture.attach(focusedElement(() => {}), tip);
    const hover = { event: plainClick, range: { start: { x: 1, y: 1 }, end: { x: 9, y: 1 } }, kind: 'url' as const };
    gesture.noteLinkHover(hover);
    expect(tip.show).toHaveBeenCalledWith(hover);
    gesture.noteLinkLeave();
    expect(tip.leave).toHaveBeenCalledTimes(1);
  });

  it('claims the press the hovered link kind opens on, and no other', () => {
    let pressListener: (event: MouseEvent) => void = () => {};
    // A URL opens on Alt+click here; a path keeps Ctrl or Cmd.
    const opensLink = (event: Pick<MouseEvent, 'altKey' | 'ctrlKey' | 'metaKey'>, kind: 'url' | 'path') =>
      kind === 'url' ? event.altKey === true : isLinkOpenGesture(event, false);
    const gesture = createTerminalLinkGesture(windowStub, opensLink);
    gesture.attach(focusedElement((_type, listener) => { pressListener = listener as (event: MouseEvent) => void; }));
    const range = { start: { x: 1, y: 1 }, end: { x: 9, y: 1 } };
    const altPress = { button: 0, altKey: true, ctrlKey: false, metaKey: false, shiftKey: false } as MouseEvent;

    gesture.noteLinkHover({ event: plainClick, range, kind: 'url' });
    pressListener(altPress);
    expect(gesture.isClickingLink()).toBe(true);

    gesture.noteLinkHover({ event: plainClick, range, kind: 'path' });
    pressListener(altPress);
    expect(gesture.isClickingLink()).toBe(false);
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { ILink } from '@xterm/xterm';
import { Terminal } from '@xterm/headless';
import { activateUnicode11 } from '../../src/shared/xterm-unicode11';
import { createTerminalLinkGesture, isLinkOpenGesture, type TerminalLinkGesture } from '../../src/renderer/utils/terminal-links/link-gesture';
import { EXISTING_PATH_TTL_MS, MAX_CACHED_PATHS, MISSING_PATH_TTL_MS, createLinkPathCache } from '../../src/renderer/utils/terminal-links/link-path-cache';
import { createPathLinkProvider, createUrlLinkProvider, type LinkTerminal } from '../../src/renderer/utils/terminal-links/link-providers';

const noGesture: TerminalLinkGesture = {
  noteLinkHover: () => {},
  noteLinkLeave: () => {},
  attach: () => {},
  isClickingLink: () => false,
};

const ctrlClick = { ctrlKey: true, metaKey: false } as MouseEvent;
const cmdClick = { ctrlKey: false, metaKey: true } as MouseEvent;
const plainClick = { ctrlKey: false, metaKey: false } as MouseEvent;

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
    createUrlLinkProvider(asLinkTerminal(terminal), noGesture, vi.fn()).provideLinks(1, callback);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('opens on Ctrl or Cmd and not on a plain click', async () => {
    const terminal = await terminalWith('https://example.com/a');
    const openExternal = vi.fn();
    const [link] = (await linksFrom(createUrlLinkProvider(asLinkTerminal(terminal), noGesture, openExternal), 1))!;
    link.activate(plainClick, link.text);
    expect(openExternal).not.toHaveBeenCalled();
    link.activate(ctrlClick, link.text);
    link.activate(cmdClick, link.text);
    expect(openExternal.mock.calls).toEqual([['https://example.com/a'], ['https://example.com/a']]);
  });

  it('routes through the terminal scheme allowlist', async () => {
    const terminal = await terminalWith('https://example.com/a');
    const openExternal = vi.fn();
    const [link] = (await linksFrom(createUrlLinkProvider(asLinkTerminal(terminal), noGesture, openExternal), 1))!;
    link.activate(ctrlClick, 'javascript:alert(1)');
    expect(openExternal).not.toHaveBeenCalled();
  });

  it.each([
    ['the main screen, as Gemini draws', ''],
    ['the alternate screen, as Codex, Copilot and Grok draw', '\x1b[?1049h\x1b[1;1H'],
  ])('opens the whole URL a TUI wrapped itself on %s, from either row', async (_label, prefix) => {
    const head = `https://example.com/${'d'.repeat(20)}`;
    const terminal = await terminalWith(`${prefix}${head}\x1b[2;3Hremainder?a=1 then prose`);
    const openExternal = vi.fn();
    const provider = createUrlLinkProvider(asLinkTerminal(terminal), noGesture, openExternal);
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
    const [link] = (await linksFrom(createUrlLinkProvider(asLinkTerminal(terminal), { ...noGesture, noteLinkHover, noteLinkLeave }, vi.fn()), 1))!;
    link.hover?.(plainClick, link.text);
    link.leave?.(plainClick, link.text);
    expect(noteLinkHover).toHaveBeenCalledTimes(1);
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
  function harness(): { gesture: TerminalLinkGesture; press: (init: Partial<MouseEvent>) => void; release: () => void } {
    let pressListener: (event: MouseEvent) => void = () => {};
    let releaseListener: () => void = () => {};
    const gesture = createTerminalLinkGesture({
      addEventListener: (_type: string, listener: unknown) => { releaseListener = listener as () => void; },
    } as Pick<Window, 'addEventListener'>);
    gesture.attach({
      addEventListener: (_type: string, listener: unknown) => { pressListener = listener as (event: MouseEvent) => void; },
    } as unknown as HTMLElement);
    return {
      gesture,
      press: (init) => pressListener({ button: 0, ctrlKey: false, metaKey: false, ...init } as MouseEvent),
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
    ['a plain click on a link', true, {}],
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
});

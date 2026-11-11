/**
 * registerTerminalLinks (src/renderer/utils/terminal-links/register-terminal-links.ts):
 * which providers a terminal gets, what each reaches on `window.electronAPI`, and
 * the warning toast when a printed path cannot be shown.
 *
 * The providers, the path cache and the toast store are the real ones. The terminal
 * is a headless xterm behind a stand-in that holds the registered providers and an
 * optional `element`. What a user loses if this goes: a session pane without links,
 * a path hover that asks main about the wrong session, or a click on a path that
 * has gone that does nothing and says nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ILink, ILinkProvider, ITerminalAddon, Terminal as XtermTerminal } from '@xterm/xterm';
import { Terminal } from '@xterm/headless';
import { activateUnicode11 } from '../../src/shared/xterm-unicode11';

// The toast store reads the configured duration and cap when it adds a toast.
vi.mock('../../src/renderer/stores/config-store', () => ({
  useConfigStore: {
    getState: () => ({
      loadConfig: vi.fn(),
      config: { notifications: { toasts: { durationSeconds: 4, maxCount: 5 } } },
    }),
  },
}));

import { linkOpensOn, registerTerminalLinks } from '../../src/renderer/utils/terminal-links/register-terminal-links';
import type { TerminalLinkGesture } from '../../src/renderer/utils/terminal-links/link-gesture';
import { createTerminalLinkTargets } from '../../src/renderer/utils/terminal-links/link-targets';
import { useToastStore } from '../../src/renderer/stores/toast-store';

const SESSION_ID = 'session-under-test';
const plainClick = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: false } as MouseEvent;
const ctrlClick = { ctrlKey: true, metaKey: false, altKey: false, shiftKey: false } as MouseEvent;
const altClick = { ctrlKey: false, metaKey: false, altKey: true, shiftKey: false } as MouseEvent;
const shiftClick = { ctrlKey: false, metaKey: false, altKey: false, shiftKey: true } as MouseEvent;

/** The default browser through the shell bridge, as useTerminal wires it, with no Kangentic browser beside it. */
const linkTargets = createTerminalLinkTargets({
  getBrowser: () => null,
  openExternal: (url) => { void window.electronAPI.shell.openExternal(url); },
  readClickTarget: () => 'default',
});

interface Harness {
  stub: XtermTerminal;
  providers: ILinkProvider[];
  addons: ITerminalAddon[];
  gesture: TerminalLinkGesture;
  attach: ReturnType<typeof vi.fn>;
}

async function harness(text: string, element: HTMLElement | undefined, opensOnRelease = true): Promise<Harness> {
  const headless = new Terminal({ cols: 60, rows: 6, allowProposedApi: true });
  activateUnicode11(headless);
  await new Promise<void>((resolve) => headless.write(text, resolve));
  const providers: ILinkProvider[] = [];
  const addons: ITerminalAddon[] = [];
  const stub = {
    get cols() { return headless.cols; },
    get rows() { return headless.rows; },
    get buffer() { return headless.buffer; },
    element,
    registerLinkProvider: (provider: ILinkProvider) => { providers.push(provider); return { dispose: () => {} }; },
    loadAddon: (addon: ITerminalAddon) => { addons.push(addon); },
  } as unknown as XtermTerminal;
  const attach = vi.fn();
  const gesture: TerminalLinkGesture = {
    noteLinkHover: () => {},
    noteLinkLeave: () => {},
    attach,
    isClickingLink: () => false,
    opensOnRelease: () => opensOnRelease,
    onClaimReleased: () => {},
  };
  return { stub, providers, addons, gesture, attach };
}

/** An element that takes the listeners the link tip adds, and nothing else. */
function stubElement(): HTMLElement {
  return { addEventListener: vi.fn() } as unknown as HTMLElement;
}

function linksFrom(provider: ILinkProvider, row: number): Promise<ILink[] | undefined> {
  return new Promise((resolve) => provider.provideLinks(row, resolve));
}

/** Lets the reveal promise's continuation run. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

const resolveLinkPaths = vi.fn();
const revealLinkPath = vi.fn();
const openExternal = vi.fn();

beforeEach(() => {
  useToastStore.setState({ toasts: [] });
  resolveLinkPaths.mockReset().mockImplementation(async (_sessionId: string, paths: string[]) => paths.map(() => true));
  revealLinkPath.mockReset();
  openExternal.mockReset();
  vi.stubGlobal('window', {
    electronAPI: {
      shell: { openExternal },
      sessions: { resolveLinkPaths, revealLinkPath },
    },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('registerTerminalLinks providers', () => {
  it('registers a URL provider and a path provider for a pane with a session', async () => {
    const { stub, providers, gesture } = await harness('', undefined);
    registerTerminalLinks(stub, gesture, SESSION_ID, linkTargets);
    expect(providers).toHaveLength(2);
  });

  it('registers the URL provider alone for a pane with no session, which has no folder to resolve against', async () => {
    const { stub, providers, gesture } = await harness('https://example.com/a src/real.ts', undefined);
    registerTerminalLinks(stub, gesture, null, linkTargets);
    expect(providers).toHaveLength(1);

    const links = await linksFrom(providers[0], 1);
    expect(links?.map((link) => link.text)).toEqual(['https://example.com/a']);
    expect(resolveLinkPaths).not.toHaveBeenCalled();
  });

  it('opens a URL link through the shell bridge on a plain click and on Ctrl+click, with no Kangentic browser', async () => {
    const { stub, providers, gesture } = await harness('https://example.com/a', undefined);
    registerTerminalLinks(stub, gesture, null, linkTargets);
    const [link] = (await linksFrom(providers[0], 1))!;
    link.activate(plainClick, link.text);
    expect(openExternal).toHaveBeenCalledTimes(1);
    link.activate(ctrlClick, link.text);
    expect(openExternal).toHaveBeenCalledTimes(2);
    expect(openExternal).toHaveBeenLastCalledWith('https://example.com/a');
  });

  it('opens nothing on a Shift or Alt click, which belong to selection', async () => {
    const { stub, providers, gesture } = await harness('https://example.com/a', undefined);
    registerTerminalLinks(stub, gesture, null, linkTargets);
    const [link] = (await linksFrom(providers[0], 1))!;
    link.activate(shiftClick, link.text);
    link.activate(altClick, link.text);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('opens nothing when the gesture says the click was a drag or only focused the terminal', async () => {
    const { stub, providers, gesture } = await harness('https://example.com/a', undefined, false);
    registerTerminalLinks(stub, gesture, null, linkTargets);
    const [link] = (await linksFrom(providers[0], 1))!;
    link.activate(plainClick, link.text);
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('sends a click to the Kangentic browser, and Ctrl+click to the default one, when the setting names it', async () => {
    const open = vi.fn();
    const kangenticTargets = createTerminalLinkTargets({
      getBrowser: () => ({ open }),
      openExternal: (url) => { void window.electronAPI.shell.openExternal(url); },
      readClickTarget: () => 'kangentic',
    });
    const { stub, providers, gesture } = await harness('https://example.com/a', undefined);
    registerTerminalLinks(stub, gesture, null, kangenticTargets);
    const [link] = (await linksFrom(providers[0], 1))!;
    link.activate(plainClick, link.text);
    expect(open).toHaveBeenCalledWith('https://example.com/a');
    expect(openExternal).not.toHaveBeenCalled();
    link.activate(ctrlClick, link.text);
    expect(openExternal).toHaveBeenCalledWith('https://example.com/a');
  });

  it('asks main about the paths of a row for its own session', async () => {
    const { stub, providers, gesture } = await harness('src/real.ts', undefined);
    registerTerminalLinks(stub, gesture, SESSION_ID, linkTargets);
    await linksFrom(providers[1], 1);
    expect(resolveLinkPaths).toHaveBeenCalledTimes(1);
    expect(resolveLinkPaths).toHaveBeenCalledWith(SESSION_ID, ['src/real.ts']);
  });
});

describe('linkOpensOn', () => {
  it('claims a URL press on a plain click or Ctrl, and a path press on Ctrl or Cmd alone', () => {
    const opens = linkOpensOn(linkTargets);
    expect(opens(plainClick, 'url')).toBe(true);
    expect(opens(ctrlClick, 'url')).toBe(true);
    expect(opens(plainClick, 'path')).toBe(false);
    expect(opens(ctrlClick, 'path')).toBe(true);
  });

  it('claims neither kind on a Shift or Alt press', () => {
    const opens = linkOpensOn(linkTargets);
    for (const event of [shiftClick, altClick]) {
      expect(opens(event, 'url')).toBe(false);
      expect(opens(event, 'path')).toBe(false);
    }
  });
});

describe('registerTerminalLinks gesture', () => {
  it('attaches the gesture to the terminal element when it exists, with the link tip', async () => {
    const element = stubElement();
    const { stub, gesture, attach } = await harness('', element);
    registerTerminalLinks(stub, gesture, SESSION_ID, linkTargets);
    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith(element, expect.objectContaining({ show: expect.any(Function) }));
  });

  it('disposes the link tip with the terminal, so a closed window leaves no tip in the page', async () => {
    const { stub, addons, gesture, attach } = await harness('', stubElement());
    registerTerminalLinks(stub, gesture, SESSION_ID, linkTargets);
    const tip = attach.mock.calls[0][1] as { dispose: () => void };
    const dispose = vi.spyOn(tip, 'dispose');
    expect(addons).toHaveLength(1);
    addons[0].dispose();
    expect(dispose).toHaveBeenCalledTimes(1);
  });

  it('attaches nothing while the terminal has no element yet', async () => {
    const { stub, addons, gesture, attach } = await harness('', undefined);
    registerTerminalLinks(stub, gesture, SESSION_ID, linkTargets);
    expect(attach).not.toHaveBeenCalled();
    expect(addons).toEqual([]);
  });
});

describe('registerTerminalLinks reveal', () => {
  async function activatePathLink(): Promise<void> {
    const { stub, providers, gesture } = await harness('src/real.ts', undefined);
    registerTerminalLinks(stub, gesture, SESSION_ID, linkTargets);
    const [link] = (await linksFrom(providers[1], 1))!;
    link.activate(ctrlClick, link.text);
    await settle();
  }

  it('reveals the printed path for its session and toasts nothing when main shows it', async () => {
    revealLinkPath.mockResolvedValue(true);
    await activatePathLink();
    expect(revealLinkPath).toHaveBeenCalledWith(SESSION_ID, 'src/real.ts');
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('warns with the printed path when main finds it gone', async () => {
    revealLinkPath.mockResolvedValue(false);
    await activatePathLink();
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ title: 'Couldn\'t show file', message: 'src/real.ts', variant: 'warning' });
  });

  it('warns the same way when the reveal call rejects', async () => {
    revealLinkPath.mockRejectedValue(new Error('ipc failed'));
    await activatePathLink();
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0]).toMatchObject({ title: 'Couldn\'t show file', message: 'src/real.ts', variant: 'warning' });
  });
});

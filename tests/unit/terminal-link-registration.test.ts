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
import type { ILink, ILinkProvider, Terminal as XtermTerminal } from '@xterm/xterm';
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

import { registerTerminalLinks } from '../../src/renderer/utils/terminal-links/register-terminal-links';
import type { TerminalLinkGesture } from '../../src/renderer/utils/terminal-links/link-gesture';
import { useToastStore } from '../../src/renderer/stores/toast-store';

const SESSION_ID = 'session-under-test';
const ctrlClick = { ctrlKey: true, metaKey: false } as MouseEvent;

interface Harness {
  stub: XtermTerminal;
  providers: ILinkProvider[];
  gesture: TerminalLinkGesture;
  attach: ReturnType<typeof vi.fn>;
}

async function harness(text: string, element: HTMLElement | undefined): Promise<Harness> {
  const headless = new Terminal({ cols: 60, rows: 6, allowProposedApi: true });
  activateUnicode11(headless);
  await new Promise<void>((resolve) => headless.write(text, resolve));
  const providers: ILinkProvider[] = [];
  const stub = {
    get cols() { return headless.cols; },
    get buffer() { return headless.buffer; },
    element,
    registerLinkProvider: (provider: ILinkProvider) => { providers.push(provider); return { dispose: () => {} }; },
  } as unknown as XtermTerminal;
  const attach = vi.fn();
  const gesture: TerminalLinkGesture = {
    noteLinkHover: () => {},
    noteLinkLeave: () => {},
    attach,
    isClickingLink: () => false,
  };
  return { stub, providers, gesture, attach };
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
    registerTerminalLinks(stub, gesture, SESSION_ID);
    expect(providers).toHaveLength(2);
  });

  it('registers the URL provider alone for a pane with no session, which has no folder to resolve against', async () => {
    const { stub, providers, gesture } = await harness('https://example.com/a src/real.ts', undefined);
    registerTerminalLinks(stub, gesture, null);
    expect(providers).toHaveLength(1);

    const links = await linksFrom(providers[0], 1);
    expect(links?.map((link) => link.text)).toEqual(['https://example.com/a']);
    expect(resolveLinkPaths).not.toHaveBeenCalled();
  });

  it('opens a URL link through the shell bridge', async () => {
    const { stub, providers, gesture } = await harness('https://example.com/a', undefined);
    registerTerminalLinks(stub, gesture, null);
    const [link] = (await linksFrom(providers[0], 1))!;
    link.activate(ctrlClick, link.text);
    expect(openExternal).toHaveBeenCalledWith('https://example.com/a');
  });

  it('asks main about the paths of a row for its own session', async () => {
    const { stub, providers, gesture } = await harness('src/real.ts', undefined);
    registerTerminalLinks(stub, gesture, SESSION_ID);
    await linksFrom(providers[1], 1);
    expect(resolveLinkPaths).toHaveBeenCalledTimes(1);
    expect(resolveLinkPaths).toHaveBeenCalledWith(SESSION_ID, ['src/real.ts']);
  });
});

describe('registerTerminalLinks gesture', () => {
  it('attaches the gesture to the terminal element when it exists', async () => {
    const element = {} as HTMLElement;
    const { stub, gesture, attach } = await harness('', element);
    registerTerminalLinks(stub, gesture, SESSION_ID);
    expect(attach).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenCalledWith(element);
  });

  it('attaches nothing while the terminal has no element yet', async () => {
    const { stub, gesture, attach } = await harness('', undefined);
    registerTerminalLinks(stub, gesture, SESSION_ID);
    expect(attach).not.toHaveBeenCalled();
  });
});

describe('registerTerminalLinks reveal', () => {
  async function activatePathLink(): Promise<void> {
    const { stub, providers, gesture } = await harness('src/real.ts', undefined);
    registerTerminalLinks(stub, gesture, SESSION_ID);
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

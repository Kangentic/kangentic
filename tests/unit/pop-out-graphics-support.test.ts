/**
 * `loadTerminalGraphicsSupport` is the pop-out window's pull of main's graphics
 * status (Sentry DESKTOP-32). A pop-out page has its own copy of
 * terminal-webgl.ts and never mounts App.tsx, so without this pull a terminal
 * there retries WebGL on a machine that cannot have it.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import type { Terminal } from '@xterm/xterm';
import { loadTerminalGraphicsSupport } from '../../src/renderer/pop-out/usePopOutBootstrap';
import { attachWebglRenderer, setTerminalGraphicsSupport } from '../../src/renderer/utils/terminal-webgl';

const WEBGL_AVAILABLE = { softwareRendering: false, webglAvailable: true, webglFeatureStatus: 'unknown' };
const fakeTerminal = { loadAddon: vi.fn() } as unknown as Terminal;

function makeAddon(): {
  onContextLoss(handler: () => void): void;
  dispose(): void;
  clearTextureAtlas(): void;
} {
  return { onContextLoss: () => undefined, dispose: () => undefined, clearTextureAtlas: () => undefined };
}

function stubReadStatus(readStatus: () => Promise<unknown>): void {
  vi.stubGlobal('window', { electronAPI: { gpuHealth: { readStatus } } });
}

/** Lets the pull's `.then` / `.catch` chain run. */
async function flushPromises(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

afterEach(() => {
  setTerminalGraphicsSupport(WEBGL_AVAILABLE);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('loadTerminalGraphicsSupport', () => {
  it('a status saying WebGL is unavailable keeps a later terminal from constructing an addon', async () => {
    stubReadStatus(async () => ({
      softwareRendering: false,
      webglAvailable: false,
      webglFeatureStatus: 'disabled_off',
      noticePending: false,
    }));
    loadTerminalGraphicsSupport();
    await flushPromises();

    const factory = vi.fn(makeAddon);
    const dispose = attachWebglRenderer(fakeTerminal, 'k-pop-out-no-webgl', { createAddon: factory });
    try {
      expect(factory).not.toHaveBeenCalled();
    } finally {
      dispose();
    }
  });

  it('a rejected read leaves WebGL available', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    stubReadStatus(async () => { throw new Error('no handler'); });
    loadTerminalGraphicsSupport();
    await flushPromises();

    const factory = vi.fn(makeAddon);
    const dispose = attachWebglRenderer(fakeTerminal, 'k-pop-out-rejected', { createAddon: factory });
    try {
      expect(factory).toHaveBeenCalledTimes(1);
    } finally {
      dispose();
    }
  });
});

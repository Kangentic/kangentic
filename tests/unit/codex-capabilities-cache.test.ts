/**
 * The Codex adapter keeps a whole `discoverCapabilities` answer once its model
 * list was read, because the Knowledge Graph answer and the automation
 * condition check ask on every run (they declare `answerCapabilities.effort`),
 * and each uncached ask runs `codex --help` and a rollout scan.
 *
 * Discovery itself is mocked, so no CLI runs and no home folder is read.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const discoverMock = vi.fn();
vi.mock('../../src/main/agent/adapters/codex/capability-discovery', () => ({
  discoverCodexCapabilities: (cliPath: string, readCatalog?: (target: null) => Promise<unknown>) => discoverMock(cliPath, readCatalog),
}));

import { CodexAdapter } from '../../src/main/agent/adapters/codex/codex-adapter';
import { CodexModelCatalogCache, type CodexModelCatalog } from '../../src/main/agent/adapters/codex/model-catalog';

const CATALOG: CodexModelCatalog = { models: ['model-a'], displayNames: {}, effortLevels: ['low'], effortsByModel: { 'model-a': ['low'] } };

/**
 * An adapter whose model list read answers `catalog` (or fails), with no
 * app-server run: its cache is built on the cache's own reader parameter.
 */
function adapterReading(read: () => Promise<CodexModelCatalog | null>): CodexAdapter {
  const adapter = new CodexAdapter();
  Object.assign(adapter, { modelCatalog: new CodexModelCatalogCache(read) });
  return adapter;
}

beforeEach(() => {
  discoverMock.mockReset();
  // Discovery asks the catalog the way the real one does, so the cache sees a read.
  discoverMock.mockImplementation(async (_cliPath: string, readCatalog?: (target: null) => Promise<unknown>) => {
    const catalog = readCatalog ? await readCatalog(null) : null;
    return { supportsModelOverride: true, effortLevels: (catalog as CodexModelCatalog | null)?.effortLevels ?? [] };
  });
});

describe('CodexAdapter.discoverCapabilities cache', () => {
  it('answers a repeat ask from the cache once the model list was read, without running discovery again', async () => {
    const adapter = adapterReading(async () => CATALOG);
    const first = await adapter.discoverCapabilities('/usr/bin/codex');
    const second = await adapter.discoverCapabilities('/usr/bin/codex');
    expect(discoverMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
    expect(second.effortLevels).toEqual(['low']);
    // A copy: a caller that edits its answer cannot change the next one.
    second.effortLevels?.push('changed');
    expect((await adapter.discoverCapabilities('/usr/bin/codex')).effortLevels).toEqual(['low']);
  });

  it('keeps an answer whose read settled with no list for the failed read retry window, then asks again', async () => {
    const adapter = adapterReading(async () => { throw new Error('offline'); });
    const startMs = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(startMs);
    try {
      await adapter.discoverCapabilities('/usr/bin/codex');
      await adapter.discoverCapabilities('/usr/bin/codex');
      expect(discoverMock).toHaveBeenCalledTimes(1);
      nowSpy.mockReturnValue(startMs + 5 * 60_000);
      await adapter.discoverCapabilities('/usr/bin/codex');
      expect(discoverMock).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('keeps an answer built from the model list under twelve hours, and runs discovery again at twelve', async () => {
    const adapter = adapterReading(async () => CATALOG);
    const startMs = Date.now();
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(startMs);
    try {
      await adapter.discoverCapabilities('/usr/bin/codex');
      // Past the failed read window, which a list-less answer would not outlive.
      nowSpy.mockReturnValue(startMs + 12 * 60 * 60_000 - 1);
      await adapter.discoverCapabilities('/usr/bin/codex');
      expect(discoverMock).toHaveBeenCalledTimes(1);
      nowSpy.mockReturnValue(startMs + 12 * 60 * 60_000);
      await adapter.discoverCapabilities('/usr/bin/codex');
      expect(discoverMock).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('does not keep an answer built while the read was running, even when the read lands before discovery returns', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      let landRead: (catalog: CodexModelCatalog) => void = () => undefined;
      let readCount = 0;
      const adapter = adapterReading(() => {
        readCount += 1;
        return readCount === 1 ? new Promise((resolve) => { landRead = resolve; }) : Promise.resolve(CATALOG);
      });
      discoverMock.mockImplementationOnce(async (_cliPath: string, readCatalog?: (target: null) => Promise<unknown>) => {
        const catalog = readCatalog ? await readCatalog(null) : null;
        // The read lands while discovery is still scanning the rollouts.
        landRead(CATALOG);
        await new Promise<void>((resolve) => setImmediate(resolve));
        return { supportsModelOverride: true, effortLevels: (catalog as CodexModelCatalog | null)?.effortLevels ?? [] };
      });
      const pending = adapter.discoverCapabilities('/usr/bin/codex');
      await vi.advanceTimersByTimeAsync(8_000);
      expect((await pending).effortLevels).toEqual([]);
      const second = await adapter.discoverCapabilities('/usr/bin/codex');
      expect(discoverMock).toHaveBeenCalledTimes(2);
      expect(second.effortLevels).toEqual(['low']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('asks again on a forced refresh and after the detection cache is reset', async () => {
    const adapter = adapterReading(async () => CATALOG);
    await adapter.discoverCapabilities('/usr/bin/codex');
    await adapter.discoverCapabilities('/usr/bin/codex', true);
    expect(discoverMock).toHaveBeenCalledTimes(2);
    adapter.invalidateDetectionCache();
    await adapter.discoverCapabilities('/usr/bin/codex');
    expect(discoverMock).toHaveBeenCalledTimes(3);
  });
});

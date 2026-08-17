/**
 * Grok Build capability discovery's `--help` fallback path
 * (`src/main/agent/adapters/grok/capability-discovery.ts`), exercised when
 * `~/.grok/models_cache.json` is absent (a fresh install that has never
 * launched grok interactively).
 *
 * `discoverGrokCapabilities` shells out via `exec` (win32) / `execFile`
 * (POSIX), both wrapped in `promisify`. This mirrors the established mocking
 * pattern from `cursor-capability-discovery.test.ts`: `node:child_process`
 * and `node:util` are mocked so `promisify(exec)` resolves to the identity
 * of the mocked `exec` itself, and both `exec`/`execFile` are stubbed
 * identically so the test is correct on both win32 (CI-local) and POSIX
 * (CI Linux) without branching on `process.platform`.
 *
 * Kept in its own file (rather than folded into grok-adapter.test.ts)
 * because a module-level `vi.mock('node:child_process', ...)` is
 * file-scoped and would otherwise shadow child_process for every other
 * test in that shared file.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  exec: vi.fn(),
}));

vi.mock('node:util', () => ({
  promisify: (fn: unknown) => fn,
}));

import { execFile, exec } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  discoverGrokCapabilities,
  clearGrokCapabilityMemo,
} from '../../src/main/agent/adapters/grok/capability-discovery';

const execMock = exec as unknown as ReturnType<typeof vi.fn>;
const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;

let tempGrokHome: string;
const originalGrokHome = process.env.GROK_HOME;

function setHelpOutput(stdout: string): void {
  const result = Promise.resolve({ stdout, stderr: '' });
  execMock.mockReturnValue(result);
  execFileMock.mockReturnValue(result);
}

beforeEach(() => {
  // A fresh, empty GROK_HOME has no models_cache.json, so
  // discoverGrokCapabilities always falls through to readHelpCapabilities.
  tempGrokHome = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-cap-help-'));
  process.env.GROK_HOME = tempGrokHome;
  execMock.mockReset();
  execFileMock.mockReset();
  clearGrokCapabilityMemo();
});

afterEach(() => {
  if (originalGrokHome === undefined) delete process.env.GROK_HOME;
  else process.env.GROK_HOME = originalGrokHome;
  fs.rmSync(tempGrokHome, { recursive: true, force: true });
  clearGrokCapabilityMemo();
});

describe('discoverGrokCapabilities --help fallback (models_cache.json absent)', () => {
  it('reports supportsModelOverride and the hardcoded effort ladder when --help documents both flags', async () => {
    setHelpOutput('Usage: grok\n  -m, --model <model>   Model to use\n  --reasoning-effort <level>   Reasoning effort\n');

    const capabilities = await discoverGrokCapabilities('/usr/bin/grok');

    expect(capabilities.supportsModelOverride).toBe(true);
    // The documented ladder (17-sessions.md / `/effort`), only reported when
    // the flag is present in this build's help text.
    expect(capabilities.effortLevels).toEqual(['low', 'medium', 'high', 'xhigh']);
  });

  it('reports no model override and no effort ladder when --help omits both flags', async () => {
    setHelpOutput('Usage: grok\n  -h, --help    Display help\n');

    const capabilities = await discoverGrokCapabilities('/usr/bin/grok');

    expect(capabilities.supportsModelOverride).toBe(false);
    expect(capabilities.effortLevels).toEqual([]);
  });

  it('returns an empty capabilities object when --help itself fails', async () => {
    const reject = (): Promise<{ stdout: string }> => {
      const promise = Promise.reject(new Error('ENOENT')) as Promise<{ stdout: string }>;
      promise.catch(() => {});
      return promise;
    };
    execMock.mockImplementation(reject);
    execFileMock.mockImplementation(reject);

    const capabilities = await discoverGrokCapabilities('/missing/grok');

    expect(capabilities).toEqual({});
  });
});

/**
 * discoverGrokCapabilities's in-module memo, keyed by cliPath (mirroring
 * antigravity/capability-discovery.ts): a Settings save that repoints
 * agent.cliPaths.grok rebuilds the agent list WITHOUT forceRefresh, and an
 * unkeyed memo would keep reporting the old binary's capabilities. Every
 * test here counts the underlying --help probe (exec + execFile combined,
 * so the assertion is correct on both win32 and POSIX without branching on
 * process.platform) as the "was the probe re-run" signal.
 */
describe('discoverGrokCapabilities memoization (keyed by cliPath)', () => {
  function probeCallCount(): number {
    return execMock.mock.calls.length + execFileMock.mock.calls.length;
  }

  it('memo hit: a second call with the SAME cliPath does not re-probe', async () => {
    setHelpOutput('Usage: grok\n  -m, --model <model>   Model to use\n  --reasoning-effort <level>   Reasoning effort\n');

    const first = await discoverGrokCapabilities('/usr/bin/grok');
    const second = await discoverGrokCapabilities('/usr/bin/grok');

    expect(second).toEqual(first);
    expect(probeCallCount()).toBe(1);
  });

  it('a DIFFERENT cliPath triggers fresh discovery even without forceRefresh', async () => {
    // Red-green: this is the discriminating case for the cliPath-keyed memo
    // - reverting discoveryMemo to a plain `AgentCapabilities | null` (no
    // cliPath field) would make this go red, since the old memo has no path
    // to compare against and would serve the stale first result for the
    // second (different) binary.
    setHelpOutput('Usage: grok\n  -m, --model <model>   Model to use\n');

    await discoverGrokCapabilities('/usr/bin/grok');
    await discoverGrokCapabilities('/usr/local/bin/grok-beta');

    expect(probeCallCount()).toBe(2);
  });

  it('forceRefresh bypasses the memo even for the SAME cliPath', async () => {
    setHelpOutput('Usage: grok\n  -m, --model <model>   Model to use\n');

    await discoverGrokCapabilities('/usr/bin/grok');
    await discoverGrokCapabilities('/usr/bin/grok', true);

    expect(probeCallCount()).toBe(2);
  });
});

/**
 * readModelsCache's fall-through-to-help branches. Each test asserts
 * `capabilities.models` is undefined, which only the --help path can
 * produce (readModelsCache always sets `models` on a successful parse; it
 * never returns an object with an empty models array - it returns null
 * instead). That's positive evidence the assertions below exercised the
 * fallback and not some other path that happens to agree with the mocked
 * --help output.
 */
describe('discoverGrokCapabilities readModelsCache fall-through', () => {
  it('falls through to --help when models_cache.json is corrupt JSON', async () => {
    fs.writeFileSync(path.join(tempGrokHome, 'models_cache.json'), '{not valid json');
    setHelpOutput('Usage: grok\n  -m, --model <model>   Model to use\n');

    const capabilities = await discoverGrokCapabilities('/usr/bin/grok');

    expect(capabilities.supportsModelOverride).toBe(true);
    expect(capabilities.models).toBeUndefined();
  });

  it('falls through to --help when models is missing or not an object', async () => {
    setHelpOutput('Usage: grok\n  -m, --model <model>   Model to use\n');

    fs.writeFileSync(path.join(tempGrokHome, 'models_cache.json'), JSON.stringify({ other: true }));
    const missingModels = await discoverGrokCapabilities('/usr/bin/grok');
    expect(missingModels.supportsModelOverride).toBe(true);
    expect(missingModels.models).toBeUndefined();

    // Same cliPath as above: clear the memo so the second write is actually
    // re-read rather than served from the first call's cached result.
    clearGrokCapabilityMemo();
    fs.writeFileSync(path.join(tempGrokHome, 'models_cache.json'), JSON.stringify({ models: 'not-an-object' }));
    const nonObjectModels = await discoverGrokCapabilities('/usr/bin/grok');
    expect(nonObjectModels.supportsModelOverride).toBe(true);
    expect(nonObjectModels.models).toBeUndefined();
  });

  it('falls through to --help when every model in the cache is hidden', async () => {
    fs.writeFileSync(path.join(tempGrokHome, 'models_cache.json'), JSON.stringify({
      models: { 'grok-secret': { info: { id: 'grok-secret', name: 'Hidden', hidden: true } } },
    }));
    setHelpOutput('Usage: grok\n  -m, --model <model>   Model to use\n  --reasoning-effort <level>   Reasoning effort\n');

    const capabilities = await discoverGrokCapabilities('/usr/bin/grok');

    expect(capabilities.supportsModelOverride).toBe(true);
    expect(capabilities.effortLevels).toEqual(['low', 'medium', 'high', 'xhigh']);
    expect(capabilities.models).toBeUndefined();
  });
});

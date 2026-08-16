/**
 * GrokAdapter.probeAuth() (src/main/agent/adapters/grok/grok-adapter.ts) -
 * the `grok models` exec branch that drives the Settings amber "not
 * authenticated" warning. Every existing cross-agent guard
 * (agent-submission-verifier-shape, agent-summarize-shape, ...) only checks
 * that GrokAdapter *implements* probeAuth with the right shape; none of
 * them exercise the "not authenticated" string match or the exec-failure
 * fallback, so those two branches were unguarded before this file.
 *
 * Kept in its own file (rather than folded into grok-adapter.test.ts)
 * because a module-level `vi.mock('node:child_process', ...)` is
 * file-scoped and would otherwise shadow child_process for every other
 * test in that shared file - the same constraint documented in
 * grok-capability-discovery-help-fallback.test.ts.
 *
 * The detector's own PATH-lookup / --version probe pipeline is stubbed via
 * a spy on `detector.detect` (the private-field-access pattern already
 * established in opencode-adapter-wiring.test.ts) rather than also mocking
 * `which` and exec-version: probeAuth's own `grok models` exec branch is
 * what is under test here, not detection.
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
import { GrokAdapter } from '../../src/main/agent/adapters/grok/grok-adapter';
import type { AgentInfo } from '../../src/main/agent/agent-adapter';

const execMock = exec as unknown as ReturnType<typeof vi.fn>;
const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;

/** Bypasses the real which()/--version pipeline; only probeAuth's own exec branch is under test. */
function stubDetection(adapter: GrokAdapter, info: AgentInfo): void {
  const detector = (adapter as unknown as { detector: { detect: () => Promise<AgentInfo> } }).detector;
  vi.spyOn(detector, 'detect').mockResolvedValue(info);
}

function setModelsOutput(stdout: string): void {
  const result = Promise.resolve({ stdout, stderr: '' });
  execMock.mockReturnValue(result);
  execFileMock.mockReturnValue(result);
}

beforeEach(() => {
  execMock.mockReset();
  execFileMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GrokAdapter.probeAuth', () => {
  it('returns null without shelling out to `grok models` when the CLI is not detected', async () => {
    const adapter = new GrokAdapter();
    stubDetection(adapter, { found: false, path: null, version: null });

    const result = await adapter.probeAuth();

    expect(result).toBeNull();
    expect(execMock).not.toHaveBeenCalled();
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('returns true when `grok models` succeeds without the "not authenticated" string', async () => {
    const adapter = new GrokAdapter();
    stubDetection(adapter, { found: true, path: '/usr/bin/grok', version: '1.0.0' });
    setModelsOutput('grok-4.6\ngrok-4-fast\n');

    const result = await adapter.probeAuth();

    expect(result).toBe(true);
  });

  it('returns false when `grok models` reports the user is not authenticated', async () => {
    const adapter = new GrokAdapter();
    stubDetection(adapter, { found: true, path: '/usr/bin/grok', version: '1.0.0' });
    setModelsOutput('You are not authenticated. Run `grok login` to continue.\n');

    const result = await adapter.probeAuth();

    expect(result).toBe(false);
  });

  it('matches the "not authenticated" string case-insensitively', async () => {
    const adapter = new GrokAdapter();
    stubDetection(adapter, { found: true, path: '/usr/bin/grok', version: '1.0.0' });
    setModelsOutput('NOT AUTHENTICATED\n');

    const result = await adapter.probeAuth();

    expect(result).toBe(false);
  });

  it('returns null when the `grok models` invocation throws (timeout, ENOENT, ...)', async () => {
    const adapter = new GrokAdapter();
    stubDetection(adapter, { found: true, path: '/usr/bin/grok', version: '1.0.0' });
    const reject = (): Promise<{ stdout: string }> => {
      const promise = Promise.reject(new Error('ETIMEDOUT')) as Promise<{ stdout: string }>;
      promise.catch(() => {});
      return promise;
    };
    execMock.mockImplementation(reject);
    execFileMock.mockImplementation(reject);

    const result = await adapter.probeAuth();

    expect(result).toBeNull();
  });
});

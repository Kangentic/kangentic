/**
 * An `AgentDetector` detection still running when its cache is invalidated
 * must not fill the cache. Measured in a /preview (2026-10-25): the CLI path
 * override was saved while startup detection was probing PATH, the stale
 * detection then cached the PATH result, and every spawn after that ran the
 * real CLI instead of the configured one, though Settings showed the override.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('which', () => ({
  default: vi.fn(),
}));

vi.mock('../../src/main/agent/shared/exec-version', () => ({
  execVersion: vi.fn(),
}));

// Both CLIs exist on disk; the probe checks that before it runs one.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, default: { ...actual, existsSync: vi.fn().mockReturnValue(true) } };
});

import which from 'which';
import { AgentDetector } from '../../src/main/agent/shared/agent-detector';
import { execVersion } from '../../src/main/agent/shared/exec-version';

const PATH_CLI = '/usr/local/bin/testcli';
const OVERRIDE_CLI = '/opt/mock/testcli';

function makeDetector(): AgentDetector {
  return new AgentDetector({ binaryName: 'testcli', parseVersion: (raw) => raw.trim() || null });
}

describe('AgentDetector - invalidated while a detection runs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(which).mockResolvedValue([PATH_CLI] as never);
  });

  it('answers the stale detection\'s callers but caches only what the new override finds', async () => {
    let finishPathProbe: (value: { stdout: string; stderr: string }) => void = () => undefined;
    vi.mocked(execVersion).mockImplementation((binaryPath: string) => {
      if (binaryPath === PATH_CLI) return new Promise((resolve) => { finishPathProbe = resolve; });
      return Promise.resolve({ stdout: 'override 1.0', stderr: '' });
    });
    const detector = makeDetector();

    // Startup detection, before any override is saved.
    const startup = detector.detect(null);
    await vi.waitFor(() => expect(vi.mocked(execVersion).mock.calls.map((call) => call[0])).toContain(PATH_CLI));

    // The override is saved meanwhile, and the next spawn detects with it.
    detector.invalidateCache();
    const withOverride = await detector.detect(OVERRIDE_CLI);
    expect(withOverride).toMatchObject({ found: true, path: OVERRIDE_CLI });

    // The startup probe lands last.
    finishPathProbe({ stdout: 'path 9.9', stderr: '' });
    await expect(startup).resolves.toMatchObject({ found: true, path: PATH_CLI });

    // Red before the fix: the late PATH result overwrote the override's.
    await expect(detector.detect(OVERRIDE_CLI)).resolves.toMatchObject({ path: OVERRIDE_CLI });
    expect(detector.getCachedVersion()).toBe('override 1.0');
  });

  it('still shares one detection between concurrent callers and caches it', async () => {
    vi.mocked(execVersion).mockResolvedValue({ stdout: 'path 9.9', stderr: '' });
    const detector = makeDetector();
    const [first, second] = await Promise.all([detector.detect(null), detector.detect(null)]);
    expect(first).toBe(second);
    expect(execVersion).toHaveBeenCalledTimes(1);
    await detector.detect(null);
    expect(execVersion).toHaveBeenCalledTimes(1);
  });
});

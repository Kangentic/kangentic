/**
 * `AgentDetector` caches one result per override path. Before this it cached
 * the FIRST result whatever override a later call passed, so a project whose
 * `agent.cliPaths` differed from another project's spawned the other project's
 * CLI until something invalidated the cache.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('which', () => ({
  default: vi.fn(),
}));

vi.mock('../../src/main/agent/shared/exec-version', () => ({
  execVersion: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, default: { ...actual, existsSync: vi.fn().mockReturnValue(true) } };
});

import which from 'which';
import { AgentDetector } from '../../src/main/agent/shared/agent-detector';
import { execVersion } from '../../src/main/agent/shared/exec-version';

const PATH_CLI = '/usr/local/bin/testcli';
const PROJECT_A_CLI = '/opt/project-a/testcli';
const PROJECT_B_CLI = '/opt/project-b/testcli';

const VERSIONS: Record<string, string> = {
  [PATH_CLI]: 'path 1.0',
  [PROJECT_A_CLI]: 'a 2.0',
  [PROJECT_B_CLI]: 'b 3.0',
};

function makeDetector(): AgentDetector {
  return new AgentDetector({ binaryName: 'testcli', parseVersion: (raw) => raw.trim() || null });
}

describe('AgentDetector - cache per override path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(which).mockResolvedValue([PATH_CLI] as never);
    vi.mocked(execVersion).mockImplementation((binaryPath: string) =>
      Promise.resolve({ stdout: VERSIONS[binaryPath] ?? '', stderr: '' }));
  });

  it('answers each override with its own CLI, not the first one detected', async () => {
    const detector = makeDetector();
    await expect(detector.detect(PROJECT_A_CLI)).resolves.toMatchObject({ path: PROJECT_A_CLI, version: 'a 2.0' });
    // Red before the fix: this returned project A's cached CLI.
    await expect(detector.detect(PROJECT_B_CLI)).resolves.toMatchObject({ path: PROJECT_B_CLI, version: 'b 3.0' });
    await expect(detector.detect(null)).resolves.toMatchObject({ path: PATH_CLI, version: 'path 1.0' });
  });

  it('probes each override once and serves repeats from the cache', async () => {
    const detector = makeDetector();
    await detector.detect(PROJECT_A_CLI);
    await detector.detect(PROJECT_B_CLI);
    await detector.detect(PROJECT_A_CLI);
    await detector.detect(PROJECT_B_CLI);
    expect(vi.mocked(execVersion).mock.calls.map((call) => call[0])).toEqual([PROJECT_A_CLI, PROJECT_B_CLI]);
  });

  it('runs detections for different overrides side by side, sharing only same-override callers', async () => {
    const detector = makeDetector();
    const [firstA, secondA, onlyB] = await Promise.all([
      detector.detect(PROJECT_A_CLI),
      detector.detect(PROJECT_A_CLI),
      detector.detect(PROJECT_B_CLI),
    ]);
    expect(firstA).toBe(secondA);
    expect(onlyB.path).toBe(PROJECT_B_CLI);
    expect(execVersion).toHaveBeenCalledTimes(2);
  });

  it('reports the version of the CLI a caller names, else the latest detection', async () => {
    const detector = makeDetector();
    await detector.detect(PROJECT_A_CLI);
    await detector.detect(PROJECT_B_CLI);
    expect(detector.getCachedVersion(PROJECT_A_CLI)).toBe('a 2.0');
    expect(detector.getCachedVersion(PROJECT_B_CLI)).toBe('b 3.0');
    expect(detector.getCachedVersion()).toBe('b 3.0');
    // A shim swap hands the builder a sibling path no detection found.
    expect(detector.getCachedVersion('/opt/project-a/testcli.ps1')).toBe('b 3.0');
  });

  it('invalidation clears every override', async () => {
    const detector = makeDetector();
    await detector.detect(PROJECT_A_CLI);
    await detector.detect(PROJECT_B_CLI);
    detector.invalidateCache();
    expect(detector.getCachedVersion()).toBeNull();
    await detector.detect(PROJECT_A_CLI);
    await detector.detect(PROJECT_B_CLI);
    expect(execVersion).toHaveBeenCalledTimes(4);
  });
});

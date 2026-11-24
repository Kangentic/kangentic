/**
 * The wait a spawn makes for its CLI's capability discovery.
 *
 * Cursor, Ollama and Antigravity build their command from what discovery
 * learned, and a launch no longer runs discovery for a CLI nobody has started.
 * If this breaks, a spawn builds from a cold cache (a model name the CLI
 * refuses, a flag the CLI does not take), or hangs behind a CLI that never
 * answers.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DiscoveryWarmup } from '../../src/main/agent/shared/discovery-warmup';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** A discovery that answers when the test says so. */
function controlledDiscovery() {
  const settle = new Map<string, { resolve: () => void; reject: (error: Error) => void }>();
  const discover = vi.fn((cliPath: string) => new Promise<void>((resolve, reject) => {
    settle.set(cliPath, { resolve, reject });
  }));
  return { discover, settle };
}

describe('DiscoveryWarmup', () => {
  it('waits for the discovery of the CLI the spawn detected', async () => {
    const warmup = new DiscoveryWarmup();
    const { discover, settle } = controlledDiscovery();
    let waited = false;
    void warmup.settle(['/bin/agent'], discover, 8_000).then(() => {
      waited = true;
    });

    await vi.advanceTimersByTimeAsync(1_000);
    expect(discover).toHaveBeenCalledWith('/bin/agent');
    expect(waited).toBe(false);

    settle.get('/bin/agent')?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(waited).toBe(true);
  });

  it('runs one discovery per CLI path, and a later spawn finds it done', async () => {
    const warmup = new DiscoveryWarmup();
    const { discover, settle } = controlledDiscovery();
    const first = warmup.settle(['/bin/agent'], discover, 8_000);
    const second = warmup.settle(['/bin/agent'], discover, 8_000);
    settle.get('/bin/agent')?.resolve();
    await Promise.all([first, second]);

    await warmup.settle(['/bin/agent'], discover, 8_000);

    expect(discover).toHaveBeenCalledTimes(1);
  });

  it('lets the spawn go at the bound when the CLI has not answered', async () => {
    const warmup = new DiscoveryWarmup();
    const { discover } = controlledDiscovery();
    let waited = false;
    void warmup.settle(['/bin/slow-agent'], discover, 8_000).then(() => {
      waited = true;
    });

    await vi.advanceTimersByTimeAsync(7_999);
    expect(waited).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(waited).toBe(true);
  });

  it('asks again after a discovery that failed, and after a reset', async () => {
    const warmup = new DiscoveryWarmup();
    const { discover, settle } = controlledDiscovery();
    const failed = warmup.settle(['/bin/agent'], discover, 8_000);
    settle.get('/bin/agent')?.reject(new Error('the CLI could not be started'));
    await failed;

    const retried = warmup.settle(['/bin/agent'], discover, 8_000);
    settle.get('/bin/agent')?.resolve();
    await retried;
    expect(discover).toHaveBeenCalledTimes(2);

    // The CLI path setting changed: what was read says nothing about the new CLI.
    warmup.reset();
    const afterReset = warmup.settle(['/bin/agent'], discover, 8_000);
    settle.get('/bin/agent')?.resolve();
    await afterReset;
    expect(discover).toHaveBeenCalledTimes(3);
  });

  it('starts nothing for a spawn whose CLI was not detected on this machine', async () => {
    const warmup = new DiscoveryWarmup();
    const { discover } = controlledDiscovery();

    await warmup.settle([], discover, 8_000);

    expect(discover).not.toHaveBeenCalled();
  });
});

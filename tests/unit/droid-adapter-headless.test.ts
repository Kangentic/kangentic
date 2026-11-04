/**
 * DroidAdapter's headless-run wiring: `discoverCapabilities` forwards
 * forceRefresh to the cached reader, and `answerFromContext` passes the
 * reasoning effort to `droid exec` only when one is chosen.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { readHelp, runCliPrintAnswer } = vi.hoisted(() => ({
  readHelp: vi.fn(async (): Promise<string> => 'Available Models:\n  model-a  Model A\n'),
  runCliPrintAnswer: vi.fn(async (): Promise<string> => 'answer'),
}));

// Route the adapter's capability read through a counting reader instead of the real `droid exec --help`.
vi.mock('../../src/main/agent/adapters/droid/capability-discovery', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/main/agent/adapters/droid/capability-discovery')>();
  return {
    ...original,
    discoverDroidCapabilities: (cliPath: string, forceRefresh?: boolean) =>
      original.discoverDroidCapabilities(cliPath, forceRefresh, readHelp),
  };
});

vi.mock('../../src/main/agent/shared/cli-answer', () => ({ runCliPrintAnswer }));

import { DroidAdapter } from '../../src/main/agent/adapters/droid';
import { clearDroidCapabilityCache } from '../../src/main/agent/adapters/droid/capability-discovery';

beforeEach(() => {
  clearDroidCapabilityCache();
  readHelp.mockClear();
  runCliPrintAnswer.mockClear();
});

describe('DroidAdapter.discoverCapabilities', () => {
  it('reads once by default and again only when forceRefresh is true', async () => {
    const adapter = new DroidAdapter();
    await adapter.discoverCapabilities('/usr/bin/droid');
    await adapter.discoverCapabilities('/usr/bin/droid');
    expect(readHelp).toHaveBeenCalledTimes(1);
    await adapter.discoverCapabilities('/usr/bin/droid', true);
    expect(readHelp).toHaveBeenCalledTimes(2);
  });
});

describe('DroidAdapter.answerFromContext', () => {
  function lastArgs(): string[] {
    const calls = runCliPrintAnswer.mock.calls as unknown as Array<[{ args: string[] }]>;
    return calls[calls.length - 1][0].args;
  }

  it('passes -r <effort> after --model <id>', async () => {
    await new DroidAdapter().answerFromContext('question', '/usr/bin/droid', '/home/dev/project', 'model-a', { effort: 'high' });
    const args = lastArgs();
    expect(args.indexOf('--model')).toBeGreaterThan(-1);
    expect(args[args.indexOf('--model') + 1]).toBe('model-a');
    expect(args.indexOf('-r')).toBeGreaterThan(args.indexOf('--model'));
    expect(args[args.indexOf('-r') + 1]).toBe('high');
  });

  it('omits -r when no effort is given', async () => {
    await new DroidAdapter().answerFromContext('question', '/usr/bin/droid', '/home/dev/project', 'model-a');
    expect(lastArgs()).not.toContain('-r');
    await new DroidAdapter().answerFromContext('question', '/usr/bin/droid', '/home/dev/project', 'model-a', {});
    expect(lastArgs()).not.toContain('-r');
  });

  it('accepts an effort and declares no default, so an unset level passes no flag', () => {
    const capabilities = new DroidAdapter().answerCapabilities;
    expect(capabilities.effort).toBe(true);
    expect('defaultEffort' in capabilities).toBe(false);
  });
});

/**
 * Grok's idle-usage read (`GROK_ACCOUNT_SUPPORT.readIdleUsage` -> `readGrokBilling`): a JSON-RPC
 * exchange over `grok agent stdio`. The CLI is a fake child; only the message protocol is real.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeChild extends EventEmitter {
  stdin: { write: ReturnType<typeof vi.fn>; on: ReturnType<typeof vi.fn> };
  stdout: EventEmitter;
  stderr: { resume: ReturnType<typeof vi.fn> };
}

const spawnCli = vi.fn();
const stopCli = vi.fn();
vi.mock('../../src/main/agent/shared/cli-print', () => ({ spawnCli, stopCli }));

const { GROK_ACCOUNT_SUPPORT } = await import('../../src/main/agent/adapters/grok/accounts');
const { UnreadableUsageError } = await import('../../src/main/accounts/account-support');

let child: FakeChild;

function readUsage(): Promise<unknown> {
  return GROK_ACCOUNT_SUPPORT.readIdleUsage!('grok', null);
}

function say(message: object): void {
  child.stdout.emit('data', Buffer.from(`${JSON.stringify(message)}\n`));
}

function writtenMessages(): Array<{ id: number; method?: string }> {
  return child.stdin.write.mock.calls.map((call) => JSON.parse(String(call[0])) as { id: number; method?: string });
}

beforeEach(() => {
  child = Object.assign(new EventEmitter(), {
    stdin: { write: vi.fn(), on: vi.fn() },
    stdout: new EventEmitter(),
    stderr: { resume: vi.fn() },
  }) as FakeChild;
  spawnCli.mockReset();
  stopCli.mockReset();
  spawnCli.mockReturnValue(child);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('readGrokBilling through readIdleUsage', () => {
  it('sends the billing request only after the answer to initialize, and returns the windows', async () => {
    const pending = readUsage();
    expect(writtenMessages().map((message) => message.id)).toEqual([1]);

    say({ jsonrpc: '2.0', id: 1, result: {} });
    expect(writtenMessages().map((message) => message.id)).toEqual([1, 2]);
    expect(writtenMessages()[1].method).toBe('_x.ai/billing');

    say({ jsonrpc: '2.0', id: 2, result: { config: { creditUsagePercent: 12 } } });
    const windows = (await pending) as Array<{ usedPercentage: number }>;
    expect(windows[0].usedPercentage).toBe(12);
    expect(stopCli).toHaveBeenCalledTimes(1);
  });

  it('ignores an id 1 line that carries a method (a request of Grok own)', async () => {
    const pending = readUsage();
    say({ jsonrpc: '2.0', id: 1, method: 'session/request_permission', params: {} });
    expect(writtenMessages().map((message) => message.id)).toEqual([1]);
    child.emit('exit', 0);
    await pending;
  });

  it('resolves null on an id 2 error, so the last values are kept', async () => {
    const pending = readUsage();
    say({ jsonrpc: '2.0', id: 1, result: {} });
    say({ jsonrpc: '2.0', id: 2, error: { code: -32000, message: 'not signed in' } });
    await expect(pending).resolves.toBeNull();
    expect(stopCli).toHaveBeenCalledTimes(1);
  });

  it('throws UnreadableUsageError when the result has no config', async () => {
    const pending = readUsage();
    say({ jsonrpc: '2.0', id: 1, result: {} });
    say({ jsonrpc: '2.0', id: 2, result: { somethingElse: true } });
    await expect(pending).rejects.toBeInstanceOf(UnreadableUsageError);
  });

  it('resolves null when the child exits, and stops it once', async () => {
    const pending = readUsage();
    child.emit('exit', 1);
    await expect(pending).resolves.toBeNull();
    expect(stopCli).toHaveBeenCalledTimes(1);
  });

  it('resolves null on the timeout, and stops the child once', async () => {
    vi.useFakeTimers();
    const pending = readUsage();
    await vi.advanceTimersByTimeAsync(20_000);
    await expect(pending).resolves.toBeNull();
    expect(stopCli).toHaveBeenCalledTimes(1);
  });
});

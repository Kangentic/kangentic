import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentAdapter } from '../../src/main/agent/agent-adapter';
import { stopBackgroundSessionOnAccount } from '../../src/main/accounts/account-background-stop';
import { setAccountService, type AccountService } from '../../src/main/accounts/account-service';

const OPTIONS = { agentSessionId: 'agent-session-1', cliPath: 'cli' };

type StopOptions = { agentSessionId: string; cliPath: string; env?: Record<string, string> };

function adapterReturning(results: boolean[]) {
  const stopBackgroundSession = vi.fn(async (_options: StopOptions) => results.shift() ?? false);
  return { adapter: { name: 'test-agent', stopBackgroundSession } as unknown as AgentAdapter, stopBackgroundSession };
}

function serviceReturning(envs: Array<Record<string, string> | undefined>) {
  const envsForBackgroundStop = vi.fn((_agent: string, _accountId: string | null | undefined) => envs);
  setAccountService({ envsForBackgroundStop } as unknown as AccountService);
  return envsForBackgroundStop;
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  setAccountService(null);
  vi.restoreAllMocks();
});

describe('stopBackgroundSessionOnAccount', () => {
  it('runs the stop under the known account env', async () => {
    const { adapter, stopBackgroundSession } = adapterReturning([true]);
    const envsForBackgroundStop = serviceReturning([{ HOME_VAR: '/accounts/two' }]);

    expect(await stopBackgroundSessionOnAccount(adapter, OPTIONS, 'account-two')).toBe(true);

    expect(envsForBackgroundStop).toHaveBeenCalledWith('test-agent', 'account-two');
    expect(stopBackgroundSession).toHaveBeenCalledTimes(1);
    expect(stopBackgroundSession).toHaveBeenCalledWith({ ...OPTIONS, env: { HOME_VAR: '/accounts/two' } });
  });

  it('tries each env until one returns true and stops there', async () => {
    const { adapter, stopBackgroundSession } = adapterReturning([false, true, true]);
    serviceReturning([undefined, { HOME_VAR: '/accounts/two' }, { HOME_VAR: '/accounts/three' }]);

    expect(await stopBackgroundSessionOnAccount(adapter, OPTIONS, null)).toBe(true);

    expect(stopBackgroundSession).toHaveBeenCalledTimes(2);
    expect('env' in stopBackgroundSession.mock.calls[0][0]).toBe(false);
    expect(stopBackgroundSession.mock.calls[1][0].env).toEqual({ HOME_VAR: '/accounts/two' });
  });

  it('returns false when no env stops it', async () => {
    const { adapter, stopBackgroundSession } = adapterReturning([false, false]);
    serviceReturning([{ HOME_VAR: '/a' }, { HOME_VAR: '/b' }]);
    expect(await stopBackgroundSessionOnAccount(adapter, OPTIONS)).toBe(false);
    expect(stopBackgroundSession).toHaveBeenCalledTimes(2);
  });

  it('makes one call with no env when no account service is registered', async () => {
    const { adapter, stopBackgroundSession } = adapterReturning([true]);
    expect(await stopBackgroundSessionOnAccount(adapter, OPTIONS, 'account-two')).toBe(true);
    expect(stopBackgroundSession).toHaveBeenCalledTimes(1);
    expect(stopBackgroundSession.mock.calls[0][0]).toStrictEqual(OPTIONS);
  });

  it('makes one call with no env when listing the envs throws', async () => {
    const { adapter, stopBackgroundSession } = adapterReturning([true]);
    setAccountService({
      envsForBackgroundStop: () => { throw new Error('database closed'); },
    } as unknown as AccountService);

    expect(await stopBackgroundSessionOnAccount(adapter, OPTIONS, 'account-two')).toBe(true);
    expect(stopBackgroundSession).toHaveBeenCalledTimes(1);
    expect(stopBackgroundSession.mock.calls[0][0]).toStrictEqual(OPTIONS);
  });

  it('is false for an adapter with no background stop', async () => {
    const adapter = { name: 'test-agent' } as unknown as AgentAdapter;
    expect(await stopBackgroundSessionOnAccount(adapter, OPTIONS)).toBe(false);
  });
});

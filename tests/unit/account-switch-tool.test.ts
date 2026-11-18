/**
 * `kangentic_switch_account` (task #1113): an agent moves its own session to another listed account
 * instead of suggesting `/login`, which replaces the login of the folder its session runs in. The
 * handler acts only on the caller's own task, and every refusal tells the agent what it can pick.
 * The login file watch beside it starts and stops one watch per home as the list changes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleSwitchAccount } from '../../src/main/agent/commands/account-commands';
import { setTaskAccountSwitcher, type TaskAccountSwitcher } from '../../src/main/accounts/account-task-switch';
import { AccountLoginWatch } from '../../src/main/accounts/account-login-watch';
import type { CommandContext } from '../../src/main/agent/commands/types';

function contextFor(callerTaskId: string | null): CommandContext {
  return { callerTaskId, callerKind: 'agent' } as unknown as CommandContext;
}

afterEach(() => setTaskAccountSwitcher(null));

describe('handleSwitchAccount', () => {
  it('refuses a call from outside a task session, so no other task can be moved', async () => {
    const switcher = vi.fn<TaskAccountSwitcher>();
    setTaskAccountSwitcher(switcher);
    const response = await handleSwitchAccount({ account: 'b@example.com' }, contextFor(null));
    expect(response.success).toBe(false);
    expect(switcher).not.toHaveBeenCalled();
  });

  it('asks for the caller\'s own task, never one named in the parameters', async () => {
    const switcher = vi.fn<TaskAccountSwitcher>(async () => ({ ok: true, accountName: 'b@example.com', agent: 'claude' }));
    setTaskAccountSwitcher(switcher);
    const response = await handleSwitchAccount({ account: ' b@example.com ', taskId: 'someone-else' }, contextFor('own-task'));
    expect(switcher).toHaveBeenCalledWith('own-task', 'b@example.com');
    expect(response.success).toBe(true);
    expect(response.message).toContain('End your turn');
  });

  it('lists the accounts that can run when the name matches none', async () => {
    setTaskAccountSwitcher(async () => ({ ok: false, reason: 'unknown-account', runnable: ['b@example.com', 'c@example.com'], current: 'a@example.com' }));
    const response = await handleSwitchAccount({ account: 'z@example.com' }, contextFor('own-task'));
    expect(response.success).toBe(false);
    expect(response.error).toContain('b@example.com, c@example.com');
    expect(response.error).toContain('runs as a@example.com');
  });

  it('points a signed-out account at Sign in rather than at /login', async () => {
    setTaskAccountSwitcher(async () => ({ ok: false, reason: 'not-signed-in', runnable: [], current: null }));
    const response = await handleSwitchAccount({ account: 'b@example.com' }, contextFor('own-task'));
    expect(response.error).toContain('Sign in');
    expect(response.error).not.toContain('/login');
  });
});

describe('AccountLoginWatch', () => {
  it('watches each home once, and stops a watch whose account left the list', () => {
    const closed: string[] = [];
    const watch = new AccountLoginWatch(() => undefined, (filePath) => ({ close: () => closed.push(filePath) }));
    watch.sync([{ accountId: 'own', filePath: '/home/.credentials.json' }, { accountId: 'two', filePath: '/accounts/2/.credentials.json' }]);
    watch.sync([{ accountId: 'own', filePath: '/home/.credentials.json' }]);
    expect(watch.watchedFiles()).toEqual(['/home/.credentials.json']);
    expect(closed).toEqual(['/accounts/2/.credentials.json']);
  });

  it('reports a change against the account whose home holds the file', () => {
    const changed: string[] = [];
    let fire: () => void = () => undefined;
    const watch = new AccountLoginWatch((accountId) => changed.push(accountId), (_filePath, onChange) => {
      fire = onChange;
      return { close: () => undefined };
    });
    watch.sync([{ accountId: 'own', filePath: '/home/.credentials.json' }]);
    fire();
    expect(changed).toEqual(['own']);
  });

  it('re-assigns a file to another account by closing the old watcher and opening a new one', () => {
    const changed: string[] = [];
    const opened: Array<{ fire: () => void; closed: boolean }> = [];
    const watch = new AccountLoginWatch((accountId) => changed.push(accountId), (_filePath, onChange) => {
      const entry = { fire: onChange, closed: false };
      opened.push(entry);
      return { close: () => { entry.closed = true; } };
    });
    watch.sync([{ accountId: 'first', filePath: '/home/.credentials.json' }]);
    watch.sync([{ accountId: 'second', filePath: '/home/.credentials.json' }]);
    expect(opened).toHaveLength(2);
    expect(opened[0].closed).toBe(true);
    expect(opened[1].closed).toBe(false);
    expect(watch.watchedFiles()).toEqual(['/home/.credentials.json']);
    opened[1].fire();
    expect(changed).toEqual(['second']);
  });

  it('swallows a factory that throws for one file and still watches the others', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const watch = new AccountLoginWatch(() => undefined, (filePath) => {
        if (filePath === '/bad/.credentials.json') throw new Error('EMFILE');
        return { close: () => undefined };
      });
      expect(() => watch.sync([
        { accountId: 'a', filePath: '/a/.credentials.json' },
        { accountId: 'bad', filePath: '/bad/.credentials.json' },
        { accountId: 'c', filePath: '/c/.credentials.json' },
      ])).not.toThrow();
      expect(watch.watchedFiles()).toEqual(['/a/.credentials.json', '/c/.credentials.json']);
    } finally {
      warn.mockRestore();
    }
  });

  it('dispose closes every watcher and leaves nothing watched', () => {
    const closed: string[] = [];
    const watch = new AccountLoginWatch(() => undefined, (filePath) => ({ close: () => closed.push(filePath) }));
    watch.sync([{ accountId: 'a', filePath: '/a/.credentials.json' }, { accountId: 'b', filePath: '/b/.credentials.json' }]);
    watch.dispose();
    expect(closed.sort()).toEqual(['/a/.credentials.json', '/b/.credentials.json']);
    expect(watch.watchedFiles()).toEqual([]);
  });
});

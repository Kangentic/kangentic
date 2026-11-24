/**
 * The `ssh:detectClient` IPC handler turns the renderer's options into the admin's
 * `{ refresh }`. The UI tier runs over the mock bridge and never reaches this handler,
 * and `ssh-host-admin.test.ts` calls the admin directly, so nothing else covers how a
 * raw IPC argument becomes a refresh.
 *
 * What a user loses if it goes: the SSH tab's re-check stops forcing a fresh `ssh -V`
 * (a client installed while the app runs keeps reading "ssh not found"), or a stray
 * payload forces one on every call.
 *
 * This registers the real `registerSshHostHandlers` against a recording `ipcMain` and
 * invokes the handler it registered. The admin class is a stub that records its
 * `detectClient` argument, because the admin's own behavior has its own tests. The
 * other modules the handler file imports are stubbed only so the import chain loads.
 *
 * Red-green: change the handler's `options?.refresh === true` to `Boolean(options?.refresh)`
 * and the non-boolean case fails; drop the argument and the refresh case fails.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IPC } from '../../src/shared/ipc-channels';

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  detectClient: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', getPath: () => '/tmp/kangentic-test' },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => {
      mocks.handlers.set(channel, handler);
    },
  },
}));
vi.mock('../../src/main/remote/ssh-host-admin', () => ({
  SshHostAdmin: class {
    detectClient = mocks.detectClient;
  },
}));
vi.mock('../../src/main/remote/ssh-setup', () => ({ defaultSshSetupDeps: () => ({}) }));
vi.mock('../../src/main/ipc/handlers/projects', () => ({
  cleanupProject: vi.fn(),
  revealHostProjects: vi.fn(),
}));
vi.mock('../../src/main/ipc/helpers/hide-project', () => ({
  suspendProjectForHiding: vi.fn(),
  takeHiddenProjectOutOfApp: vi.fn(),
}));
vi.mock('../../src/main/db/database', () => ({ getExistingProjectDb: vi.fn() }));
vi.mock('../../src/main/db/repositories/task-repository', () => ({ TaskRepository: class {} }));

import { registerSshHostHandlers } from '../../src/main/ipc/handlers/ssh-hosts';
import type { IpcContext } from '../../src/main/ipc/ipc-context';

function registerAndGetDetectHandler(): (event: unknown, options?: unknown) => Promise<unknown> {
  // Only `remoteHosting` is read while registering; every other member is read lazily
  // inside admin callbacks, and the admin is a stub here.
  const context = { remoteHosting: {} } as unknown as IpcContext;
  registerSshHostHandlers(context);
  const handler = mocks.handlers.get(IPC.SSH_DETECT_CLIENT);
  if (!handler) throw new Error('the SSH_DETECT_CLIENT handler was not registered');
  return handler as (event: unknown, options?: unknown) => Promise<unknown>;
}

describe('ssh:detectClient handler', () => {
  beforeEach(() => {
    mocks.handlers.clear();
    mocks.detectClient.mockReset();
    mocks.detectClient.mockResolvedValue({ found: true });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  });

  it('passes refresh: true to the admin only for a literal true', async () => {
    const handler = registerAndGetDetectHandler();
    await handler({}, { refresh: true });
    expect(mocks.detectClient).toHaveBeenCalledWith({ refresh: true });
  });

  it('treats no options and an empty options object as no refresh', async () => {
    const handler = registerAndGetDetectHandler();
    await handler({});
    await handler({}, {});
    expect(mocks.detectClient).toHaveBeenNthCalledWith(1, { refresh: false });
    expect(mocks.detectClient).toHaveBeenNthCalledWith(2, { refresh: false });
  });

  it('never lets a non-boolean value force a refresh', async () => {
    const handler = registerAndGetDetectHandler();
    for (const refresh of ['yes', 1, 'true', {}, null]) {
      await handler({}, { refresh });
    }
    for (const call of mocks.detectClient.mock.calls) {
      expect(call[0]).toEqual({ refresh: false });
    }
    expect(mocks.detectClient).toHaveBeenCalledTimes(5);
  });

  it('returns the admin\'s answer', async () => {
    mocks.detectClient.mockResolvedValue({ found: false });
    const handler = registerAndGetDetectHandler();
    await expect(handler({}, { refresh: true })).resolves.toEqual({ found: false });
  });
});

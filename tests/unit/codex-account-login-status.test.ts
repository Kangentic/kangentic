/**
 * Codex `identify` with no `auth.json` asks `codex login status` (exit 0 = signed in), under the
 * account's CODEX_HOME and CODEX_SQLITE_HOME.
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface FakeChild extends EventEmitter {
  stdout: { resume: ReturnType<typeof vi.fn> };
  stderr: { resume: ReturnType<typeof vi.fn> };
}

const spawnCli = vi.fn();
const stopCli = vi.fn();
vi.mock('../../src/main/agent/shared/cli-print', () => ({ spawnCli, stopCli }));

const { CODEX_ACCOUNT_SUPPORT } = await import('../../src/main/agent/adapters/codex/accounts');

let home: string;
let child: FakeChild;

async function identifyThen(settle: () => void) {
  const pending = CODEX_ACCOUNT_SUPPORT.identify('codex', home);
  await vi.waitFor(() => expect(spawnCli).toHaveBeenCalledTimes(1));
  settle();
  return pending;
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-codex-account-'));
  child = Object.assign(new EventEmitter(), { stdout: { resume: vi.fn() }, stderr: { resume: vi.fn() } }) as FakeChild;
  spawnCli.mockReset();
  stopCli.mockReset();
  spawnCli.mockReturnValue(child);
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe('Codex identify without auth.json', () => {
  it('reads exit 0 as signed in, and runs login status under both home variables', async () => {
    const identity = await identifyThen(() => child.emit('exit', 0));
    expect(identity.signedIn).toBe(true);
    const [, args, , env] = spawnCli.mock.calls[0];
    expect(args).toEqual(['login', 'status']);
    expect(env).toEqual({ CODEX_HOME: home, CODEX_SQLITE_HOME: home });
  });

  it('reads a non-zero exit as signed out', async () => {
    const identity = await identifyThen(() => child.emit('exit', 1));
    expect(identity.signedIn).toBe(false);
  });

  it('reads a spawn error as signed out', async () => {
    const identity = await identifyThen(() => child.emit('error', new Error('spawn ENOENT')));
    expect(identity.signedIn).toBe(false);
  });
});

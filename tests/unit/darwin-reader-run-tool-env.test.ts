/**
 * The environment the macOS reader's `runTool` gives the tool it starts
 * (`lsappinfo`, once per scan). The tool is a child of main, so it is built with
 * `childProcessEnv({ LC_ALL: 'C' })`: main's environment without Chromium's
 * Crashpad pipe name (src/main/shared/child-env.ts), with the locale pinned so
 * the listing parses the same everywhere. A spawn with no `env` key, or one that
 * spreads `process.env`, would hand the pipe name to whatever the tool starts.
 *
 * `task-process-readers.test.ts` runs `runTool` against real tools, which cannot
 * see the environment they were given. This file replaces `spawn` with a fake
 * child and reads the options it received. `runTool` is not platform-gated, so
 * it runs on every OS.
 *
 * The env is a copy of `process.env`, so every assertion reads one key: a
 * failure never prints a variable on the machine (tokens included).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  kill: () => boolean;
}

interface SpawnOptionsSeen {
  env?: Record<string, string>;
}

const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));

// The rest of node:child_process stays real, so the reader's other imports
// still resolve what they load.
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  spawn: spawnMock,
}));

import { runTool } from '../../src/main/pty/process-tag/darwin-reader';

const PIPE_KEY = 'CHROME_CRASHPAD_PIPE_NAME';
const PROBE_KEY = 'KANGENTIC_DARWIN_RUN_TOOL_ENV_PROBE';
const LOCALE_KEY = 'LC_ALL';

describe('runTool environment', () => {
  const savedValues = new Map<string, string | undefined>();
  let child: FakeChild;

  beforeEach(() => {
    for (const key of [PIPE_KEY, PROBE_KEY, LOCALE_KEY]) savedValues.set(key, process.env[key]);
    process.env[PIPE_KEY] = '\\\\.\\pipe\\crashpad_1234_ABCDEFGHIJKLMNOP';
    process.env[PROBE_KEY] = 'present';
    // Main's own locale, so a spawn that lets it win over the pinned one is caught.
    process.env[LOCALE_KEY] = 'en_US.UTF-8';
    child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), kill: () => true });
    spawnMock.mockReset();
    spawnMock.mockReturnValue(child);
  });

  afterEach(() => {
    for (const [key, savedValue] of savedValues) {
      if (savedValue === undefined) delete process.env[key];
      else process.env[key] = savedValue;
    }
    savedValues.clear();
  });

  it('starts the tool without the pipe name, with the locale pinned, and with the rest of main\'s environment', async () => {
    const pending = runTool('/usr/bin/lsappinfo', ['list'], 5_000);
    child.stdout.emit('data', Buffer.from('listing'));
    child.emit('close', 0, null);

    // Positive control: the call ran to its answer on the fake, so the options
    // read below are the ones this run's spawn received.
    await expect(pending).resolves.toBe('listing');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const spawnCall = spawnMock.mock.calls[0] as unknown as [string, string[], SpawnOptionsSeen];
    expect(spawnCall[0]).toBe('/usr/bin/lsappinfo');
    expect(spawnCall[1]).toEqual(['list']);

    const { env } = spawnCall[2];
    expect(env).toBeDefined();
    expect(env![PROBE_KEY]).toBe('present');
    expect(env![LOCALE_KEY]).toBe('C');
    expect(PIPE_KEY in env!).toBe(false);
  });
});

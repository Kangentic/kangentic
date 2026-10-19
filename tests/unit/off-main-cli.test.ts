/**
 * `spawnOffMainCli` (src/main/utility-process/off-main-cli.ts) hands an agent
 * CLI's headless run to the pty host through the registered spawner. The run is
 * an agent CLI or git, and either can start anything, so the env it ships never
 * carries Chromium's Crashpad pipe name (src/main/shared/child-env.ts), whatever
 * the caller built. `spawnCli` builds its env with `childProcessEnv` and
 * `spawn-with-abort.ts` strips a git run's with `withoutCrashpadPipeName`, so
 * their own tests stay green with the strip gone from the drop-in; these call
 * it directly with an env that carries the name.
 *
 * Every env here is a small synthetic object, never `process.env`, and every
 * assertion reads one key, so a failure prints no variable of the machine.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  setOffMainCliSpawner,
  spawnOffMainCli,
  type CliChildProcess,
  type OffMainCliOptions,
} from '../../src/main/utility-process/off-main-cli';

const PIPE_KEY = 'CHROME_CRASHPAD_PIPE_NAME';
const PIPE_VALUE = '\\\\.\\pipe\\crashpad_1234_ABCDEFGHIJKLMNOP';

afterEach(() => {
  setOffMainCliSpawner(null);
});

/** A run the spawner hands back; the tests only compare it by identity. */
function fakeRemoteChild(): CliChildProcess {
  return Object.assign(new EventEmitter(), {
    pid: undefined,
    exitCode: null,
    signalCode: null,
    stdout: Object.assign(new EventEmitter(), { resume: () => undefined }),
    stderr: Object.assign(new EventEmitter(), { resume: () => undefined }),
    stdin: Object.assign(new EventEmitter(), { write: () => true, end: () => undefined }),
    kill: () => true,
  });
}

function callerOptions(): OffMainCliOptions {
  return {
    cwd: '/mock/repo',
    shell: false,
    detached: true,
    env: {
      [PIPE_KEY]: PIPE_VALUE,
      // Windows environment names are case-insensitive, so a differently cased
      // spelling is the same variable.
      chrome_crashpad_pipe_name: PIPE_VALUE,
      KANGENTIC_RUN: 'yes',
    },
  };
}

/** Registers a spawner that records what it received and answers with `remote`. */
function recordingSpawner(remote: CliChildProcess): Array<{ command: string; args: string[]; options: OffMainCliOptions }> {
  const received: Array<{ command: string; args: string[]; options: OffMainCliOptions }> = [];
  setOffMainCliSpawner((command, args, options) => {
    received.push({ command, args, options });
    return remote;
  });
  return received;
}

describe('spawnOffMainCli', () => {
  it('hands the spawner the caller\'s other variables and never the pipe name, in any spelling', () => {
    const received = recordingSpawner(fakeRemoteChild());

    spawnOffMainCli('/usr/local/bin/agent', ['-p'], callerOptions());

    expect(received).toHaveLength(1);
    const { env } = received[0].options;
    // Positive control: an env arrived and it is the caller's, so the missing
    // pipe name is the strip's doing and not an empty env.
    expect(env.KANGENTIC_RUN).toBe('yes');
    expect(PIPE_KEY in env).toBe(false);
    expect(Object.keys(env).filter((name) => name.toUpperCase() === PIPE_KEY)).toEqual([]);
  });

  it('passes the command, args and the other options through, and returns the spawner\'s run', () => {
    const remote = fakeRemoteChild();
    const received = recordingSpawner(remote);

    const child = spawnOffMainCli('/usr/local/bin/agent', ['-p', '--json'], callerOptions());

    expect(child).toBe(remote);
    expect(received).toHaveLength(1);
    expect(received[0].command).toBe('/usr/local/bin/agent');
    expect(received[0].args).toEqual(['-p', '--json']);
    expect(received[0].options.cwd).toBe('/mock/repo');
    expect(received[0].options.shell).toBe(false);
    expect(received[0].options.detached).toBe(true);
  });

  it('leaves the caller\'s options and env as they were', () => {
    const received = recordingSpawner(fakeRemoteChild());
    const options = callerOptions();
    const callerEnv = options.env;

    spawnOffMainCli('/usr/local/bin/agent', ['-p'], options);

    expect(received).toHaveLength(1);
    // The spawner got a copy of each, so stripping touched neither.
    expect(received[0].options).not.toBe(options);
    expect(received[0].options.env).not.toBe(callerEnv);
    expect(options.env).toBe(callerEnv);
    expect(callerEnv[PIPE_KEY]).toBe(PIPE_VALUE);
    expect(callerEnv.chrome_crashpad_pipe_name).toBe(PIPE_VALUE);
    expect(callerEnv.KANGENTIC_RUN).toBe('yes');
  });

  it('returns null with no spawner registered, so the caller spawns locally', () => {
    expect(spawnOffMainCli('/usr/local/bin/agent', ['-p'], callerOptions())).toBeNull();
  });
});

/**
 * The session an OpenCode answer leaves behind is deleted after the answer
 * (`OpenCodeAdapter.answerFromContext`): the answer home is not a git repository,
 * so its sessions would otherwise pile up in the user's global session list.
 *
 * Driven through the real adapter, `runCliForChat` and `spawnCli`. The one seam
 * is the off-main CLI spawner (`setOffMainCliSpawner`), the route every headless
 * run takes when the pty host is registered, so each run is a fake child this
 * test controls and no process starts. A fake child has a `stopTree`, so a stop
 * only counts, and never signals a pid.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { OpenCodeAdapter } from '../../src/main/agent/adapters/opencode';
import { runCliForChat, stopAllCliRuns, stopCliRunsForChat } from '../../src/main/agent/shared/cli-print';
import { setOffMainCliSpawner, type CliChildProcess, type OffMainCliOptions } from '../../src/main/utility-process/off-main-cli';

const CLI_PATH = '/usr/local/bin/opencode';
const WORKING_DIRECTORY = '/work/answers';
const SESSION_ID = 'ses_f19901e1fffekSE4Do8fuQuTEb';

interface FakeRun extends CliChildProcess {
  /** How many times the run was stopped (`stopTree`). */
  stops: number;
  /** The stdin `error` listeners present when `end` was called, null before then. */
  stdinErrorListenersAtEnd: number | null;
  stdoutResume: ReturnType<typeof vi.fn>;
  stderrResume: ReturnType<typeof vi.fn>;
}

interface SpawnedRun {
  command: string;
  args: string[];
  options: OffMainCliOptions;
  run: FakeRun;
}

function fakeRun(): FakeRun {
  const stdout = Object.assign(new EventEmitter(), { resume: vi.fn() });
  const stderr = Object.assign(new EventEmitter(), { resume: vi.fn() });
  // A real emitter, as a child's stdin is: an `error` nobody listens for throws.
  const stdin = Object.assign(new EventEmitter(), {
    write: () => true,
    end: () => { run.stdinErrorListenersAtEnd = stdin.listenerCount('error'); },
  });
  const run: FakeRun = Object.assign(new EventEmitter(), {
    pid: undefined,
    exitCode: null,
    signalCode: null,
    stdout,
    stderr,
    stdin,
    kill: () => true,
    stops: 0,
    stopTree: () => { run.stops += 1; },
    stdinErrorListenersAtEnd: null as number | null,
    stdoutResume: stdout.resume,
    stderrResume: stderr.resume,
  });
  return run;
}

/** The `--format json` events of one answer, every one carrying the session id. */
function answerOutput(sessionId: string | null): string {
  const sessionField = sessionId === null ? {} : { sessionID: sessionId };
  return [
    { type: 'step_start', ...sessionField, part: { type: 'step-start' } },
    { type: 'text', ...sessionField, part: { type: 'text', text: 'The search found 12 conversation hits.' } },
    { type: 'step_finish', ...sessionField, part: { type: 'step-finish', reason: 'stop' } },
  ].map((event) => `${JSON.stringify(event)}\n`).join('');
}

let spawned: SpawnedRun[];
let adapter: OpenCodeAdapter;

beforeEach(() => {
  spawned = [];
  adapter = new OpenCodeAdapter();
  setOffMainCliSpawner((command, args, options) => {
    const run = fakeRun();
    spawned.push({ command, args, options, run });
    return run;
  });
});

afterEach(() => {
  stopAllCliRuns();
  setOffMainCliSpawner(null);
});

/**
 * Ask inside `chatId`'s runs, as the answer handler does, let the CLI answer
 * with `output`, and settle once the adapter has finished, its delete included.
 */
async function answerInChat(output: string, chatId = 'chat-1'): Promise<string> {
  const answer = runCliForChat(chatId, () => adapter.answerFromContext('Which row?', CLI_PATH, WORKING_DIRECTORY, null));
  // The run is spawned in the same tick, ahead of the first await.
  expect(spawned).toHaveLength(1);
  const answerRun = spawned[0].run;
  answerRun.stdout.emit('data', Buffer.from(output));
  answerRun.emit('exit', 0, null);
  answerRun.emit('close', 0, null);
  return answer;
}

describe('OpenCode answer: deleting the session it leaves behind', () => {
  it('deletes the session the answer used, with the CLI the answer used, in the answer\'s directory', async () => {
    const answer = await answerInChat(answerOutput(SESSION_ID));

    expect(answer).toBe('The search found 12 conversation hits.');
    expect(spawned).toHaveLength(2);
    expect(spawned[1].command).toBe(CLI_PATH);
    expect(spawned[1].args).toEqual(['session', 'delete', SESSION_ID]);
    expect(spawned[1].options.cwd).toBe(WORKING_DIRECTORY);
  });

  // The chat ending right after the answer must not stop the delete: it is its
  // own process, not the chat's run. Spawned inside `runCliForChat`, it is
  // recorded as the chat's unless it goes through `outsideChatRuns`. The quit
  // path still stops it, since it is tracked under no chat.
  //
  // Red-green: spawn the delete with a bare `spawnCli(...)` (drop `outsideChatRuns`)
  // in opencode-adapter.ts. The delete is then recorded as `chat-1`'s, so
  // `stopCliRunsForChat` stops it and its stop count is 1 where 0 is expected.
  it('starts the delete outside the chat\'s runs: ending the chat leaves it, quitting stops it', async () => {
    await answerInChat(answerOutput(SESSION_ID), 'chat-1');
    const deletion = spawned[1].run;
    expect(deletion.stops).toBe(0);

    stopCliRunsForChat('chat-1');

    expect(deletion.stops).toBe(0);

    stopAllCliRuns();

    expect(deletion.stops).toBe(1);
  });

  it('stops the chat\'s own answer run when the chat ends, which is what the delete must not share', async () => {
    // The control for the test above: a run recorded as the chat's IS stopped.
    // The answer is left running here, so it is still tracked under `chat-1`.
    const answer = runCliForChat('chat-1', () => adapter.answerFromContext('Which row?', CLI_PATH, WORKING_DIRECTORY, null));
    const answerRun = spawned[0].run;

    stopCliRunsForChat('chat-1');

    expect(answerRun.stops).toBe(1);
    // Let the answer settle without a delete, so nothing is left pending.
    answerRun.emit('exit', null, 'SIGTERM');
    answerRun.emit('close', null, 'SIGTERM');
    await answer.catch(() => undefined);
  });

  // The id is read from the CLI's output and goes on a command line, so only the
  // shape an id has is passed on: word characters and hyphens.
  //
  // Red-green: drop the `/^[\w-]+$/` test (or loosen it to any non-empty string)
  // in opencode-adapter.ts and every id below spawns a `session delete`.
  it.each([
    ['whitespace', 'ses_abc def'],
    ['a shell separator', 'ses_abc;calc'],
    ['a path', '../ses_abc'],
    ['an option with a value', '--x=ses_abc'],
    ['a quote', 'ses_"abc"'],
  ])('spawns no delete for an id with %s', async (_label, sessionId) => {
    const answer = await answerInChat(answerOutput(sessionId));

    expect(answer).toBe('The search found 12 conversation hits.');
    expect(spawned).toHaveLength(1);
    expect(spawned[0].args[0]).toBe('run');
  });

  it('spawns no delete when the output carries no session id', async () => {
    const answer = await answerInChat(answerOutput(null));

    expect(answer).toBe('The search found 12 conversation hits.');
    expect(spawned).toHaveLength(1);
  });

  // A delete that exits at once (the session already gone) closes the pipe under
  // `stdin.end()`, and an `error` on a stream nobody listens to is an uncaught
  // exception in main. The listener has to be there BEFORE `end()` is called.
  //
  // Red-green: drop `deletion.stdin.on('error', ...)` in opencode-adapter.ts. No
  // listener is present when `end` runs, and emitting an error on the stream throws.
  it('guards the delete\'s stdin against a closed pipe before it ends it', async () => {
    await answerInChat(answerOutput(SESSION_ID));
    const deletion = spawned[1].run;

    expect(deletion.stdinErrorListenersAtEnd).toBeGreaterThanOrEqual(1);
    expect(() => deletion.stdin.emit('error', Object.assign(new Error('write EPIPE'), { code: 'EPIPE' }))).not.toThrow();
    // Its own `error` (a CLI that never started) is handled too.
    expect(() => deletion.emit('error', new Error('spawn ENOENT'))).not.toThrow();
  });

  it('drains the delete\'s output so a full pipe cannot stall it', async () => {
    await answerInChat(answerOutput(SESSION_ID));
    const deletion = spawned[1].run;

    expect(deletion.stdoutResume).toHaveBeenCalledTimes(1);
    expect(deletion.stderrResume).toHaveBeenCalledTimes(1);
  });
});

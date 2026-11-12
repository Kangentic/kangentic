/**
 * The Aider, Goose and Ollama mock CLIs (tests/fixtures/mock-aider.js, mock-goose.js,
 * mock-ollama.js), run as real node processes and held to what their adapters key on: the prompt each
 * adapter's idle detector matches, the exit sequence each adapter types, and (Goose) the OSC 7501 wait
 * its parser reads.
 *
 * What a user loses if it breaks: a PTY test that passes against a mock whose prompt or exit no longer
 * matches the real CLI's, so a broken idle detector or a stuck exit goes unnoticed until a real agent
 * runs.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { AiderAdapter } from '../../src/main/agent/adapters/aider';
import { GooseAdapter } from '../../src/main/agent/adapters/goose';
import { OllamaAdapter } from '../../src/main/agent/adapters/ollama';
import { parseGooseVersion } from '../../src/main/agent/adapters/goose/detector';
import { GooseProgramStatusParser } from '../../src/main/agent/adapters/goose/program-status-parser';
import { parseOllamaModelList } from '../../src/main/agent/adapters/ollama/capability-discovery';
import { EventType, IdleReason, PromptReason, type AdapterRuntimeStrategy } from '../../src/shared/types';

interface RunningMock {
  child: ChildProcessWithoutNullStreams;
  output(): string;
  waitForOutput(predicate: (output: string) => boolean): Promise<void>;
  exited: Promise<number | null>;
}

const running: ChildProcessWithoutNullStreams[] = [];

afterEach(() => {
  for (const child of running.splice(0)) child.kill();
});

function startMock(fixture: string, args: string[], env: Record<string, string> = {}): RunningMock {
  const script = fileURLToPath(new URL(`../fixtures/${fixture}`, import.meta.url));
  const child = spawn(process.execPath, [script, ...args], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  running.push(child);
  let collected = '';
  const listeners = new Set<() => void>();
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    collected += chunk;
    for (const listener of [...listeners]) listener();
  });
  const exited = new Promise<number | null>((resolve) => child.on('close', (code) => resolve(code)));
  return {
    child,
    output: () => collected,
    waitForOutput: (predicate) => new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        listeners.delete(check);
        reject(new Error(`timed out waiting for output; got: ${JSON.stringify(collected)}`));
      }, 8000);
      const check = (): void => {
        if (!predicate(collected)) return;
        clearTimeout(timer);
        listeners.delete(check);
        resolve();
      };
      listeners.add(check);
      check();
    }),
    exited,
  };
}

function runToEnd(fixture: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number | null; output: string }> {
  const mock = startMock(fixture, args, env);
  return mock.exited.then((code) => ({ code, output: mock.output() }));
}

function idleDetector(runtime: AdapterRuntimeStrategy): (data: string) => boolean {
  const activity = runtime.activity;
  if (activity.kind === 'hooks' || !activity.detectIdle) throw new Error('the adapter declares no prompt detector');
  return activity.detectIdle.bind(activity);
}

/** Write the adapter's exit sequence key by key, as the session layer does, and wait for the process to end. */
async function typeExitSequence(mock: RunningMock, sequence: string[]): Promise<number | null> {
  for (const keys of sequence) mock.child.stdin.write(keys);
  return mock.exited;
}

describe('mock-aider', () => {
  const adapter = new AiderAdapter();

  it('shows the bare prompt Aider\'s idle detector matches, and exits on the adapter\'s exit sequence', async () => {
    const mock = startMock('mock-aider.js', ['--message', 'hello', '--yes']);
    await mock.waitForOutput((output) => idleDetector(adapter.runtime)(output));

    expect(mock.output()).toContain('MOCK_AIDER_PROMPT:hello');
    expect(mock.output()).toMatch(/\n> $/);
    expect(await typeExitSequence(mock, adapter.getExitSequence())).toBe(0);
  });

  it('prefixes the prompt with the chat mode, and the detector still matches it', async () => {
    const asking = startMock('mock-aider.js', ['--chat-mode', 'ask']);
    await asking.waitForOutput((output) => idleDetector(adapter.runtime)(output));
    expect(asking.output()).toContain('MOCK_AIDER_MODE:ask');
    expect(asking.output()).toMatch(/\nask> $/);

    const architect = startMock('mock-aider.js', ['--architect']);
    await architect.waitForOutput((output) => idleDetector(adapter.runtime)(output));
    expect(architect.output()).toMatch(/\narchitect> $/);
  });

  it('is not idle while it is still answering', async () => {
    const mock = startMock('mock-aider.js', []);
    await mock.waitForOutput((output) => idleDetector(adapter.runtime)(output));
    mock.child.stdin.write('do the thing\r');
    await mock.waitForOutput((output) => output.includes('MOCK_AIDER_REPLY:do the thing'));
    const beforePrompt = mock.output().split('MOCK_AIDER_REPLY:do the thing')[0];
    expect(idleDetector(adapter.runtime)(beforePrompt + 'MOCK_AIDER_REPLY:do the thing\n')).toBe(false);
  });

  it('echoes the resume flag and the notification command it was given, and exits after a message when asked', async () => {
    const { output } = await runToEnd('mock-aider.js', ['--restore-chat-history', '--notifications', '--notifications-command', 'echo idle', '--message', 'x'], { MOCK_AIDER_EXIT_AFTER_MESSAGE: '1' });
    expect(output).toContain('MOCK_AIDER_RESTORED');
    expect(output).toContain('MOCK_AIDER_NOTIFY:echo idle');
  });
});

describe('mock-goose', () => {
  const adapter = new GooseAdapter();

  it('prints a version banner the detector accepts', async () => {
    const { code, output } = await runToEnd('mock-goose.js', ['--version']);
    expect(code).toBe(0);
    expect(parseGooseVersion(output)).toBe('1.56.0-mock');
  });

  it('opens an interactive session with the permission mode from the environment, and exits on the adapter\'s exit sequence', async () => {
    const mock = startMock('mock-goose.js', ['session', '-n', 'task-session'], { GOOSE_MODE: 'smart_approve' });
    await mock.waitForOutput((output) => output.endsWith('( O)> '));

    expect(mock.output()).toContain('MOCK_GOOSE_COMMAND:session');
    expect(mock.output()).toContain('MOCK_GOOSE_NAME:task-session');
    expect(mock.output()).toContain('MOCK_GOOSE_MODE:smart_approve');
    expect(await typeExitSequence(mock, adapter.getExitSequence())).toBe(0);
  });

  it('answers a headless run and exits, but stays at its prompt with -s', async () => {
    const headless = await runToEnd('mock-goose.js', ['run', '-t', 'do it']);
    expect(headless.code).toBe(0);
    expect(headless.output).toContain('MOCK_GOOSE_PROMPT:do it');

    const interactive = startMock('mock-goose.js', ['run', '-r', '-n', 'task-session', '-t', 'again', '-s']);
    await interactive.waitForOutput((output) => output.endsWith('( O)> '));
    expect(interactive.output()).toContain('MOCK_GOOSE_RESUMED:task-session');
  });

  it('reports a wait on the user as an OSC 7501 status the adapter\'s parser turns into a wait, then clears it', async () => {
    const mock = startMock('mock-goose.js', ['run', '-t', 'edit a file', '-s'], { MOCK_GOOSE_BLOCK: 'permission' });
    await mock.waitForOutput((output) => output.includes('MOCK_GOOSE_WAITING:permission'));

    const parser = new GooseProgramStatusParser();
    const waiting = parser.parseTelemetry(mock.output());
    expect(waiting?.events).toEqual([expect.objectContaining({ type: EventType.Idle, detail: IdleReason.Permission, waitKind: 'approval' })]);

    mock.child.stdin.write('y\r');
    await mock.waitForOutput((output) => output.includes('MOCK_GOOSE_ANSWERED:y'));
    const cleared = parser.parseTelemetry(mock.output().split('MOCK_GOOSE_WAITING:permission')[1] ?? '');
    expect(cleared?.events).toEqual([expect.objectContaining({ type: EventType.Prompt, detail: PromptReason.PtyActivity })]);
  });
});

describe('mock-ollama', () => {
  const adapter = new OllamaAdapter();

  it('prints the table `ollama list` prints, which the capability parser reads', async () => {
    const { code, output } = await runToEnd('mock-ollama.js', ['list'], { MOCK_OLLAMA_MODELS: 'qwen2.5-coder:7b,llama3.2:latest' });
    expect(code).toBe(0);
    expect(parseOllamaModelList(output)).toEqual(['llama3.2:latest', 'qwen2.5-coder:7b']);
  });

  it('shows the >>> prompt the idle detector matches, and exits on the adapter\'s exit sequence', async () => {
    const mock = startMock('mock-ollama.js', ['run', 'llama3.2']);
    await mock.waitForOutput((output) => idleDetector(adapter.runtime)(output));

    expect(mock.output()).toContain('MOCK_OLLAMA_MODEL:llama3.2');
    expect(mock.output()).toMatch(/\n>>> $/);
    expect(await typeExitSequence(mock, adapter.getExitSequence())).toBe(0);
  });

  it('answers a one-shot prompt that starts with a dash after the -- marker, then exits', async () => {
    const { code, output } = await runToEnd('mock-ollama.js', ['run', 'llama3.2', '--', '- first item']);
    expect(code).toBe(0);
    expect(output).toContain('MOCK_OLLAMA_PROMPT:- first item');
  });
});

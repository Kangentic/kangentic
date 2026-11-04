/**
 * The Antigravity adapter's warm answer session (`openAnswerSession`), built
 * from the headless doc (https://antigravity.google/docs/cli/headless): one
 * `--input-format stream-json` process runs a full turn per stdin message,
 * ends each turn with a `result` event, and keeps one `conversation_id`.
 *
 * What a user loses if these go: a session whose flags drift from the
 * one-shot run's loses the read-only plan mode; a turn that never ends hangs
 * the Knowledge Graph chat; and a conversation not removed leaves every chat's
 * whole prompt in agy's brain folder.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { StdinJsonSessionOptions } from '../../src/main/agent/shared/answer-session/stdin-json-session';

const { sessionSpy, removeSpy } = vi.hoisted(() => ({
  sessionSpy: vi.fn(),
  removeSpy: vi.fn(async (..._removeArguments: unknown[]): Promise<void> => undefined),
}));
vi.mock('../../src/main/agent/shared/answer-session/stdin-json-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/shared/answer-session/stdin-json-session')>();
  return { ...actual, openStdinJsonSession: sessionSpy };
});
vi.mock('../../src/main/agent/adapters/antigravity/answer-stream', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/adapters/antigravity/answer-stream')>();
  return { ...actual, removeAntigravityConversation: (...removeArguments: unknown[]) => removeSpy(...removeArguments) };
});
// A distro whose facts detection has not read: the session is opened
// synchronously, so it cannot read them itself.
vi.mock('../../src/main/agent/shared/wsl-distro', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/shared/wsl-distro')>();
  return { ...actual, peekWslDistroFacts: () => null };
});

import { AntigravityAdapter, antigravityAnswerArgs } from '../../src/main/agent/adapters/antigravity/antigravity-adapter';

const CONVERSATION_ID = 'edb1c8c1-50ba-4f3f-87eb-412d0e9d47c3';

function openSession(exited: Promise<void>): StdinJsonSessionOptions {
  sessionSpy.mockReturnValue({ exited });
  new AntigravityAdapter().openAnswerSession({
    cliPath: '/usr/local/bin/agy',
    cwd: '/answer-home',
    runDirectory: '/answer-home/run-1',
    model: 'gemini-3.1-pro-high',
    effort: 'low',
  });
  return sessionSpy.mock.calls[sessionSpy.mock.calls.length - 1][0] as StdinJsonSessionOptions;
}

describe('AntigravityAdapter.openAnswerSession', () => {
  beforeEach(() => {
    sessionSpy.mockReset();
    removeSpy.mockClear();
  });

  it('runs with the one-shot answer run\'s read-only flags from the shared answer home', () => {
    const options = openSession(new Promise(() => undefined));
    expect(options.args).toEqual(antigravityAnswerArgs('gemini-3.1-pro-high', 'low'));
    expect(options.args.slice(0, 2)).toEqual(['--mode', 'plan']);
    expect(options.args[options.args.indexOf('--input-format') + 1]).toBe('stream-json');
    expect(options.args[options.args.indexOf('--output-format') + 1]).toBe('stream-json');
    expect(options.args[options.args.length - 1]).toBe('--print=');
    expect(options.cwd).toBe('/answer-home');
  });

  it('omits the model and effort flags when none is chosen', () => {
    expect(antigravityAnswerArgs(null, null)).toEqual([
      '--mode', 'plan', '--input-format', 'stream-json', '--output-format', 'stream-json', '--print=',
    ]);
  });

  it('sends a multi-line prompt as one user message line, which the transport ends itself', () => {
    const options = openSession(new Promise(() => undefined));
    const turn = options.formatTurn('first line\nsecond line');
    expect(turn).not.toContain('\n');
    expect(JSON.parse(turn)).toEqual({
      event: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'first line\nsecond line' }] },
    });
  });

  it('ends a turn on its result event and nothing else', () => {
    const options = openSession(new Promise(() => undefined));
    expect(options.isTurnEnd(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok' } }))).toBe(true);
    expect(options.isTurnEnd(JSON.stringify({
      event: 'step_update',
      step_update: { step_type: 'agent_response', state: 'ACTIVE', text_delta: 'the result is' },
    }))).toBe(false);
  });

  it('streams text and reads the answer from the result', () => {
    const options = openSession(new Promise(() => undefined));
    const reduce = options.createReducer();
    expect(reduce(JSON.stringify({
      event: 'step_update',
      step_update: { conversation_id: CONVERSATION_ID, step_type: 'agent_response', state: 'ACTIVE', text_delta: 'Hello' },
    }))).toEqual([{ kind: 'text', text: 'Hello' }]);
    expect(options.extractAnswer(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'Hello there' } })))
      .toBe('Hello there');
  });

  it('removes the conversation its start-up init line names, though no turn ever ran, once the process is gone', async () => {
    let finish: () => void = () => undefined;
    const options = openSession(new Promise<void>((resolve) => { finish = resolve; }));
    // The init event arrives before any turn, where only `onLine` sees it.
    options.onLine?.(JSON.stringify({ event: 'init', conversation_id: CONVERSATION_ID, init: { cwd: '/answer-home', tools: [] } }));
    await Promise.resolve();
    expect(removeSpy).not.toHaveBeenCalled();

    finish();
    await vi.waitFor(() => expect(removeSpy).toHaveBeenCalledTimes(1));
    expect(removeSpy.mock.calls[0][0]).toBe(CONVERSATION_ID);
  });

  it('reads the conversation off a turn\'s own line too', async () => {
    let finish: () => void = () => undefined;
    const options = openSession(new Promise<void>((resolve) => { finish = resolve; }));
    options.onLine?.(JSON.stringify({
      event: 'step_update',
      step_update: { conversation_id: CONVERSATION_ID, step_index: 4, state: 'DONE', step_type: 'tool', tool_name: 'run_command' },
    }));
    finish();
    await vi.waitFor(() => expect(removeSpy).toHaveBeenCalledTimes(1));
    expect(removeSpy.mock.calls[0][0]).toBe(CONVERSATION_ID);
  });

  it('removes nothing when no line ever named a conversation', async () => {
    openSession(Promise.resolve());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(removeSpy).not.toHaveBeenCalled();
  });

  it('refuses a distro CLI path whose distro facts are not read yet, so the answer takes a fresh run', () => {
    const realPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      expect(() => new AntigravityAdapter().openAnswerSession({
        cliPath: '\\\\wsl.localhost\\Gone\\home\\dev\\.local\\bin\\agy',
        cwd: 'C:\\Users\\dev\\answers',
        runDirectory: 'C:\\Users\\dev\\answers\\run-1',
        model: null,
        effort: null,
      })).toThrow('not read yet');
      expect(sessionSpy).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true });
    }
  });
});

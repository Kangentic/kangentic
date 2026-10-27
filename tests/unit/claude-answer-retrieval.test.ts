/**
 * The two pieces the Claude adapter adds around an answer call: the scoped MCP
 * config that hands the agent ONE tool, and the forwarder that turns stdout
 * chunks into answer events.
 *
 * The config carries a live token and, under `--strict-mcp-config`, IS the
 * whole server list, so what it contains is a security property: exactly one
 * server, ours, and nothing the user configured. The forwarder's property is
 * that chunk boundaries are invisible - stdout arrives split anywhere, including
 * mid-line, and a parser fed half a JSON line yields nothing.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StdinJsonSessionOptions } from '../../src/main/agent/shared/answer-session/stdin-json-session';

const { sessionSpy, relaySpy } = vi.hoisted(() => ({
  sessionSpy: vi.fn(),
  // The run's MCP relay: a stop function, as `startRunMcpRelay` returns.
  relaySpy: vi.fn((..._relayArguments: unknown[]): (() => void) => () => undefined),
}));
vi.mock('../../src/main/agent/shared/answer-session/stdin-json-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/shared/answer-session/stdin-json-session')>();
  return { ...actual, openStdinJsonSession: sessionSpy };
});
// Only the relay is replaced; `kangenticMcpServer` stays real, since the
// scoped-config cases below depend on it.
vi.mock('../../src/main/agent/shared/kangentic-mcp-server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/shared/kangentic-mcp-server')>();
  return { ...actual, startRunMcpRelay: (...relayArguments: unknown[]) => relaySpy(...relayArguments) };
});

import { ClaudeAdapter, writeScopedMcpConfig, makeStreamForwarder } from '../../src/main/agent/adapters/claude/claude-adapter';

const written: string[] = [];
afterEach(() => {
  for (const file of written.splice(0)) {
    fs.rmSync(path.dirname(file), { recursive: true, force: true });
  }
});

describe('writeScopedMcpConfig', () => {
  it('names exactly one server, ours, with the token in its header', () => {
    const file = writeScopedMcpConfig({ url: 'http://127.0.0.1:4321/mcp/project-1', token: 'secret' });
    written.push(file);
    const config = JSON.parse(fs.readFileSync(file, 'utf-8'));
    expect(Object.keys(config)).toEqual(['mcpServers']);
    expect(Object.keys(config.mcpServers)).toEqual(['kangentic']);
    expect(config.mcpServers.kangentic).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:4321/mcp/project-1',
      headers: { 'X-Kangentic-Token': 'secret' },
    });
  });

  it('gives a Claude in a WSL distro on NAT networking the stdio bridge, with the token in its env', () => {
    // The distro's 127.0.0.1 is its own, so the URL would leave the answer
    // without its search tool. The run starts the relay the bridge publishes to.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-answer-'));
    const file = writeScopedMcpConfig({ url: 'http://127.0.0.1:4321/mcp/project-1', token: 'secret' }, directory, {
      kind: 'wsl',
      distro: 'Ubuntu',
      facts: { distro: 'Ubuntu', homeLinux: '/home/dev', homeUnc: '\\\\wsl.localhost\\Ubuntu\\home\\dev', uncRoot: '\\\\wsl.localhost\\Ubuntu', interactivePath: '/usr/bin', env: {}, networkingMode: 'nat' },
    });
    written.push(file);
    const server = JSON.parse(fs.readFileSync(file, 'utf-8')).mcpServers.kangentic;
    expect(server).toMatchObject({ type: 'stdio', command: 'sh', env: { KANGENTIC_MCP_TOKEN: 'secret' } });
    expect(server.args.slice(1)).toEqual(['mcp', 'http://127.0.0.1:4321/mcp/project-1']);
    expect(server.args.join(' ')).not.toContain('secret');
  });

  it('lives under the OS temp dir, in a directory of its own per call', () => {
    // Two answers in flight must not share a file: each carries its own token,
    // and the caller deletes its own file when its call ends.
    const first = writeScopedMcpConfig({ url: 'http://x', token: 'a' });
    const second = writeScopedMcpConfig({ url: 'http://x', token: 'b' });
    written.push(first, second);
    expect(path.dirname(first)).not.toBe(path.dirname(second));
    expect(path.basename(path.dirname(first))).toMatch(/^kangentic-answer-/);
    // realpath on both sides, since a temp dir can be reported through a short
    // name on Windows and through a symlink on macOS.
    const temp = fs.realpathSync(os.tmpdir());
    expect(fs.realpathSync(first).startsWith(temp)).toBe(true);
  });
});

describe('ClaudeAdapter.openAnswerSession', () => {
  it('keeps the one-shot run\'s read-only flags and reads turns as stream-json', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-answer-test-'));
    try {
      // `exited` is part of every session: the adapter ends the run's MCP relay on it.
      sessionSpy.mockReturnValue({ exited: Promise.resolve() });
      new ClaudeAdapter().openAnswerSession({
        cliPath: '/bin/claude',
        cwd: '/answer-home',
        runDirectory: directory,
        model: 'sonnet',
        effort: 'low',
        retrieval: { url: 'http://127.0.0.1:1/mcp/p/answer-chat', token: 'secret' },
      });
      const options = sessionSpy.mock.calls[0][0] as StdinJsonSessionOptions;
      const args = options.args;
      expect(args.slice(0, 2)).toEqual(['--print', '--no-session-persistence']);
      expect(args[args.indexOf('--tools') + 1]).toBe('');
      expect(args).toContain('--strict-mcp-config');
      expect(args[args.indexOf('--permission-prompts') + 1]).toBe('none');
      expect(args[args.indexOf('--allowedTools') + 1]).toBe('mcp__kangentic__kangentic_search');
      expect(args[args.indexOf('--input-format') + 1]).toBe('stream-json');
      expect(args[args.indexOf('--output-format') + 1]).toBe('stream-json');
      expect(args).toContain('--include-partial-messages');
      expect(args[args.indexOf('--model') + 1]).toBe('sonnet');
      // It starts in the shared answer home...
      expect(options.cwd).toBe('/answer-home');
      expect(options.env).toEqual({ MAX_THINKING_TOKENS: '0' });
      // ...and its config files live in the run directory it owns.
      expect(fs.existsSync(path.join(directory, 'mcp.json'))).toBe(true);
      expect(fs.existsSync(path.join(directory, 'settings.json'))).toBe(true);
      // A turn is one user message line; a turn ends on the result line.
      expect(JSON.parse(options.formatTurn('the question'))).toEqual({
        type: 'user',
        message: { role: 'user', content: [{ type: 'text', text: 'the question' }] },
      });
      expect(options.isTurnEnd(JSON.stringify({ type: 'result', result: 'x' }))).toBe(true);
      expect(options.isTurnEnd(JSON.stringify({ type: 'assistant', message: { content: 'result' } }))).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  // The relay is for the life of the session's process. A spawn that throws
  // leaves no process, so no exit to stop it on: without the catch the relay's
  // watcher stays open for the app's lifetime. Red-green: removing the
  // `stopRelay()` in openAnswerSession's catch leaves `stopRelay` uncalled.
  describe('the run\'s MCP relay', () => {
    beforeEach(() => {
      // The first case above also started a relay; count only this case's.
      relaySpy.mockClear();
    });

    const answerInput = (runDirectory: string) => ({
      cliPath: '/bin/claude',
      cwd: '/answer-home',
      runDirectory,
      model: 'sonnet',
      effort: 'low' as const,
      retrieval: { url: 'http://127.0.0.1:1/mcp/p/answer-chat', token: 'secret' },
    });

    it('is stopped once, and the error rethrown as it was, when the session cannot be opened', () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-answer-test-'));
      try {
        const stopRelay = vi.fn();
        relaySpy.mockReturnValueOnce(stopRelay);
        const spawnError = new Error('spawn EACCES');
        sessionSpy.mockImplementationOnce(() => { throw spawnError; });

        let thrown: unknown;
        try {
          new ClaudeAdapter().openAnswerSession(answerInput(directory));
        } catch (error) {
          thrown = error;
        }

        expect(thrown).toBe(spawnError);
        // The relay was started on the run's own folder before the spawn was tried.
        expect(relaySpy.mock.calls[0][0]).toBe(directory);
        expect(stopRelay).toHaveBeenCalledTimes(1);
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });

    it('keeps running while the session lives and is stopped once, when the session exits', async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-answer-test-'));
      try {
        const stopRelay = vi.fn();
        relaySpy.mockReturnValueOnce(stopRelay);
        let endSession: () => void = () => undefined;
        sessionSpy.mockReturnValueOnce({ exited: new Promise<void>((resolve) => { endSession = resolve; }) });

        new ClaudeAdapter().openAnswerSession(answerInput(directory));
        // Let any promise reaction queued at open time run: a stop wired to the
        // open itself, rather than to the exit, would have fired by now.
        await Promise.resolve();
        expect(stopRelay).not.toHaveBeenCalled();

        endSession();
        await vi.waitFor(() => expect(stopRelay).toHaveBeenCalledTimes(1));
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });

    it('is stopped when the session ends in an error too', async () => {
      const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-answer-test-'));
      try {
        const stopRelay = vi.fn();
        relaySpy.mockReturnValueOnce(stopRelay);
        sessionSpy.mockReturnValueOnce({ exited: Promise.reject(new Error('the CLI crashed')) });

        new ClaudeAdapter().openAnswerSession(answerInput(directory));

        await vi.waitFor(() => expect(stopRelay).toHaveBeenCalledTimes(1));
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    });
  });
});

describe('makeStreamForwarder', () => {
  const line = (text: string) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text }] } });

  it('reassembles a line split across chunks before parsing it', () => {
    const events: unknown[] = [];
    const forward = makeStreamForwarder((event) => events.push(event));
    const whole = `${line('The sphere circumscribes.')}\n`;
    forward(whole.slice(0, 20));
    expect(events).toEqual([]);
    forward(whole.slice(20));
    expect(events).toEqual([{ kind: 'text', text: 'The sphere circumscribes.' }]);
  });

  it('emits every complete line in a chunk, in order', () => {
    const events: unknown[] = [];
    const forward = makeStreamForwarder((event) => events.push(event));
    forward(`${line('one')}\n${line('two')}\n`);
    expect(events).toEqual([{ kind: 'text', text: 'one' }, { kind: 'text', text: 'two' }]);
  });

  it('forwards deltas and drops the complete turn that repeats them', () => {
    const events: unknown[] = [];
    const forward = makeStreamForwarder((event) => events.push(event));
    const delta = (text: string) => JSON.stringify({
      type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } },
    });
    forward(`${delta('hello ')}\n${delta('world')}\n${line('hello world')}\n`);
    expect(events).toEqual([{ kind: 'text', text: 'hello ' }, { kind: 'text', text: 'world' }]);
  });

  it('never flushes an unterminated tail', () => {
    // It is either empty or a line the CLI never finished, and neither is an
    // event. Flushing it would hand the parser half a JSON line at best.
    const events: unknown[] = [];
    const forward = makeStreamForwarder((event) => events.push(event));
    forward(line('cut off'));
    expect(events).toEqual([]);
  });
});

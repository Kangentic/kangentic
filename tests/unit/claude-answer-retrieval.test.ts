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

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { StdinJsonSessionOptions } from '../../src/main/agent/shared/answer-session/stdin-json-session';

const { sessionSpy } = vi.hoisted(() => ({ sessionSpy: vi.fn() }));
vi.mock('../../src/main/agent/shared/answer-session/stdin-json-session', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/shared/answer-session/stdin-json-session')>();
  return { ...actual, openStdinJsonSession: sessionSpy };
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
      sessionSpy.mockReturnValue({});
      new ClaudeAdapter().openAnswerSession({
        cliPath: '/bin/claude',
        cwd: directory,
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
      expect(options.cwd).toBe(directory);
      expect(options.env).toEqual({ MAX_THINKING_TOKENS: '0' });
      // The session's config files live in the directory it owns.
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

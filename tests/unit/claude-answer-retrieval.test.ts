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

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeScopedMcpConfig, makeStreamForwarder } from '../../src/main/agent/adapters/claude/claude-adapter';

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

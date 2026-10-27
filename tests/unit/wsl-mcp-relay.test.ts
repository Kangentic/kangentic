/**
 * The relay behind a WSL CLI's stdio MCP bridge (`wsl-mcp-relay.ts`): one
 * JSON-RPC message, posted to Kangentic's loopback MCP server as any HTTP
 * client posts it, with the token the request carried, so the server's own
 * checks decide. Its answer is what the bridge prints: one line per message,
 * nothing for a notification, and a JSON-RPC error with the raw failure when
 * the server cannot answer.
 */
import { describe, it, expect, vi } from 'vitest';
import { relayMcpMessage } from '../../src/main/pty/readers/wsl-mcp-relay';

const URL = 'http://127.0.0.1:4100/mcp/project-1/session-1';
const REQUEST = JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/list' });
const NOTIFICATION = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' });

function respond(body: string, init: { status?: number; contentType?: string } = {}): typeof fetch {
  return vi.fn(async () => new Response(body, {
    status: init.status ?? 200,
    headers: init.contentType ? { 'Content-Type': init.contentType } : {},
  })) as unknown as typeof fetch;
}

describe('relayMcpMessage', () => {
  it('posts the message with the request\'s token, as an HTTP client does', async () => {
    const fetchImplementation = respond('{"jsonrpc":"2.0","id":7,"result":{"tools":[]}}', { contentType: 'application/json' });

    await relayMcpMessage({ argument: `secret-token ${URL}`, body: REQUEST, fetchImplementation });

    const [url, init] = vi.mocked(fetchImplementation).mock.calls[0];
    expect(url).toBe(URL);
    expect(init).toMatchObject({ method: 'POST', body: REQUEST });
    expect(init?.headers).toMatchObject({
      'X-Kangentic-Token': 'secret-token',
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    });
  });

  it('answers a JSON body on one line, whatever its layout', async () => {
    const pretty = JSON.stringify({ jsonrpc: '2.0', id: 7, result: { text: 'two\nlines' } }, null, 2);
    const answer = await relayMcpMessage({ argument: `token ${URL}`, body: REQUEST, fetchImplementation: respond(pretty, { contentType: 'application/json' }) });

    expect(answer).toBe('{"jsonrpc":"2.0","id":7,"result":{"text":"two\\nlines"}}\n');
    expect(answer.split('\n')).toHaveLength(2);
  });

  it('answers nothing for a notification the server accepted', async () => {
    expect(await relayMcpMessage({ argument: `token ${URL}`, body: NOTIFICATION, fetchImplementation: respond('', { status: 202 }) })).toBe('');
  });

  it('answers each event of a stream on its own line', async () => {
    const stream = 'event: message\ndata: {"jsonrpc":"2.0","method":"notifications/progress"}\n\nevent: message\ndata: {"jsonrpc":"2.0","id":7,"result":{}}\n\n';
    const answer = await relayMcpMessage({ argument: `token ${URL}`, body: REQUEST, fetchImplementation: respond(stream, { contentType: 'text/event-stream' }) });

    expect(answer).toBe('{"jsonrpc":"2.0","method":"notifications/progress"}\n{"jsonrpc":"2.0","id":7,"result":{}}\n');
  });

  it('passes on a JSON-RPC error the server sent with a failing status', async () => {
    const parseError = '{"jsonrpc":"2.0","error":{"code":-32700,"message":"Parse error"},"id":null}';
    const answer = await relayMcpMessage({ argument: `token ${URL}`, body: REQUEST, fetchImplementation: respond(parseError, { status: 400, contentType: 'application/json' }) });

    expect(answer).toBe(`${parseError}\n`);
  });

  it('answers a refused request with the raw status, so the agent can say what went wrong', async () => {
    const answer = await relayMcpMessage({ argument: `wrong ${URL}`, body: REQUEST, fetchImplementation: respond('', { status: 401 }) });

    expect(JSON.parse(answer)).toEqual({ jsonrpc: '2.0', id: 7, error: { code: -32603, message: 'HTTP 401' } });
  });

  it('answers a connection failure with its message and cause', async () => {
    const fetchImplementation = vi.fn(async () => {
      throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:4100') });
    }) as unknown as typeof fetch;

    const answer = await relayMcpMessage({ argument: `token ${URL}`, body: REQUEST, fetchImplementation });

    expect(JSON.parse(answer).error.message).toBe('fetch failed: connect ECONNREFUSED 127.0.0.1:4100');
  });

  it('answers nothing when a notification fails, since nothing waits on it', async () => {
    expect(await relayMcpMessage({ argument: `token ${URL}`, body: NOTIFICATION, fetchImplementation: respond('', { status: 500 }) })).toBe('');
  });

  // The relay reaches Kangentic's MCP paths on 127.0.0.1 and nothing else.
  it.each([
    'https://127.0.0.1:4100/mcp/project-1',
    'http://localhost:4100/mcp/project-1',
    'http://192.168.1.20:4100/mcp/project-1',
    'http://127.0.0.1:4100/admin',
    'not a url',
  ])('refuses %s without posting', async (url) => {
    const fetchImplementation = respond('{}');
    const answer = await relayMcpMessage({ argument: `token ${url}`, body: REQUEST, fetchImplementation });

    expect(fetchImplementation).not.toHaveBeenCalled();
    expect(JSON.parse(answer).error.message).toMatch(/^Not (a URL|Kangentic's MCP server)/);
  });
});

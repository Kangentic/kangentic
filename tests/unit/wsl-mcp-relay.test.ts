/**
 * The relay behind a WSL CLI's stdio MCP bridge (`wsl-mcp-relay.ts`): one
 * JSON-RPC message, posted to Kangentic's loopback MCP server as any HTTP
 * client posts it, with the token the request carried, so the server's own
 * checks decide. Its answer is what the bridge prints: one line per message,
 * nothing for a notification, and a JSON-RPC error with the raw failure when
 * the server cannot answer.
 */
import { describe, it, expect, vi } from 'vitest';
import { oversizeAnswer, relayMcpMessage, setMcpRelayServer } from '../../src/main/pty/readers/wsl-mcp-relay';

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

  it('answers a refused request with the raw status and what to do, so the agent can recover', async () => {
    const answer = await relayMcpMessage({ argument: `wrong ${URL}`, body: REQUEST, fetchImplementation: respond('', { status: 401 }) });

    const error = JSON.parse(answer);
    expect(error).toMatchObject({ jsonrpc: '2.0', id: 7, error: { code: -32603 } });
    expect(error.error.message).toMatch(/^HTTP 401\. /);
    expect(error.error.message).toContain('Restart this session');
  });

  it('says the server is off, or the project not open in it, for a 404, and to retry once for a server error', async () => {
    const missing = JSON.parse(await relayMcpMessage({ argument: `token ${URL}`, body: REQUEST, fetchImplementation: respond('', { status: 404 }) }));
    expect(missing.error.message).toMatch(/^HTTP 404\. .*turned off.*Settings, MCP Server/);

    const failed = JSON.parse(await relayMcpMessage({ argument: `token ${URL}`, body: REQUEST, fetchImplementation: respond('boom', { status: 500 }) }));
    expect(failed.error.message).toMatch(/^HTTP 500: boom\. .*Retry once/);
  });

  it('answers a connection failure with its message and cause, and says to retry', async () => {
    const fetchImplementation = vi.fn(async () => {
      throw new TypeError('fetch failed', { cause: new Error('connect ECONNREFUSED 127.0.0.1:4100') });
    }) as unknown as typeof fetch;

    const answer = await relayMcpMessage({ argument: `token ${URL}`, body: REQUEST, fetchImplementation });

    const message = JSON.parse(answer).error.message;
    expect(message).toContain('fetch failed: connect ECONNREFUSED 127.0.0.1:4100');
    expect(message).toContain('Retry in a moment');
  });

  it('gives up on a call the server never answers, and says it may still be running', async () => {
    // A fetch that honors its signal, as the real one does.
    const fetchImplementation = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    })) as unknown as typeof fetch;

    const answer = await relayMcpMessage({ argument: `token ${URL}`, body: REQUEST, fetchImplementation, timeoutMs: 20 });

    expect(JSON.parse(answer).error.message).toMatch(/did not answer within 0 seconds\. The call may still be running/);
  });

  describe('the server that is running now', () => {
    const RUNNING = { baseUrl: 'http://127.0.0.1:55001/mcp', token: 'current-token' };

    it('is the one posted to, with its own token, whatever address and token the agent was started with', async () => {
      const fetchImplementation = respond('{"jsonrpc":"2.0","id":7,"result":{}}', { contentType: 'application/json' });

      await relayMcpMessage({ argument: 'stale-token http://127.0.0.1:4100/mcp/project-1/session-1?caller=abc', body: REQUEST, fetchImplementation, server: RUNNING });

      const [url, init] = vi.mocked(fetchImplementation).mock.calls[0];
      expect(url).toBe('http://127.0.0.1:55001/mcp/project-1/session-1?caller=abc');
      expect(init?.headers).toMatchObject({ 'X-Kangentic-Token': 'current-token' });
    });

    it('is read when a message arrives, so a relaunch is followed and a server that is gone is no server', async () => {
      const fetchImplementation = respond('{"jsonrpc":"2.0","id":7,"result":{}}', { contentType: 'application/json' });
      let running: typeof RUNNING | null = RUNNING;
      setMcpRelayServer(() => running);
      try {
        await relayMcpMessage({ argument: `old http://127.0.0.1:4100/mcp/project-1`, body: REQUEST, fetchImplementation });
        running = { baseUrl: 'http://127.0.0.1:55002/mcp', token: 'next-token' };
        await relayMcpMessage({ argument: `old http://127.0.0.1:4100/mcp/project-1`, body: REQUEST, fetchImplementation });
        running = null;
        await relayMcpMessage({ argument: `old http://127.0.0.1:4100/mcp/project-1`, body: REQUEST, fetchImplementation });
      } finally {
        setMcpRelayServer(null);
      }

      const calls = vi.mocked(fetchImplementation).mock.calls;
      expect(calls[0][0]).toBe('http://127.0.0.1:55001/mcp/project-1');
      expect(calls[1][0]).toBe('http://127.0.0.1:55002/mcp/project-1');
      expect(calls[1][1]?.headers).toMatchObject({ 'X-Kangentic-Token': 'next-token' });
      // With no server registered the request's own address stands, as before.
      expect(calls[2][0]).toBe('http://127.0.0.1:4100/mcp/project-1');
    });

    it('still refuses an address that is not Kangentic\'s, so a host cannot name a path on the running server\'s port', async () => {
      const fetchImplementation = respond('{}');

      const answer = await relayMcpMessage({ argument: 'token http://127.0.0.1:4100/admin', body: REQUEST, fetchImplementation, server: RUNNING });

      expect(fetchImplementation).not.toHaveBeenCalled();
      expect(JSON.parse(answer).error.message).toMatch(/^Not Kangentic's MCP server/);
    });
  });

  describe('oversizeAnswer', () => {
    it('answers with the request\'s own id and says to ask for less or save to a file', () => {
      const answer = oversizeAnswer('{"jsonrpc":"2.0","id":"call-9","result":{"content":[{"type":"image"}]}}\n', 3_000_000, 1_000_000);

      const parsed = JSON.parse(answer ?? '');
      expect(parsed).toMatchObject({ jsonrpc: '2.0', id: 'call-9', error: { code: -32603 } });
      expect(parsed.error.message).toContain('saveToFile');
      expect(parsed.error.message).toContain('2930 KB');
    });

    it('has nothing to answer for a notification, which no one waits on', () => {
      expect(oversizeAnswer('{"jsonrpc":"2.0","method":"notifications/progress"}\n', 3_000_000, 1_000_000)).toBeNull();
      expect(oversizeAnswer('not json', 3_000_000, 1_000_000)).toBeNull();
    });
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

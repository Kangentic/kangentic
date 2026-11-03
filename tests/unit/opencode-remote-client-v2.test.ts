/**
 * OpenCode 2 remote client (`remote-client-v2.ts`): the server probe, session
 * creation, message paging and the transcript mapping, against responses
 * recorded from a live `opencode serve` 2.2.5 (`tests/fixtures/opencode-v2/`).
 * A V2 remote session's transcript and its "Test connection" result both come
 * from this module, so a wrong field name here shows the user an empty
 * conversation or a server that "cannot be reached".
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import {
  createOpenCodeV2Session,
  fetchOpenCodeV2SessionMessages,
  mapOpenCodeV2Messages,
  openCodeV2AuthHeaders,
  probeOpenCodeV2Server,
  type OpenCodeV2Fetch,
  type OpenCodeV2Message,
} from '../../src/main/agent/adapters/opencode/remote-client-v2';
import type { AgentExecutionServer } from '../../src/shared/types';

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'opencode-v2');

function fixture<T>(name: string): T {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8')) as T;
}

interface MessagesBody {
  data: OpenCodeV2Message[];
  cursor: { previous: string | null; next: string | null };
}

const SERVER: AgentExecutionServer = {
  url: 'http://10.0.0.5:4096/',
  auth: { kind: 'basic', username: 'alice', password: 'hunter2' },
};

const EXPECTED_AUTH = `Basic ${Buffer.from('opencode:hunter2').toString('base64')}`;

interface RecordedCall {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

function jsonResponse(status: number, body: unknown): ReturnType<OpenCodeV2Fetch> {
  return Promise.resolve({ ok: status >= 200 && status < 300, status, json: () => Promise.resolve(body) });
}

function fakeFetch(handler: (call: RecordedCall) => ReturnType<OpenCodeV2Fetch>): { fetchImpl: OpenCodeV2Fetch; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const fetchImpl: OpenCodeV2Fetch = (url, init) => {
    const call = { url, method: init?.method, headers: init?.headers, body: init?.body };
    calls.push(call);
    return handler(call);
  };
  return { fetchImpl, calls };
}

describe('openCodeV2AuthHeaders', () => {
  it('always authenticates as opencode, whatever username is configured', () => {
    expect(openCodeV2AuthHeaders(SERVER.auth)).toEqual({ Authorization: EXPECTED_AUTH });
  });

  it('sends no header without a password', () => {
    expect(openCodeV2AuthHeaders({ kind: 'basic', username: 'opencode', password: '' })).toEqual({});
    expect(openCodeV2AuthHeaders({ kind: 'none' })).toEqual({});
  });
});

describe('probeOpenCodeV2Server', () => {
  it('reports the version from GET /api/info', async () => {
    const { fetchImpl, calls } = fakeFetch(() => jsonResponse(200, fixture('server-info.json')));
    expect(await probeOpenCodeV2Server(SERVER, fetchImpl)).toEqual({ reachable: true, version: '2.2.5' });
    expect(calls[0].url).toBe('http://10.0.0.5:4096/api/info');
    expect(calls[0].headers).toEqual({ Authorization: EXPECTED_AUTH });
  });

  it('reports a rejected password as an authentication failure', async () => {
    const unauthorized = fixture<{ status: number; body: unknown }>('unauthorized.json');
    const { fetchImpl } = fakeFetch(() => jsonResponse(unauthorized.status, unauthorized.body));
    expect(await probeOpenCodeV2Server(SERVER, fetchImpl)).toEqual({
      reachable: false,
      reason: 'Authentication failed - check the password',
    });
  });

  it('says a password is needed when none is configured', async () => {
    const { fetchImpl } = fakeFetch(() => jsonResponse(401, {}));
    const status = await probeOpenCodeV2Server({ url: SERVER.url, auth: { kind: 'none' } }, fetchImpl);
    expect(status).toEqual({ reachable: false, reason: 'The server requires a password' });
  });

  // What an OpenCode 1.18.31 server answers on /api/info: its web app, as HTML.
  const htmlPage = (): ReturnType<OpenCodeV2Fetch> => Promise.resolve({
    ok: true,
    status: 200,
    json: () => Promise.reject(new SyntaxError('Unexpected token <')),
  });

  it('names an OpenCode 1 server from its own health route', async () => {
    const { fetchImpl, calls } = fakeFetch((call) => (call.url.endsWith('/global/health')
      ? jsonResponse(200, fixture('opencode1-global-health.json'))
      : htmlPage()));
    expect(await probeOpenCodeV2Server(SERVER, fetchImpl)).toEqual({
      reachable: false,
      reason: 'The server runs OpenCode 1.18.31, and the local OpenCode is version 2',
    });
    // A V1 server keeps its own username, so the health request carries the configured one.
    expect(calls[1].headers).toEqual({ Authorization: `Basic ${Buffer.from('alice:hunter2').toString('base64')}` });
  });

  it('names an OpenCode 1 server with its own username, which rejects opencode', async () => {
    const { fetchImpl } = fakeFetch((call) => (call.url.endsWith('/global/health')
      ? jsonResponse(200, fixture('opencode1-global-health.json'))
      : jsonResponse(401, {})));
    const status = await probeOpenCodeV2Server(SERVER, fetchImpl);
    expect(status.reachable).toBe(false);
    if (!status.reachable) expect(status.reason).toContain('OpenCode 1.18.31');
  });

  it('treats a server that answers neither API as not an OpenCode 2 server', async () => {
    const { fetchImpl } = fakeFetch(() => htmlPage());
    expect(await probeOpenCodeV2Server(SERVER, fetchImpl)).toEqual({
      reachable: false,
      reason: 'The server did not answer as an OpenCode 2 server',
    });
  });

  it('reports other HTTP failures and network errors without throwing', async () => {
    expect(await probeOpenCodeV2Server(SERVER, fakeFetch(() => jsonResponse(500, {})).fetchImpl)).toEqual({
      reachable: false,
      reason: 'Server responded with HTTP 500',
    });
    expect(await probeOpenCodeV2Server(SERVER, fakeFetch(() => jsonResponse(404, {})).fetchImpl)).toEqual({
      reachable: false,
      reason: 'Server responded with HTTP 404',
    });
    const network = await probeOpenCodeV2Server(SERVER, fakeFetch(() => Promise.reject(new Error('ECONNREFUSED'))).fetchImpl);
    expect(network).toEqual({ reachable: false, reason: 'ECONNREFUSED' });
  });

  it('needs a URL', async () => {
    expect(await probeOpenCodeV2Server({ url: null, auth: { kind: 'none' } })).toEqual({
      reachable: false,
      reason: 'No server URL configured',
    });
  });
});

describe('createOpenCodeV2Session', () => {
  it('creates the session in the server directory and returns its id', async () => {
    const { fetchImpl, calls } = fakeFetch(() => jsonResponse(200, { data: { id: 'ses_created0000000000000001' } }));
    const id = await createOpenCodeV2Session(SERVER, { directory: '/home/dev/project-a' }, fetchImpl);
    expect(id).toBe('ses_created0000000000000001');
    expect(calls[0].url).toBe('http://10.0.0.5:4096/api/session');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].headers).toMatchObject({ Authorization: EXPECTED_AUTH, 'content-type': 'application/json' });
    expect(JSON.parse(calls[0].body ?? '')).toEqual({ location: { directory: '/home/dev/project-a' } });
  });

  it('leaves the location to the server when no directory is configured', async () => {
    const { fetchImpl, calls } = fakeFetch(() => jsonResponse(200, { data: { id: 'ses_x' } }));
    await createOpenCodeV2Session(SERVER, { directory: null }, fetchImpl);
    expect(JSON.parse(calls[0].body ?? '')).toEqual({});
  });

  it('returns null when the server refuses or is unreachable', async () => {
    expect(await createOpenCodeV2Session(SERVER, {}, fakeFetch(() => jsonResponse(401, {})).fetchImpl)).toBeNull();
    expect(await createOpenCodeV2Session(SERVER, {}, fakeFetch(() => Promise.reject(new Error('down'))).fetchImpl)).toBeNull();
  });
});

describe('fetchOpenCodeV2SessionMessages', () => {
  const pages = fixture<MessagesBody[]>('session-messages-desc-pages.json');
  const ascending = fixture<MessagesBody>('session-messages-asc.json').data;

  function pagedServer(options: { failOnCursor?: boolean } = {}): ReturnType<typeof fakeFetch> {
    return fakeFetch((call) => {
      const url = new URL(call.url);
      const cursor = url.searchParams.get('cursor');
      if (!cursor) {
        expect(url.searchParams.get('order')).toBe('desc');
        return jsonResponse(200, pages[0]);
      }
      expect(url.searchParams.has('order')).toBe(false);
      if (options.failOnCursor) return jsonResponse(500, {});
      const index = pages.findIndex((page) => page.cursor.next === cursor);
      return jsonResponse(200, pages[index + 1]);
    });
  }

  it('pages newest to oldest until the history ends, and returns oldest first', async () => {
    const { fetchImpl, calls } = pagedServer();
    const { messages, complete } = await fetchOpenCodeV2SessionMessages(SERVER, 'ses_kangentic0probe0000000002', {}, fetchImpl);
    expect(messages.map((message) => message.id)).toEqual(ascending.map((message) => message.id));
    expect(complete).toBe(true);
    expect(calls).toHaveLength(3);
    expect(calls[0].url).toContain('/api/session/ses_kangentic0probe0000000002/message?');
    expect(calls[0].headers).toEqual({ Authorization: EXPECTED_AUTH });
  });

  it('stops once the pages hold the byte budget, and says the history is partial', async () => {
    const { fetchImpl, calls } = pagedServer();
    const { messages, complete } = await fetchOpenCodeV2SessionMessages(SERVER, 'ses_x', { budgetBytes: 1 }, fetchImpl);
    expect(calls).toHaveLength(1);
    expect(complete).toBe(false);
    expect(messages.map((message) => message.id)).toEqual([...pages[0].data].reverse().map((message) => message.id));
  });

  it('stops at the page cap, and says the history is partial', async () => {
    const { fetchImpl, calls } = pagedServer();
    const { complete } = await fetchOpenCodeV2SessionMessages(SERVER, 'ses_x', { maxPages: 2 }, fetchImpl);
    expect(calls).toHaveLength(2);
    expect(complete).toBe(false);
  });

  it('keeps the newer pages when a later page fails', async () => {
    const { fetchImpl } = pagedServer({ failOnCursor: true });
    const { messages, complete } = await fetchOpenCodeV2SessionMessages(SERVER, 'ses_x', {}, fetchImpl);
    expect(messages).toHaveLength(pages[0].data.length);
    expect(complete).toBe(false);
  });

  it('returns nothing when the first page fails', async () => {
    const empty = { messages: [], complete: false };
    expect(await fetchOpenCodeV2SessionMessages(SERVER, 'ses_x', {}, fakeFetch(() => jsonResponse(404, {})).fetchImpl)).toEqual(empty);
    expect(await fetchOpenCodeV2SessionMessages(SERVER, 'ses_x', {}, fakeFetch(() => Promise.reject(new Error('down'))).fetchImpl)).toEqual(empty);
    expect(await fetchOpenCodeV2SessionMessages({ url: null, auth: { kind: 'none' } }, 'ses_x')).toEqual(empty);
  });
});

describe('mapOpenCodeV2Messages', () => {
  it('maps a recorded session with reasoning, a finished tool, a failed tool and an answer', () => {
    const entries = mapOpenCodeV2Messages(fixture<MessagesBody>('session-messages-asc.json').data);
    expect(entries.map((entry) => entry.kind)).toEqual(['user', 'assistant', 'tool_result', 'tool_result', 'assistant']);

    const [user, toolTurn, readOk, readMissing, answer] = entries;
    expect(user).toMatchObject({ kind: 'user', text: 'Read readme.txt and missing.txt.' });
    expect(toolTurn).toMatchObject({
      kind: 'assistant',
      model: 'stub-model',
      blocks: [
        { type: 'thinking', text: 'I will read both files the user named.' },
        { type: 'tool_use', id: 'call_read_ok', name: 'read', input: { path: 'readme.txt' } },
        { type: 'tool_use', id: 'call_read_missing', name: 'read', input: { path: 'missing.txt' } },
      ],
    });
    expect(readOk).toMatchObject({ kind: 'tool_result', toolUseId: 'call_read_ok', isError: false });
    expect(readOk.kind === 'tool_result' && readOk.content).toContain('This is project A on the server.');
    expect(readMissing).toMatchObject({ kind: 'tool_result', toolUseId: 'call_read_missing', isError: true, content: 'File not found: missing.txt' });
    expect(answer).toMatchObject({
      kind: 'assistant',
      blocks: [{ type: 'text', text: 'readme.txt says this is project A. missing.txt does not exist.' }],
    });
    expect(typeof user.ts).toBe('number');
  });

  it('keeps the prompt of a turn the provider refused, and drops the bookkeeping messages', () => {
    const entries = mapOpenCodeV2Messages(fixture<MessagesBody>('session-messages-provider-error.json').data);
    expect(entries).toEqual([
      expect.objectContaining({ kind: 'user', text: expect.stringContaining('Read readme.txt') }),
    ]);
  });

  it('parses the argument text of a tool that is still streaming', () => {
    const entries = mapOpenCodeV2Messages([{
      id: 'msg_1',
      type: 'assistant',
      time: { created: 1 },
      content: [
        { type: 'tool', id: 'call_a', name: 'read', state: { status: 'streaming', input: '{"path":"a.txt"}' } },
        { type: 'tool', id: 'call_b', name: 'read', state: { status: 'streaming', input: '{"pa' } },
      ],
    }]);
    expect(entries).toEqual([expect.objectContaining({
      kind: 'assistant',
      blocks: [
        { type: 'tool_use', id: 'call_a', name: 'read', input: { path: 'a.txt' } },
        { type: 'tool_use', id: 'call_b', name: 'read', input: '{"pa' },
      ],
    })]);
  });
});

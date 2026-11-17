/**
 * The browser sign-in's loopback listener, shared by Linear, Jira and Trello.
 *
 * What a user loses without each case: a stray or forged request that ends the
 * sign-in lets another page finish (or fail) someone's sign-in; a port below
 * 1024 is one the token service refuses, so the browser never comes back; a
 * Jira sign-in that cancels a waiting Linear one strands the other dialog; and a
 * cancel that loses to the work after the callback saves a sign-in behind the
 * user's back.
 *
 * Runs a real server on a port the OS picks; the browser is a stub that records
 * the approval page's address.
 */
import http from 'node:http';
import { describe, it, expect, afterEach } from 'vitest';
import {
  LoopbackSignInFailure,
  cancelLoopbackSignIn,
  reopenLoopbackSignIn,
  runLoopbackSignIn,
  type LoopbackCallbackAnswer,
  type LoopbackProvider,
} from '../../src/main/boards/shared/loopback-sign-in';

const PAGES = { done: 'done page', failed: 'failed page' };
const MESSAGES = { noFreePort: 'no port', timedOut: 'timed out', browserNotOpened: 'no browser' };

function get(url: string): Promise<number> {
  return new Promise((resolve, reject) => {
    http.get(url, { agent: false }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    }).on('error', reject);
  });
}

/** A callback that is done for `ok=1`, an error for `fail=<text>`, and ignored otherwise. */
function answerFor(params: URLSearchParams): LoopbackCallbackAnswer<string> {
  if (params.get('ok')) return { kind: 'done', value: params.get('ok') ?? '' };
  const failure = params.get('fail');
  if (failure) return { kind: 'error', message: failure };
  return { kind: 'ignore' };
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

/** A request with an explicit target, so a path the URL parser refuses (`//`) reaches the server as sent. */
function rawRequest(port: number, requestPath: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port, path: requestPath, agent: false }, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { body += chunk; });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

function start(
  provider: LoopbackProvider,
  options: {
    finish?: (value: string) => Promise<string>;
    timeoutMs?: number;
    openExternal?: (url: string) => Promise<void>;
    pages?: { done: string; failed: string };
  } = {},
) {
  let resolvePort: (port: number) => void = () => {};
  const port = new Promise<number>((resolve) => { resolvePort = resolve; });
  const opened: string[] = [];
  const result = runLoopbackSignIn<string, string>({
    provider,
    path: '/test/callback',
    ports: 'ephemeral',
    buildAuthorizeUrl: (boundPort) => {
      resolvePort(boundPort);
      return `https://approve.example/?port=${boundPort}`;
    },
    handleCallback: answerFor,
    finish: options.finish ?? (async (value) => `finished:${value}`),
    pages: options.pages ?? PAGES,
    messages: MESSAGES,
    openExternal: options.openExternal ?? (async (url) => { opened.push(url); }),
    timeoutMs: options.timeoutMs ?? 10_000,
    logPrefix: '[test]',
  });
  return { port, result, opened };
}

afterEach(() => {
  cancelLoopbackSignIn('jira');
  cancelLoopbackSignIn('trello');
  cancelLoopbackSignIn('linear');
});

describe('runLoopbackSignIn', () => {
  it('binds a free port of at least 1024 on 127.0.0.1 and finishes on the callback', async () => {
    const { port, result, opened } = start('jira');
    const boundPort = await port;
    expect(boundPort).toBeGreaterThanOrEqual(1024);
    await expect.poll(() => opened.length).toBe(1);
    expect(await get(`http://127.0.0.1:${boundPort}/test/callback?ok=tokens`)).toBe(200);
    await expect(result).resolves.toEqual({ ok: true, value: 'finished:tokens' });
  });

  it('answers a request it does not recognize with 400 and keeps waiting', async () => {
    const { port, result } = start('jira');
    const boundPort = await port;
    expect(await get(`http://127.0.0.1:${boundPort}/test/callback?nonce=forged`)).toBe(400);
    expect(await get(`http://127.0.0.1:${boundPort}/elsewhere`)).toBe(404);
    expect(await get(`http://127.0.0.1:${boundPort}/test/callback?ok=late`)).toBe(200);
    await expect(result).resolves.toEqual({ ok: true, value: 'finished:late' });
  });

  it("ends with the provider's error", async () => {
    const { port, result } = start('trello');
    const boundPort = await port;
    expect(await get(`http://127.0.0.1:${boundPort}/test/callback?fail=declined`)).toBe(200);
    await expect(result).resolves.toEqual({ ok: false, cancelled: false, error: 'declined' });
  });

  it('a failure finish explains is the error; a cancel during finish wins', async () => {
    const failing = start('jira', { finish: async () => { throw new LoopbackSignInFailure("can't open the site"); } });
    await get(`http://127.0.0.1:${await failing.port}/test/callback?ok=x`);
    await expect(failing.result).resolves.toEqual({ ok: false, cancelled: false, error: "can't open the site" });

    let releaseFinish: () => void = () => {};
    let markEntered: () => void = () => {};
    const entered = new Promise<void>((resolve) => { markEntered = resolve; });
    const held = start('jira', {
      finish: (value) => new Promise((resolve) => {
        releaseFinish = () => resolve(value);
        markEntered();
      }),
    });
    await get(`http://127.0.0.1:${await held.port}/test/callback?ok=x`);
    // The callback's response can arrive before `finish` runs, so wait for it.
    await entered;
    cancelLoopbackSignIn('jira');
    releaseFinish();
    await expect(held.result).resolves.toEqual({ ok: false, cancelled: true });
  });

  it('cancels only its own provider, and frees the port', async () => {
    const jira = start('jira');
    const linear = start('linear');
    const jiraPort = await jira.port;
    await linear.port;
    cancelLoopbackSignIn('jira');
    await expect(jira.result).resolves.toEqual({ ok: false, cancelled: true });
    // Linear is still waiting: its callback still finishes it.
    expect(await get(`http://127.0.0.1:${await linear.port}/test/callback?ok=linear`)).toBe(200);
    await expect(linear.result).resolves.toEqual({ ok: true, value: 'finished:linear' });
    await expect(get(`http://127.0.0.1:${jiraPort}/test/callback?ok=x`)).rejects.toThrow();
  });

  it('a second sign-in for the same provider cancels the first', async () => {
    const first = start('trello');
    await first.port;
    const second = start('trello');
    await expect(first.result).resolves.toEqual({ ok: false, cancelled: true });
    await get(`http://127.0.0.1:${await second.port}/test/callback?ok=second`);
    await expect(second.result).resolves.toEqual({ ok: true, value: 'finished:second' });
  });

  it('opens the approval page again for the pending sign-in only', async () => {
    const { port, opened } = start('jira');
    await port;
    await expect.poll(() => opened.length).toBe(1);
    expect(await reopenLoopbackSignIn('jira')).toBe(true);
    expect(opened).toHaveLength(2);
    expect(opened[1]).toBe(opened[0]);
    expect(await reopenLoopbackSignIn('trello')).toBe(false);
  });

  it('times out, and reports a browser that would not open', async () => {
    const slow = start('jira', { timeoutMs: 50 });
    await expect(slow.result).resolves.toEqual({ ok: false, cancelled: false, error: 'timed out' });

    const noBrowser = start('trello', { openExternal: async () => { throw new Error('no handler'); } });
    await expect(noBrowser.result).resolves.toEqual({ ok: false, cancelled: false, error: 'no browser' });
  });

  it('answers a request target the URL parser refuses with 400 and keeps waiting', async () => {
    const { port, result } = start('jira');
    const boundPort = await port;
    // `//` makes `new URL('//', base)` throw; an uncaught throw in the handler would take down main.
    expect((await rawRequest(boundPort, '//')).status).toBe(400);
    expect(await get(`http://127.0.0.1:${boundPort}/test/callback?ok=after`)).toBe(200);
    await expect(result).resolves.toEqual({ ok: true, value: 'finished:after' });
  });

  it('a cancel while the port is still binding resolves cancelled and never opens the browser', async () => {
    const { result, opened } = start('jira');
    cancelLoopbackSignIn('jira');
    await expect(result).resolves.toEqual({ ok: false, cancelled: true });
    expect(opened).toHaveLength(0);
  });

  it('a reopen while the port is still binding returns false and opens nothing', async () => {
    const { result, opened } = start('jira');
    expect(await reopenLoopbackSignIn('jira')).toBe(false);
    expect(opened).toHaveLength(0);
    cancelLoopbackSignIn('jira');
    await expect(result).resolves.toEqual({ ok: false, cancelled: true });
  });

  it('a second sign-in started before the first binds cancels the first without opening the browser', async () => {
    const first = start('linear');
    const second = start('linear');
    await expect(first.result).resolves.toEqual({ ok: false, cancelled: true });
    expect(first.opened).toHaveLength(0);
    expect(await get(`http://127.0.0.1:${await second.port}/test/callback?ok=second`)).toBe(200);
    await expect(second.result).resolves.toEqual({ ok: true, value: 'finished:second' });
    expect(second.opened).toHaveLength(1);
  });

  it('a LoopbackSignInFailure thrown after the user cancelled during finish resolves as cancelled', async () => {
    let enteredFinish: () => void = () => {};
    const entered = new Promise<void>((resolve) => { enteredFinish = resolve; });
    let failFinish: () => void = () => {};
    const held = start('jira', {
      finish: () => new Promise<string>((_resolve, reject) => {
        enteredFinish();
        failFinish = () => reject(new LoopbackSignInFailure('site unreachable'));
      }),
    });
    await get(`http://127.0.0.1:${await held.port}/test/callback?ok=x`);
    await entered;
    cancelLoopbackSignIn('jira');
    failFinish();
    await expect(held.result).resolves.toEqual({ ok: false, cancelled: true });
  });

  it('a plain Error thrown by finish rejects the sign-in with that error', async () => {
    const broken = start('jira', { finish: async () => { throw new TypeError('unexpected defect'); } });
    // Attach the rejection handler before the callback can settle it.
    const rejection = expect(broken.result).rejects.toThrow('unexpected defect');
    await get(`http://127.0.0.1:${await broken.port}/test/callback?ok=x`);
    await rejection;
  });

  it('serves the done page uncached with no referrer, and escapes HTML in its text', async () => {
    const { port, result } = start('jira', { pages: { done: '<b>&"', failed: 'failed page' } });
    const response = await rawRequest(await port, '/test/callback?ok=x');
    expect(response.status).toBe(200);
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toContain('<p>&#60;b&#62;&#38;&#34;</p>');
    expect(response.body).not.toContain('<b>');
    await result;
  });
});

/**
 * scripts/check-integrations.mjs, the daily check that the shipped Trello, Jira,
 * Linear and GitLab sign-ins still work (.github/workflows/integrations.yml). The
 * script runs before any install, so it reads the desktop's constants as source
 * text, and nothing but this file holds what it reads equal to what the app
 * sends.
 *
 * What goes wrong without each block:
 * - the shipped values: a constant reformatted or moved turns the nightly red
 *   for no reason, or the check keeps asking about an address the app has left;
 * - what it sends: the approval URL or the state drifts from the desktop's, and
 *   a green run then proves a sign-in nobody makes;
 * - the verdicts: a dead key, a dropped origin or a revoked client reads as ok
 *   or pending, which is the one failure the workflow exists to catch.
 *
 * The recorded block replays what the live services answered, from
 * tests/fixtures/sign-in-check-live-answers.json. The hand-built answers in the
 * tables follow the shapes the script's header lists. Atlassian's invalid_grant,
 * its refusal codes, Linear's and GitLab's invalid_grant and the answers that
 * need a live Trello key have not been recorded, so those rows are the
 * documented shape and not a recording. No test here sends a request.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { __testing } from '../../scripts/check-integrations.mjs';
import { __testing as distribution } from '../../scripts/check-distribution.mjs';
import { DOCS_BASE_URL } from '../../src/shared/docs-links';
import {
  TRELLO_API_BASE,
  TRELLO_API_KEY,
  TRELLO_RETURN_URL,
  buildAuthorizeUrl,
  buildTrelloReturnUrl,
} from '../../src/main/boards/adapters/trello/constants';
import {
  JIRA_OAUTH_CALLBACK_PATH,
  JIRA_OAUTH_CLIENT_ID,
  JIRA_OAUTH_REDIRECT_URI,
  JIRA_OAUTH_REFRESH_URL,
} from '../../src/main/boards/adapters/jira/constants';
import {
  LINEAR_OAUTH_CLIENT_ID,
  LINEAR_OAUTH_REDIRECT_PORTS,
  LINEAR_OAUTH_TOKEN_URL,
} from '../../src/main/boards/adapters/linear/constants';
import { redirectUriFor } from '../../src/main/boards/adapters/linear/oauth';
import {
  GITLAB_COM_BASE,
  GITLAB_COM_OAUTH_CLIENT_ID,
  GITLAB_OAUTH_REDIRECT_HOST,
  GITLAB_OAUTH_REDIRECT_PATH,
} from '../../src/main/boards/adapters/gitlab/constants';
import { exchangeGitLabAuthorizationCode } from '../../src/main/boards/adapters/gitlab/oauth-tokens';
import { LOOPBACK_HOST } from '../../src/main/boards/shared/loopback-sign-in';
import { createSealedSignInKeys, decodeBase64Url } from '../../src/main/boards/shared/sealed-token';

const {
  SOURCE_FILES,
  STATE_PORT,
  readShippedValues,
  signInState,
  trelloReturnPageUrl,
  trelloAuthorizeUrl,
  checkTrelloKey,
  checkTrelloPage,
  checkJiraCallback,
  checkJiraService,
  checkLinear,
  checkGitLab,
  runChecks,
  tableLines,
  annotationLines,
  summaryMarkdown,
  exitCodeFor,
  sendRequest,
  main,
} = __testing;

type SendRequest = (url: string, init?: RequestInit) => Promise<Response>;
type ShippedValues = ReturnType<typeof readShippedValues>;

const REPO_ROOT = path.resolve(__dirname, '../..');
const shipped = readShippedValues(REPO_ROOT, {});

const NOT_SHIPPED = { value: '', source: 'its constants file' };
const SET = { value: 'made-up-id', source: 'the environment' };

function answer(status: number, body: string | null = null, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

function errorAnswer(status: number, error: string): Response {
  return answer(status, JSON.stringify({ error }), { 'content-type': 'application/json' });
}

function statusesOf(results: Array<{ status: string }>): string[] {
  return results.map((result) => result.status);
}

function decodeState(state: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(state, 'base64url').toString('utf8')) as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Canned services, each answering the way the real one did
// ---------------------------------------------------------------------------

function trelloAnswers(apiAnswer: () => Response, approvalAnswer: () => Response): SendRequest {
  return async (url) => (url.startsWith(TRELLO_API_BASE) ? apiAnswer() : approvalAnswer());
}

function cspHash(text: string): string {
  return `'sha256-${createHash('sha256').update(text, 'utf8').digest('base64')}'`;
}

/** The return page, with a policy that hashes `hashed` (what was deployed) over a body that serves `served`. */
function returnPage(served: { script: string; style: string }, hashed = served): Response {
  return answer(200, `<!doctype html><style>${served.style}</style><body><script>${served.script}</script>`, {
    'content-security-policy': `default-src 'none'; script-src ${cspHash(hashed.script)}; style-src ${cspHash(hashed.style)}`,
  });
}

const DEPLOYED_PAGE = { script: 'seal()', style: 'body{margin:0}' };

function returnPageAnswers(goodState: () => Response, badState: () => Response = () => answer(400)): SendRequest {
  return async (url) => (new URL(url).searchParams.get('state') === 'bad' ? badState() : goodState());
}

/** The Jira callback: a 400 for a bad state, and a redirect built from the state's own port and nonce. */
function callbackAnswers(
  redirectFor: (state: { port: number; nonce: string }) => string,
  badState: () => Response = () => answer(400),
): SendRequest {
  return async (url) => {
    const state = new URL(url).searchParams.get('state') ?? '';
    if (state === 'bad') return badState();
    const fields = decodeState(state);
    return answer(302, null, { location: redirectFor({ port: Number(fields.port), nonce: String(fields.nonce) }) });
  };
}

function loopbackRedirect({ port, nonce }: { port: number; nonce: string }): string {
  return `http://${LOOPBACK_HOST}:${port}${JIRA_OAUTH_CALLBACK_PATH}?error=invalid_request&nonce=${nonce}`;
}

const serviceDown: SendRequest = async () => {
  throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND api.example.test') });
};

/** kangentic.com with both pages up and its refresh route answering `refresh`. Any other address throws. */
function kangenticSite(refresh: () => Response): SendRequest {
  return async (url, init) => {
    if (url.startsWith(TRELLO_RETURN_URL)) return returnPageAnswers(() => returnPage(DEPLOYED_PAGE))(url, init);
    if (url.startsWith(JIRA_OAUTH_REDIRECT_URI)) return callbackAnswers(loopbackRedirect)(url, init);
    if (url === JIRA_OAUTH_REFRESH_URL) return refresh();
    throw new Error(`the run asked ${url}, which no sign-in is shipped for`);
  };
}

// ---------------------------------------------------------------------------

const copies: string[] = [];

/** A temp directory, removed after the test. */
function tempDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'check-integrations-'));
  copies.push(directory);
  return directory;
}

/** A copy of the files the script reads, under a temp root, each passed through `edit`. */
function checkoutWith(edit: (file: string, text: string) => string | null): string {
  const root = tempDirectory();
  for (const file of SOURCE_FILES) {
    const edited = edit(file, fs.readFileSync(path.join(REPO_ROOT, file), 'utf8'));
    if (edited === null) continue;
    const target = path.join(root, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, edited);
  }
  return root;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const root of copies.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('the shipped values it reads', () => {
  it('are what the real modules export', () => {
    expect({
      site: shipped.site,
      trelloKey: shipped.trelloKey.value,
      jiraClientId: shipped.jiraClientId.value,
      linearClientId: shipped.linearClientId.value,
      trelloApiBase: shipped.trelloApiBase,
      trelloReturnUrl: shipped.trelloReturnUrl,
      jiraCallbackUrl: shipped.jiraCallbackUrl,
      jiraRefreshUrl: shipped.jiraRefreshUrl,
      jiraLoopbackPath: shipped.jiraLoopbackPath,
      loopbackHost: shipped.loopbackHost,
      linearTokenUrl: shipped.linearTokenUrl,
      linearRedirectUri: shipped.linearRedirectUri,
      gitlabClientId: shipped.gitlabClientId.value,
      gitlabTokenUrl: shipped.gitlabTokenUrl,
      gitlabRedirectUri: shipped.gitlabRedirectUri,
    }).toEqual({
      site: DOCS_BASE_URL,
      trelloKey: TRELLO_API_KEY,
      jiraClientId: JIRA_OAUTH_CLIENT_ID,
      linearClientId: LINEAR_OAUTH_CLIENT_ID,
      trelloApiBase: TRELLO_API_BASE,
      trelloReturnUrl: TRELLO_RETURN_URL,
      jiraCallbackUrl: JIRA_OAUTH_REDIRECT_URI,
      jiraRefreshUrl: JIRA_OAUTH_REFRESH_URL,
      jiraLoopbackPath: JIRA_OAUTH_CALLBACK_PATH,
      loopbackHost: LOOPBACK_HOST,
      linearTokenUrl: LINEAR_OAUTH_TOKEN_URL,
      linearRedirectUri: redirectUriFor(LINEAR_OAUTH_REDIRECT_PORTS[0]),
      gitlabClientId: GITLAB_COM_OAUTH_CLIENT_ID,
      gitlabTokenUrl: `${GITLAB_COM_BASE}/oauth/token`,
      gitlabRedirectUri: `http://${GITLAB_OAUTH_REDIRECT_HOST}:${STATE_PORT}${GITLAB_OAUTH_REDIRECT_PATH}`,
    });
  });

  it('read the same from a checkout with CRLF line endings', () => {
    const windowsCheckout = checkoutWith((_file, text) => text.replace(/\r?\n/g, '\r\n'));
    expect(readShippedValues(windowsCheckout, {})).toEqual(shipped);
  });

  it.each([
    {
      change: 'an id renamed',
      file: 'src/main/boards/adapters/trello/constants.ts',
      edit: (text: string) => text.replace('export const TRELLO_API_KEY =', 'export const TRELLO_KEY ='),
      message: 'TRELLO_API_KEY is no longer a quoted string in src/main/boards/adapters/trello/constants.ts',
    },
    {
      change: 'the port list built another way',
      file: 'src/main/boards/adapters/linear/constants.ts',
      edit: (text: string) => text.replace(/(export const LINEAR_OAUTH_REDIRECT_PORTS[^=]*= )\[[^\]]*\]/, '$1registeredPorts()'),
      message: 'LINEAR_OAUTH_REDIRECT_PORTS is no longer a list of numbers in src/main/boards/adapters/linear/constants.ts',
    },
    {
      change: 'a site address spelled out',
      file: 'src/main/boards/adapters/jira/constants.ts',
      edit: (text: string) => text.replace(/(export const JIRA_OAUTH_REFRESH_URL = )`[^`]*`/, "$1'https://example.test/refresh'"),
      message: 'JIRA_OAUTH_REFRESH_URL is no longer a path on DOCS_BASE_URL in src/main/boards/adapters/jira/constants.ts',
    },
    {
      change: 'the Linear redirect host written as a literal',
      file: 'src/main/boards/adapters/linear/constants.ts',
      edit: (text: string) => text.replace('export const LINEAR_OAUTH_REDIRECT_HOST = LOOPBACK_HOST;', "export const LINEAR_OAUTH_REDIRECT_HOST = 'localhost';"),
      message: 'LINEAR_OAUTH_REDIRECT_HOST is no longer LOOPBACK_HOST',
    },
    {
      change: 'a file deleted',
      file: 'src/shared/docs-links.ts',
      edit: () => null,
      message: 'src/shared/docs-links.ts is gone',
    },
  ])('throw, naming the constant and its file, on $change', ({ file, edit, message }) => {
    const moved = checkoutWith((candidate, text) => (candidate === file ? edit(text) : text));
    expect(() => readShippedValues(moved, {})).toThrow(message);
    // An override never hides a constant that moved.
    expect(() => readShippedValues(moved, { TRELLO_API_KEY: 'a-key', DOCS_BASE_URL: 'https://example.test' })).toThrow(message);
  });

  it('take an override from the environment, and treat an empty one as unset', () => {
    const overridden = readShippedValues(REPO_ROOT, {
      TRELLO_API_KEY: ' a-new-key ',
      JIRA_OAUTH_CLIENT_ID: '',
      LINEAR_OAUTH_CLIENT_ID: '   ',
      DOCS_BASE_URL: 'http://localhost:8788/',
    });
    expect(overridden.trelloKey).toEqual({ value: 'a-new-key', source: 'the environment' });
    // An empty variable must never turn a shipped id's checks into pending ones.
    expect(overridden.jiraClientId).toEqual(shipped.jiraClientId);
    expect(overridden.linearClientId).toEqual(shipped.linearClientId);
    expect(overridden.trelloReturnUrl).toBe(`http://localhost:8788${new URL(TRELLO_RETURN_URL).pathname}`);
    expect(overridden.jiraRefreshUrl).toBe(`http://localhost:8788${new URL(JIRA_OAUTH_REFRESH_URL).pathname}`);
  });
});

describe('what it sends is what the desktop sends', () => {
  it("asks Trello for approval with the desktop's own URL", () => {
    const state = createSealedSignInKeys().stateFor(STATE_PORT);
    expect(trelloAuthorizeUrl(shipped, 'a-key', state)).toBe(buildAuthorizeUrl('a-key', { returnState: state }));
  });

  it("builds a state of the desktop's shape", () => {
    const probe = signInState();
    const shapeOf = (state: string) => {
      const fields = decodeState(state);
      const publicKey = decodeBase64Url(String(fields.pub));
      return {
        keys: Object.keys(fields),
        port: fields.port,
        publicKeyBytes: publicKey?.length,
        publicKeyLead: publicKey?.[0],
        nonceBytes: decodeBase64Url(String(fields.nonce))?.length,
      };
    };
    expect(shapeOf(probe.value)).toEqual(shapeOf(createSealedSignInKeys().stateFor(probe.port)));
    expect(decodeState(probe.value).nonce).toBe(probe.nonce);
  });

  it('exchanges a made-up code with Linear, never a refresh token', async () => {
    // The refresh grant answers invalid_grant for a client Linear has never heard of.
    const send = vi.fn<SendRequest>(async () => errorAnswer(400, 'invalid_grant'));
    await checkLinear({ ...shipped, linearClientId: SET }, send);
    const [url, init] = send.mock.calls[0];
    expect(url).toBe(LINEAR_OAUTH_TOKEN_URL);
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toMatchObject({
      grant_type: 'authorization_code',
      client_id: SET.value,
      redirect_uri: redirectUriFor(LINEAR_OAUTH_REDIRECT_PORTS[0]),
    });
  });

  it("exchanges a made-up code with gitlab.com in the desktop's own form", async () => {
    // What the desktop sends, taken from its own exchange against a fetch that refuses the code.
    const desktopFetch = vi.fn<typeof fetch>(async () => errorAnswer(400, 'invalid_grant'));
    await exchangeGitLabAuthorizationCode(
      { code: 'a-code', codeVerifier: 'a-verifier', redirectUri: shipped.gitlabRedirectUri },
      desktopFetch,
    ).catch(() => undefined);
    const [desktopUrl, desktopInit] = desktopFetch.mock.calls[0];

    const send = vi.fn<SendRequest>(async () => errorAnswer(400, 'invalid_grant'));
    await checkGitLab({ ...shipped, gitlabClientId: SET }, send);
    const [url, init] = send.mock.calls[0];

    const fieldsOf = (body: unknown) => Object.fromEntries(new URLSearchParams(String(body)));
    expect(url).toBe(String(desktopUrl));
    expect(init?.method).toBe(desktopInit?.method);
    expect(init?.headers).toEqual(desktopInit?.headers);
    expect(Object.keys(fieldsOf(init?.body)).sort()).toEqual(Object.keys(fieldsOf(desktopInit?.body)).sort());
    expect(fieldsOf(init?.body)).toMatchObject({
      grant_type: 'authorization_code',
      client_id: SET.value,
      redirect_uri: shipped.gitlabRedirectUri,
    });
  });
});

describe('the Trello key', () => {
  const withKey: ShippedValues = { ...shipped, trelloKey: SET };

  it.each([
    { name: 'a live key that allows the site', api: () => answer(400, 'invalid token'), approval: () => answer(200, '<html>'), expected: ['ok', 'ok'] },
    { name: 'a key Trello no longer knows', api: () => answer(401, 'invalid key'), approval: () => answer(404), expected: ['fail', 'fail'] },
    { name: 'a live key that no longer allows the site', api: () => answer(400, 'invalid token'), approval: () => answer(400, 'Invalid return_url'), expected: ['ok', 'fail'] },
    { name: 'answers nobody has seen', api: () => answer(503, 'down'), approval: () => answer(503), expected: ['fail', 'fail'] },
  ])('reports $expected for $name', async ({ api, approval, expected }) => {
    const results = await checkTrelloKey(withKey, trelloAnswers(api, approval));
    expect(results.map((result) => result.check)).toEqual(['api key', 'allowed origin']);
    expect(statusesOf(results)).toEqual(expected);
  });

  it('names the site a key no longer allows', async () => {
    const results = await checkTrelloKey(withKey, trelloAnswers(() => answer(400, 'invalid token'), () => answer(400, 'Invalid return_url')));
    expect(results[1].detail).toBe(`${DOCS_BASE_URL} is not an allowed origin on the key`);
  });

  it('is pending, and asks Trello nothing, while no key ships', async () => {
    const send = vi.fn<SendRequest>();
    const results = await checkTrelloKey({ ...shipped, trelloKey: NOT_SHIPPED }, send);
    expect(statusesOf(results)).toEqual(['pending', 'pending']);
    expect(send).not.toHaveBeenCalled();
  });

  it('fails when Trello cannot be reached', async () => {
    const results = await checkTrelloKey(withKey, serviceDown);
    expect(statusesOf(results)).toEqual(['fail', 'fail']);
    expect(results[0].detail).toContain('ENOTFOUND');
  });

  it('asks the API about the encoded key, then the approval page about the same key', async () => {
    const key = 'a key&1';
    const send = vi.fn<SendRequest>(trelloAnswers(() => answer(400, 'invalid token'), () => answer(200, '<html>')));
    await checkTrelloKey({ ...shipped, trelloKey: { value: key, source: 'the environment' } }, send);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0]).toBe(`${TRELLO_API_BASE}/members/me?key=${encodeURIComponent(key)}`);
    const approval = new URL(send.mock.calls[1][0]);
    expect(`${approval.origin}${approval.pathname}`).toBe('https://trello.com/1/authorize');
    expect(approval.searchParams.get('key')).toBe(key);
    expect(approval.searchParams.get('return_url')?.startsWith(TRELLO_RETURN_URL)).toBe(true);
  });

  it('reports the approval page that did not answer, and keeps the API verdict', async () => {
    const send: SendRequest = async (url) => {
      if (url.startsWith(TRELLO_API_BASE)) return answer(400, 'invalid token');
      throw new Error('approval boom');
    };
    const results = await checkTrelloKey(withKey, send);
    expect(statusesOf(results)).toEqual(['ok', 'fail']);
    expect(results[1].detail).toContain("Trello's approval page");
  });

  it('reports the API that did not answer, and keeps the approval verdict', async () => {
    const send: SendRequest = async (url) => {
      if (url.startsWith(TRELLO_API_BASE)) throw new Error('api boom');
      return answer(200, '<html>');
    };
    const results = await checkTrelloKey(withKey, send);
    expect(statusesOf(results)).toEqual(['fail', 'ok']);
    expect(results[0].detail).toContain("Trello's API");
  });

  it('prints only a short, single-line piece of a long answer', async () => {
    const nul = String.fromCharCode(0);
    const lineSeparator = String.fromCharCode(0x2028);
    const body = `${'a'.repeat(100)}${nul}${'b'.repeat(100)}${lineSeparator}${'c'.repeat(98)}`;
    expect(body).toHaveLength(300);
    const results = await checkTrelloKey(withKey, trelloAnswers(() => answer(500, body), () => answer(200)));
    expect(results[0].detail).not.toContain(nul);
    expect(results[0].detail).not.toContain(lineSeparator);
    const quoted = /"([^"]*)"/.exec(results[0].detail)?.[1] ?? '';
    expect(quoted.length).toBeGreaterThan(0);
    expect(quoted.length).toBeLessThanOrEqual(120);
  });

  it('names the reason in a fetch failure whose cause has no message', async () => {
    const refused = Object.assign(new AggregateError([], ''), { code: 'ECONNREFUSED' });
    const results = await checkTrelloKey(withKey, async () => {
      throw new TypeError('fetch failed', { cause: refused });
    });
    expect(results[0].detail).toContain('ECONNREFUSED');
  });

  it('falls back to the outer message when a failure has no cause', async () => {
    const results = await checkTrelloKey(withKey, async () => {
      throw new TypeError('fetch failed');
    });
    expect(results[0].detail).toContain('fetch failed');
  });

  it('keeps an answer that carries line breaks and a workflow command on one line', async () => {
    const hostile = () => answer(500, 'oops\n::error::made up\r\n::stop-commands::x');
    const results = await checkTrelloKey(withKey, trelloAnswers(hostile, hostile));
    expect(statusesOf(results)).toEqual(['fail', 'fail']);
    for (const line of [...results.map((result) => result.detail), ...annotationLines(results)]) {
      expect(line).not.toMatch(/[\r\n]/);
    }
  });
});

describe('the Trello return page', () => {
  it.each([
    { name: 'the deployed page', good: () => returnPage(DEPLOYED_PAGE), bad: () => answer(400), expected: 'ok' },
    { name: 'a script the edge rewrote', good: () => returnPage({ ...DEPLOYED_PAGE, script: 'seal();injected()' }, DEPLOYED_PAGE), bad: () => answer(400), expected: 'fail' },
    { name: 'a style the edge rewrote', good: () => returnPage({ ...DEPLOYED_PAGE, style: 'body{}' }, DEPLOYED_PAGE), bad: () => answer(400), expected: 'fail' },
    { name: 'a page with no policy', good: () => answer(200, '<style>a</style><script>b</script>'), bad: () => answer(400), expected: 'fail' },
    { name: 'a page that is not deployed', good: () => answer(404), bad: () => answer(404), expected: 'fail' },
    { name: 'a page that takes a bad state', good: () => returnPage(DEPLOYED_PAGE), bad: () => returnPage(DEPLOYED_PAGE), expected: 'fail' },
  ])('reports $expected for $name', async ({ good, bad, expected }) => {
    expect(statusesOf(await checkTrelloPage(shipped, returnPageAnswers(good, bad)))).toEqual([expected]);
  });

  it('fails a 404 even when its body carries a script and style that match its policy', async () => {
    const { script, style } = DEPLOYED_PAGE;
    const notFound = () => answer(404, `<style>${style}</style><script>${script}</script>`, {
      'content-security-policy': `script-src ${cspHash(script)}; style-src ${cspHash(style)}`,
    });
    const [result] = await checkTrelloPage(shipped, returnPageAnswers(notFound));
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('answered 404');
  });

  it('fails a page with a style and no script', async () => {
    const [result] = await checkTrelloPage(shipped, returnPageAnswers(() => answer(200, '<style>a</style>')));
    expect(result.status).toBe('fail');
    expect(result.detail).toContain('no inline script or style');
  });

  it("asks for the desktop's own return address, then for a bad state", async () => {
    expect(trelloReturnPageUrl(shipped, 'some-state')).toBe(buildTrelloReturnUrl('some-state'));
    const send = vi.fn<SendRequest>(returnPageAnswers(() => returnPage(DEPLOYED_PAGE)));
    await checkTrelloPage(shipped, send);
    expect(send).toHaveBeenCalledTimes(2);
    const sentState = new URL(send.mock.calls[0][0]).searchParams.get('state') ?? '';
    expect(sentState).not.toBe('');
    expect(send.mock.calls[0][0]).toBe(buildTrelloReturnUrl(sentState));
    expect(new URL(send.mock.calls[1][0]).searchParams.get('state')).toBe('bad');
  });

  it('says which of the two a browser would block', async () => {
    const rewritten = returnPageAnswers(() => returnPage({ ...DEPLOYED_PAGE, script: 'seal();injected()' }, DEPLOYED_PAGE));
    const [result] = await checkTrelloPage(shipped, rewritten);
    expect(result.detail).toContain('the served script no longer');
  });
});

describe('the Jira callback', () => {
  it.each([
    { name: 'a redirect to the loopback with the nonce', send: callbackAnswers(loopbackRedirect), expected: 'ok' },
    {
      name: 'a redirect to another host',
      send: callbackAnswers(({ nonce }) => `https://example.test${JIRA_OAUTH_CALLBACK_PATH}?error=invalid_request&nonce=${nonce}`),
      expected: 'fail',
    },
    {
      name: 'a redirect to another port',
      send: callbackAnswers(({ port, nonce }) => loopbackRedirect({ port: port + 1, nonce })),
      expected: 'fail',
    },
    {
      name: 'a redirect to another path',
      send: callbackAnswers(({ port, nonce }) => `http://${LOOPBACK_HOST}:${port}/other?error=invalid_request&nonce=${nonce}`),
      expected: 'fail',
    },
    {
      name: 'a redirect that reports another error',
      send: callbackAnswers(({ port, nonce }) => `http://${LOOPBACK_HOST}:${port}${JIRA_OAUTH_CALLBACK_PATH}?error=server_error&nonce=${nonce}`),
      expected: 'fail',
    },
    { name: 'a redirect without the nonce', send: callbackAnswers(({ port }) => loopbackRedirect({ port, nonce: '' })), expected: 'fail' },
    { name: 'a redirect that is not an address', send: callbackAnswers(() => '/jira/callback'), expected: 'fail' },
    { name: 'a bad state that is not refused', send: callbackAnswers(loopbackRedirect, () => answer(302, null, { location: 'http://127.0.0.1:1/' })), expected: 'fail' },
  ])('reports $expected for $name', async ({ send, expected }) => {
    expect(statusesOf(await checkJiraCallback(shipped, send))).toEqual([expected]);
  });

  it('fails a correct Location that arrives with a status other than 302', async () => {
    const send: SendRequest = async (url) => {
      const state = new URL(url).searchParams.get('state') ?? '';
      if (state === 'bad') return answer(400);
      const fields = decodeState(state);
      return answer(200, null, { location: loopbackRedirect({ port: Number(fields.port), nonce: String(fields.nonce) }) });
    };
    expect(statusesOf(await checkJiraCallback(shipped, send))).toEqual(['fail']);
  });
});

describe('the Jira token service', () => {
  // The refusal codes below are Atlassian's documented shapes. They have not been recorded.
  it.each([
    { name: 'secrets not set, before the id ships', client: NOT_SHIPPED, status: 500, error: 'server_error', expected: 'pending' },
    { name: 'secrets not set, once the id ships', client: SET, status: 500, error: 'server_error', expected: 'fail' },
    { name: 'a client Atlassian accepts', client: SET, status: 403, error: 'invalid_grant', expected: 'ok' },
    { name: 'a client Atlassian refuses, before the id ships', client: NOT_SHIPPED, status: 401, error: 'unauthorized_client', expected: 'pending' },
    { name: 'a client Atlassian refuses, once the id ships', client: SET, status: 401, error: 'unauthorized_client', expected: 'fail' },
    { name: 'an invalid client, before the id ships', client: NOT_SHIPPED, status: 401, error: 'invalid_client', expected: 'pending' },
    { name: 'an invalid client, once the id ships', client: SET, status: 401, error: 'invalid_client', expected: 'fail' },
    { name: 'an access_denied, before the id ships', client: NOT_SHIPPED, status: 403, error: 'access_denied', expected: 'pending' },
    { name: 'an access_denied, once the id ships', client: SET, status: 403, error: 'access_denied', expected: 'fail' },
    { name: 'a server_error that is not a 500, even before the id ships', client: NOT_SHIPPED, status: 502, error: 'server_error', expected: 'fail' },
    { name: 'an answer nobody has seen, even before the id ships', client: NOT_SHIPPED, status: 502, error: '', expected: 'fail' },
  ])('reports $expected for $name', async ({ client, status, error, expected }) => {
    const results = await checkJiraService({ ...shipped, jiraClientId: client }, async () => errorAnswer(status, error));
    expect(statusesOf(results)).toEqual([expected]);
  });

  it('posts a made-up refresh token to the refresh route', async () => {
    const send = vi.fn<SendRequest>(async () => errorAnswer(403, 'invalid_grant'));
    await checkJiraService({ ...shipped, jiraClientId: SET }, send);
    expect(send).toHaveBeenCalledTimes(1);
    const [url, init] = send.mock.calls[0];
    expect(url).toBe(JIRA_OAUTH_REFRESH_URL);
    expect(init?.method).toBe('POST');
    const body = JSON.parse(String(init?.body)) as { refresh_token?: unknown };
    expect(typeof body.refresh_token).toBe('string');
    expect(String(body.refresh_token).length).toBeGreaterThan(0);
  });

  it('fails on an answer that is not JSON', async () => {
    const results = await checkJiraService({ ...shipped, jiraClientId: SET }, async () => answer(502, '<html>Bad gateway</html>'));
    expect(statusesOf(results)).toEqual(['fail']);
  });
});

describe('the Linear client', () => {
  // Only invalid_client was recorded. The invalid_grant and invalid_request rows are the documented shape.
  it.each([
    { name: 'a client Linear knows', error: 'invalid_grant', expected: 'ok' },
    { name: 'a client Linear does not know', error: 'invalid_client', expected: 'fail' },
    { name: 'an answer nobody has seen', error: 'invalid_request', expected: 'fail' },
  ])('reports $expected for $name', async ({ error, expected }) => {
    const results = await checkLinear({ ...shipped, linearClientId: SET }, async () => errorAnswer(400, error));
    expect(statusesOf(results)).toEqual([expected]);
  });

  it('sends a non-empty code and a verifier long enough for PKCE', async () => {
    const send = vi.fn<SendRequest>(async () => errorAnswer(400, 'invalid_grant'));
    await checkLinear({ ...shipped, linearClientId: SET }, send);
    const fields = Object.fromEntries(new URLSearchParams(String(send.mock.calls[0][1]?.body)));
    expect(fields.code.length).toBeGreaterThan(0);
    expect(fields.code_verifier.length).toBeGreaterThanOrEqual(43);
  });

  it('is pending, and asks Linear nothing, while no client id ships', async () => {
    const send = vi.fn<SendRequest>();
    expect(statusesOf(await checkLinear({ ...shipped, linearClientId: NOT_SHIPPED }, send))).toEqual(['pending']);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('the GitLab client', () => {
  // Only invalid_client was recorded. The invalid_grant and invalid_request rows are the documented shape.
  it.each([
    { name: 'a client gitlab.com knows', status: 400, error: 'invalid_grant', expected: 'ok' },
    { name: 'a client gitlab.com does not know', status: 401, error: 'invalid_client', expected: 'fail' },
    { name: 'an answer nobody has seen', status: 400, error: 'invalid_request', expected: 'fail' },
  ])('reports $expected for $name', async ({ status, error, expected }) => {
    const results = await checkGitLab({ ...shipped, gitlabClientId: SET }, async () => errorAnswer(status, error));
    expect(statusesOf(results)).toEqual([expected]);
  });

  it('fails an answer that is not JSON, such as a challenge page', async () => {
    const results = await checkGitLab({ ...shipped, gitlabClientId: SET }, async () => answer(403, '<html>Just a moment...</html>'));
    expect(statusesOf(results)).toEqual(['fail']);
    expect(results[0].detail).toContain('unexpected answer 403');
  });

  it('sends a non-empty code and a verifier long enough for PKCE', async () => {
    const send = vi.fn<SendRequest>(async () => errorAnswer(400, 'invalid_grant'));
    await checkGitLab({ ...shipped, gitlabClientId: SET }, send);
    const fields = Object.fromEntries(new URLSearchParams(String(send.mock.calls[0][1]?.body)));
    expect(fields.code.length).toBeGreaterThan(0);
    expect(fields.code_verifier.length).toBeGreaterThanOrEqual(43);
  });

  it('is pending, and asks gitlab.com nothing, while no client id ships', async () => {
    const send = vi.fn<SendRequest>();
    expect(statusesOf(await checkGitLab({ ...shipped, gitlabClientId: NOT_SHIPPED }, send))).toEqual(['pending']);
    expect(send).not.toHaveBeenCalled();
  });
});

describe('the run', () => {
  const CHECKS = [
    'trello api key',
    'trello allowed origin',
    'trello return page',
    'jira callback',
    'jira token service',
    'linear oauth client',
    'gitlab oauth client',
  ];
  const namesOf = (results: Array<{ area: string; check: string }>) => results.map(({ area, check }) => `${area} ${check}`);

  /** kangentic.com as it answers before any owner step, with no Atlassian secrets set. */
  const siteBeforeOwnerSteps = kangenticSite(() => errorAnswer(500, 'server_error'));

  it('passes while no sign-in is shipped, with each one listed as pending', async () => {
    const nothingShipped = {
      ...shipped,
      trelloKey: NOT_SHIPPED,
      jiraClientId: NOT_SHIPPED,
      linearClientId: NOT_SHIPPED,
      gitlabClientId: NOT_SHIPPED,
    };
    const results = await runChecks(nothingShipped, siteBeforeOwnerSteps);
    expect(namesOf(results)).toEqual(CHECKS);
    expect(statusesOf(results)).toEqual(['pending', 'pending', 'ok', 'ok', 'pending', 'pending', 'pending']);
    expect(exitCodeFor(results)).toBe(0);
  });

  it('fails every check, and the run, when nothing answers', async () => {
    const everythingShipped = { ...shipped, trelloKey: SET, jiraClientId: SET, linearClientId: SET, gitlabClientId: SET };
    const results = await runChecks(everythingShipped, serviceDown);
    expect(namesOf(results)).toEqual(CHECKS);
    expect(statusesOf(results)).toEqual(['fail', 'fail', 'fail', 'fail', 'fail', 'fail', 'fail']);
    expect(exitCodeFor(results)).toBe(1);
  });

  it('fails the run on one failure among passes', () => {
    const passed = { area: 'jira', check: 'callback', status: 'ok' as const, detail: '' };
    expect(exitCodeFor([passed, { ...passed, status: 'fail' as const }, { ...passed, status: 'pending' as const }])).toBe(1);
  });

  it('writes an annotation per failure and per pending check, and a summary row per check', () => {
    const results = [
      { area: 'trello', check: 'api key', status: 'fail' as const, detail: '100% gone: key, token' },
      { area: 'jira', check: 'token service', status: 'pending' as const, detail: 'JIRA_OAUTH_CLIENT_ID | not set' },
      { area: 'jira', check: 'callback', status: 'ok' as const, detail: 'fine' },
    ];
    expect(annotationLines(results)).toEqual([
      '::error title=trello api key::100%25 gone: key, token',
      '::notice title=jira token service::JIRA_OAUTH_CLIENT_ID | not set',
    ]);
    const summary = summaryMarkdown(results, DOCS_BASE_URL);
    expect(summary).toContain('| fail | trello | api key | 100% gone: key, token |');
    expect(summary).toContain('| pending | jira | token service | JIRA\\_OAUTH\\_CLIENT\\_ID \\| not set |');
    expect(summary).toContain('| ok | jira | callback | fine |');
  });

  it('escapes what a workflow command reads in a title and in its data', () => {
    const results = [{ area: 'jira', check: 'call:back,x', status: 'fail' as const, detail: '50%\r\nnext' }];
    expect(annotationLines(results)).toEqual(['::error title=jira call%3Aback%2Cx::50%25%0D%0Anext']);
  });

  it('escapes the markdown a detail could use, and carries the header and the site', () => {
    const results = [{ area: 'jira', check: 'callback', status: 'fail' as const, detail: 'a<b>[c]`d*e\\f' }];
    const summary = summaryMarkdown(results, 'https://example.test');
    expect(summary).toContain('| fail | jira | callback | a\\<b\\>\\[c\\]\\`d\\*e\\\\f |');
    expect(summary).toContain('Site: https://example.test');
    expect(summary).toContain('| Status | Area | Check | Detail |');
  });

  it('lays the table out in fixed columns', () => {
    const results = [{ area: 'jira', check: 'callback', status: 'ok' as const, detail: 'fine' }];
    expect(tableLines(results)).toEqual([`ok${' '.repeat(6)}jira${' '.repeat(4)}callback${' '.repeat(8)}fine`]);
  });
});

describe('a source file that cannot be read', () => {
  it('is reported as unreadable, not as gone', () => {
    const root = checkoutWith((_file, text) => text);
    const target = path.join(root, SOURCE_FILES[0]);
    fs.rmSync(target, { force: true });
    fs.mkdirSync(target);
    let message = '';
    try {
      readShippedValues(root, {});
    } catch (problem) {
      message = problem instanceof Error ? problem.message : String(problem);
    }
    expect(message).toContain('could not be read (');
    expect(message).not.toContain('is gone');
  });
});

describe('sendRequest', () => {
  it('retries once after a network failure and returns the second answer', async () => {
    const second = answer(200, 'second');
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('first')).mockResolvedValueOnce(second);
    vi.stubGlobal('fetch', fetchMock);
    expect(await sendRequest('https://example.test/a')).toBe(second);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never retries an HTTP answer, even a 503', async () => {
    const down = answer(503);
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(down);
    vi.stubGlobal('fetch', fetchMock);
    expect(await sendRequest('https://example.test/a')).toBe(down);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws the second problem when both attempts fail', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error('first')).mockRejectedValueOnce(new Error('second'));
    vi.stubGlobal('fetch', fetchMock);
    await expect(sendRequest('https://example.test/a')).rejects.toThrow('second');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('keeps the caller init, never follows a redirect and sets a timeout', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(answer(200));
    vi.stubGlobal('fetch', fetchMock);
    await sendRequest('https://example.test/a', { method: 'POST', body: 'payload' });
    const init = fetchMock.mock.calls[0][1];
    expect(init).toMatchObject({ method: 'POST', body: 'payload', redirect: 'manual' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('main', () => {
  /** The four ids forced empty, so the run keeps passing after real ids ship. */
  function checkoutWithNothingShipped(): string {
    return checkoutWith((_file, text) =>
      text.replace(
        /^(export const (?:TRELLO_API_KEY|JIRA_OAUTH_CLIENT_ID|LINEAR_OAUTH_CLIENT_ID|GITLAB_COM_OAUTH_CLIENT_ID)(?:: [^=\n]+)? = )'[^']*';$/gm,
        "$1'';",
      ));
  }

  const siteAnswering = kangenticSite(() => errorAnswer(403, 'invalid_grant'));

  const ROW_PREFIXES = [
    ['pending', 'trello', 'api key'],
    ['pending', 'trello', 'allowed origin'],
    ['ok', 'trello', 'return page'],
    ['ok', 'jira', 'callback'],
    ['ok', 'jira', 'token service'],
    ['pending', 'linear', 'oauth client'],
    ['pending', 'gitlab', 'oauth client'],
  ].map(([status, area, check]) => `${status.padEnd(8)}${area.padEnd(8)}${check.padEnd(16)}`);

  function printedLines(): string[] {
    return vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
  }

  it('fails with one row, and sends nothing, when a source file is gone', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const send = vi.fn<SendRequest>();
    const root = checkoutWith((file, text) => (file === SOURCE_FILES[4] ? null : text));
    expect(await main({ repoRoot: root, env: {}, send })).toBe(1);
    const lines = printedLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^fail\s+desktop\s+shipped values\s+.*No probe ran\.$/);
    expect(lines[1]).toBe('\n1 check failed.');
    expect(send).not.toHaveBeenCalled();
  });

  it('writes the annotation and the summary only in GitHub Actions', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const root = checkoutWith((file, text) => (file === SOURCE_FILES[4] ? null : text));
    const summaryFile = path.join(tempDirectory(), 'summary.md');
    await main({ repoRoot: root, env: { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summaryFile }, send: vi.fn<SendRequest>() });
    expect(printedLines().some((line) => line.startsWith('::error title=desktop shipped values::'))).toBe(true);
    expect(fs.readFileSync(summaryFile, 'utf8')).toContain('Site: not read');
  });

  it('prints no command and writes no summary outside GitHub Actions', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const root = checkoutWith((file, text) => (file === SOURCE_FILES[4] ? null : text));
    const summaryFile = path.join(tempDirectory(), 'summary.md');
    await main({ repoRoot: root, env: { GITHUB_STEP_SUMMARY: summaryFile }, send: vi.fn<SendRequest>() });
    expect(printedLines().some((line) => line.startsWith('::'))).toBe(false);
    expect(fs.existsSync(summaryFile)).toBe(false);
  });

  it('returns 0 and prints a row per check in table order when every answer is good', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await main({ repoRoot: checkoutWithNothingShipped(), env: {}, send: siteAnswering })).toBe(0);
    const lines = printedLines();
    expect(lines).toHaveLength(ROW_PREFIXES.length + 1);
    ROW_PREFIXES.forEach((prefix, index) => expect(lines[index].startsWith(prefix)).toBe(true));
    expect(lines[ROW_PREFIXES.length]).toBe('\nNo check failed.');
  });

  it('returns 1 and counts the failure when one check breaks', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const breakingJira = kangenticSite(() => errorAnswer(502, ''));
    expect(await main({ repoRoot: checkoutWithNothingShipped(), env: {}, send: breakingJira })).toBe(1);
    expect(printedLines().at(-1)).toBe('\n1 check failed.');
  });

  it('runs when the file is run, and its return becomes the exit status', () => {
    const root = tempDirectory();
    for (const file of ['scripts/check-integrations.mjs', 'scripts/lib/is-entrypoint.mjs', 'scripts/lib/check-report.mjs']) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.copyFileSync(path.join(REPO_ROOT, file), path.join(root, file));
    }
    const env = { ...process.env };
    delete env.GITHUB_ACTIONS;
    delete env.GITHUB_STEP_SUMMARY;
    // No source file exists in the copy, so nothing is read and no request is sent.
    const run = spawnSync(process.execPath, [path.join(root, 'scripts/check-integrations.mjs')], { encoding: 'utf8', env, timeout: 30_000 });
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/desktop\s+shipped values/);
  });
});

describe('the workflow that runs it', () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, '.github/workflows/integrations.yml'), 'utf8').replace(/\r\n/g, '\n');

  /** The entries under the pull_request trigger's `paths:`, by a line scan. */
  function pullRequestPaths(): string[] {
    const lines = source.split('\n');
    const start = lines.findIndex((line) => /^ {2}pull_request:\s*$/.test(line));
    const header = lines.findIndex((line, index) => index > start && /^ {4}paths:\s*$/.test(line));
    const entries: string[] = [];
    for (const line of lines.slice(header + 1)) {
      const entry = /^ {6}- ['"]?([^'"\s]+)['"]?\s*$/.exec(line);
      if (!entry) break;
      entries.push(entry[1]);
    }
    return entries;
  }

  it('re-runs on a pull request that changes anything either check reads', () => {
    // The workflow runs this script and scripts/check-distribution.mjs, one job each.
    const everything = new Set([
      ...SOURCE_FILES,
      ...distribution.SOURCE_FILES,
      'scripts/check-integrations.mjs',
      'scripts/check-distribution.mjs',
      'scripts/lib/check-report.mjs',
      '.github/workflows/integrations.yml',
    ]);
    expect(pullRequestPaths().sort()).toEqual([...everything].sort());
  });

  it('runs each script in a job of its own, so one failing does not hide the other', () => {
    expect(source).toMatch(/^ {2}sign-ins:\n[\s\S]*?run: node scripts\/check-integrations\.mjs$/m);
    expect(source).toMatch(/^ {2}distribution:\n[\s\S]*?run: node scripts\/check-distribution\.mjs$/m);
  });

  it('runs daily and on demand, and holds no secret', () => {
    expect(source).toMatch(/^ {2}schedule:/m);
    expect(source).toMatch(/^ {2}workflow_dispatch:/m);
    expect(source).not.toContain('secrets.');
  });
});

interface RecordedAnswer {
  status: number;
  headers: Record<string, string>;
  body: string | null;
}

interface RecordedAnswers {
  returnPage: RecordedAnswer;
  returnPageBadState: RecordedAnswer;
  jiraCallbackBadState: RecordedAnswer;
  jiraCallbackNoCode: RecordedAnswer;
  jiraRefreshSecretsUnset: RecordedAnswer;
  trelloUnknownKey: RecordedAnswer;
  trelloApprovalUnknownKey: RecordedAnswer;
  linearUnknownClient: RecordedAnswer;
  gitlabUnknownClient: RecordedAnswer;
}

describe('the answers the live services gave', () => {
  const recorded = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, 'tests/fixtures/sign-in-check-live-answers.json'), 'utf8'),
  ) as RecordedAnswers;

  function replay(recordedAnswer: RecordedAnswer, headers: Record<string, string> = recordedAnswer.headers): Response {
    return new Response(recordedAnswer.body, { status: recordedAnswer.status, headers });
  }

  it('is read as ok for the return page, with its real policy and body', async () => {
    const send = returnPageAnswers(() => replay(recorded.returnPage), () => replay(recorded.returnPageBadState));
    expect(statusesOf(await checkTrelloPage(shipped, send))).toEqual(['ok']);
  });

  it('is read as ok for the Jira callback, with the Location filled from the state sent', async () => {
    const send: SendRequest = async (url) => {
      const state = new URL(url).searchParams.get('state') ?? '';
      if (state === 'bad') return replay(recorded.jiraCallbackBadState);
      const fields = decodeState(state);
      const location = (recorded.jiraCallbackNoCode.headers.location ?? '')
        .replace('{port}', String(fields.port))
        .replace('{nonce}', String(fields.nonce));
      return replay(recorded.jiraCallbackNoCode, { location });
    };
    expect(statusesOf(await checkJiraCallback(shipped, send))).toEqual(['ok']);
  });

  it('is pending before the Jira id ships and a failure after, when the secrets are unset', async () => {
    const send: SendRequest = async () => replay(recorded.jiraRefreshSecretsUnset);
    expect(statusesOf(await checkJiraService({ ...shipped, jiraClientId: NOT_SHIPPED }, send))).toEqual(['pending']);
    expect(statusesOf(await checkJiraService({ ...shipped, jiraClientId: SET }, send))).toEqual(['fail']);
  });

  it('fails a key Trello does not know, at the API and at the approval page', async () => {
    const send = trelloAnswers(() => replay(recorded.trelloUnknownKey), () => replay(recorded.trelloApprovalUnknownKey));
    const results = await checkTrelloKey({ ...shipped, trelloKey: SET }, send);
    expect(statusesOf(results)).toEqual(['fail', 'fail']);
    expect(results[0].detail).toContain('no longer knows the key');
    expect(results[1].detail).toContain('does not know the key');
  });

  it('fails a client Linear does not know', async () => {
    const results = await checkLinear({ ...shipped, linearClientId: SET }, async () => replay(recorded.linearUnknownClient));
    expect(statusesOf(results)).toEqual(['fail']);
    expect(results[0].detail).toContain('no longer knows the client');
  });

  it('fails a client gitlab.com does not know', async () => {
    const results = await checkGitLab({ ...shipped, gitlabClientId: SET }, async () => replay(recorded.gitlabUnknownClient));
    expect(statusesOf(results)).toEqual(['fail']);
    expect(results[0].detail).toContain('gitlab.com no longer knows the client');
  });
});

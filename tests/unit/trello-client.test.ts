/**
 * The Trello client's credential handling, refusals, downloads and card paging.
 *
 * The key and token must travel only in the OAuth header, and only to Trello: a regression puts a
 * never-expiring token in a URL or hands it to another host. A 401 must carry Trello's own text
 * ("invalid key", "invalid token") so the Connect dialog and the banner can show it, and must
 * clear a dead stored token. `fetch` is stubbed; `downloadFile` and the credential store are mocked.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrelloCredential } from '../../src/main/boards/adapters/trello/credential-store';

const downloadFileSpy = vi.hoisted(() =>
  vi.fn<(url: string, filename: string, options?: { headers?: Record<string, string> }) => Promise<unknown>>(),
);
const loadSpy = vi.hoisted(() => vi.fn<() => Promise<TrelloCredential | null>>(async () => null));
const saveSpy = vi.hoisted(() => vi.fn<(credential: TrelloCredential) => Promise<void>>(async () => {}));
const clearSpy = vi.hoisted(() => vi.fn<() => void>());

vi.mock('../../src/main/boards/adapters/trello/credential-store', () => ({
  loadTrelloCredential: loadSpy,
  saveTrelloCredential: saveSpy,
  clearTrelloCredential: clearSpy,
}));

vi.mock('../../src/main/boards/shared/download-file', async () => {
  const actual = await vi.importActual<typeof import('../../src/main/boards/shared/download-file')>(
    '../../src/main/boards/shared/download-file',
  );
  return { ...actual, downloadFile: downloadFileSpy };
});

const { TrelloClient, TrelloError, credentialFieldFromRefusal, isDeadCredentialRefusal } = await import('../../src/main/boards/adapters/trello/client');
const { isTrelloAuthedDownloadUrl, buildAuthorizeUrl, trelloAuthorizationHeader } = await import('../../src/main/boards/adapters/trello/constants');

const API_KEY = '3f9a0c2e71b84d55a6e0c1d9b7f24e18';
const TOKEN = 'ATTA0123456789abcdef0123456789abcdef0123456789abcdef0123456789ab';
const AUTH_HEADER = `OAuth oauth_consumer_key="${API_KEY}", oauth_token="${TOKEN}"`;

function credential(): TrelloCredential {
  return { kind: 'own-key', apiKey: API_KEY, token: TOKEN, savedAt: '2026-11-17T00:00:00.000Z' };
}

interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
}

function stubFetch(respond: (url: string, callIndex: number) => Response): RecordedRequest[] {
  const recorded: RecordedRequest[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    recorded.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
    return respond(url, recorded.length - 1);
  }));
  return recorded;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}

function plainText(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

/** A card id whose first 8 hex characters order it by creation time, as Trello's do. */
function cardId(index: number): string {
  return `6731f2a0${index.toString(16).padStart(16, '0')}`;
}

beforeEach(() => {
  loadSpy.mockReset();
  loadSpy.mockResolvedValue(null);
  saveSpy.mockReset();
  clearSpy.mockReset();
  downloadFileSpy.mockReset();
  downloadFileSpy.mockImplementation(async (url: string, filename: string) => ({
    filename, data: 'AAAA', mediaType: 'application/octet-stream', sizeBytes: 4, sourceUrl: url,
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('TrelloClient - credentials travel only in the OAuth header', () => {
  it('sends the key and token in the Authorization header and never in the URL', async () => {
    const requests = stubFetch(() => json([]));
    await new TrelloClient(credential()).listBoards();

    expect(requests).toHaveLength(1);
    expect(requests[0].headers.Authorization).toBe(AUTH_HEADER);
    expect(requests[0].url).not.toContain(API_KEY);
    expect(requests[0].url).not.toContain(TOKEN);
    expect(requests[0].url.startsWith('https://api.trello.com/1/members/me/boards?')).toBe(true);
  });

  it('checks a new key and token through the board list, with the header too', async () => {
    const requests = stubFetch(() => json([]));
    await expect(new TrelloClient().validate(API_KEY, TOKEN)).resolves.toBeUndefined();

    expect(requests[0].headers.Authorization).toBe(AUTH_HEADER);
    expect(requests[0].url).not.toContain(TOKEN);
    // Plain /members/me counts against Trello's separate /members limit; the board list does not.
    expect(requests[0].url.startsWith('https://api.trello.com/1/members/me/boards?')).toBe(true);
  });
});

describe('TrelloClient - Trello refusals', () => {
  it('passes Trello\'s text through and names the key when the key is refused', async () => {
    stubFetch(() => plainText(401, 'invalid key'));
    const failure = await new TrelloClient().validate('made-up', TOKEN).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TrelloError);
    expect((failure as InstanceType<typeof TrelloError>).message).toBe('invalid key');
    expect((failure as InstanceType<typeof TrelloError>).field).toBe('apiKey');
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it('clears a stored token Trello no longer accepts and passes "invalid token" to the banner', async () => {
    stubFetch(() => plainText(401, 'invalid token'));
    const client = new TrelloClient(credential());
    const failure = await client.listBoards().catch((error: unknown) => error);

    expect((failure as InstanceType<typeof TrelloError>).message).toBe('invalid token');
    expect((failure as InstanceType<typeof TrelloError>).field).toBe('token');
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(await client.hasCredential()).toBe(false);
  });

  it('keeps a working token when Trello refuses one board, and passes its text through', async () => {
    stubFetch(() => plainText(401, 'unauthorized permission requested'));
    const client = new TrelloClient(credential());
    const failure = await client.loadBoard('AbC123xy', true).catch((error: unknown) => error);

    expect((failure as InstanceType<typeof TrelloError>).message).toBe('unauthorized permission requested');
    expect(clearSpy).not.toHaveBeenCalled();
    expect(await client.hasCredential()).toBe(true);
  });

  it('reads only a dead token or key as a dead credential', () => {
    expect(isDeadCredentialRefusal('invalid token')).toBe(true);
    expect(isDeadCredentialRefusal('invalid key')).toBe(true);
    expect(isDeadCredentialRefusal('expired token')).toBe(true);
    expect(isDeadCredentialRefusal('unauthorized permission requested')).toBe(false);
    expect(isDeadCredentialRefusal('')).toBe(false);
  });

  it('retries a 429 and succeeds', async () => {
    const requests = stubFetch((_url, callIndex) => (callIndex === 0 ? plainText(429, 'rate limit') : json([])));
    await expect(new TrelloClient(credential()).listBoards()).resolves.toEqual([]);
    expect(requests).toHaveLength(2);
  });

  it('reads the refused half from Trello\'s text', () => {
    expect(credentialFieldFromRefusal('invalid key')).toBe('apiKey');
    expect(credentialFieldFromRefusal('invalid token')).toBe('token');
    expect(credentialFieldFromRefusal('unauthorized permission requested')).toBe('token');
  });
});

describe('TrelloClient - downloads get credentials only on Trello', () => {
  it('sends the header to Trello\'s attachment download address', async () => {
    await new TrelloClient(credential()).downloadFileAttachments([{
      url: 'https://trello.com/1/cards/6731f2a00000000000000101/attachments/6730f0000000000000000001/download/headers.txt',
      filename: 'headers.txt',
      sizeBytes: 1200,
    }]);
    const [, , options] = downloadFileSpy.mock.calls[0];
    expect(options?.headers?.Authorization).toBe(AUTH_HEADER);
  });

  it('sends no credentials with an image hosted anywhere else', async () => {
    await new TrelloClient(credential()).downloadInlineImages('![chart](https://images.example.com/chart.png)');
    const [, , options] = downloadFileSpy.mock.calls[0];
    expect(options?.headers).toBeUndefined();
  });

  it('matches only Trello download paths over https', () => {
    const path = '/1/cards/6731f2a00000000000000101/attachments/6730f0000000000000000001/download/a.png';
    expect(isTrelloAuthedDownloadUrl(`https://trello.com${path}`)).toBe(true);
    expect(isTrelloAuthedDownloadUrl(`https://api.trello.com${path}`)).toBe(true);
    expect(isTrelloAuthedDownloadUrl(`http://trello.com${path}`)).toBe(false);
    expect(isTrelloAuthedDownloadUrl(`https://trello.com.example.com${path}`)).toBe(false);
    expect(isTrelloAuthedDownloadUrl('https://trello.com/b/AbC123xy/sprint-board')).toBe(false);
    expect(isTrelloAuthedDownloadUrl('not a url')).toBe(false);
  });
});

describe('TrelloClient - loading a board', () => {
  it('asks for every list, archived ones included, and every card', async () => {
    const requests = stubFetch((url) => (url.includes('/lists?') ? json([{ id: 'l1', name: 'To Do', closed: false, pos: 1 }]) : json([])));
    await new TrelloClient(credential()).loadBoard('AbC123xy', true);

    expect(requests[0].url).toContain('/boards/AbC123xy/lists?filter=all');
    expect(requests[1].url).toContain('/boards/AbC123xy/cards/all?');
    expect(requests[1].url).toContain('checklists=all');
  });

  it('asks again before the oldest card when a page comes back full', async () => {
    const firstPage = Array.from({ length: 1000 }, (_unused, index) => ({ id: cardId(2000 - index) }));
    const secondPage = [{ id: cardId(5) }, { id: cardId(4) }];
    const requests = stubFetch((url) => {
      if (url.includes('/lists?')) return json([]);
      return json(url.includes('before=') ? secondPage : firstPage);
    });
    const snapshot = await new TrelloClient(credential()).loadBoard('AbC123xy', true);

    expect(snapshot.cards).toHaveLength(1002);
    expect(requests[2].url).toContain(`before=${cardId(1001)}`);
  });

  it('stops when a full page adds no new card, so an ignored cursor cannot loop', async () => {
    const fullPage = Array.from({ length: 1000 }, (_unused, index) => ({ id: cardId(index + 1) }));
    const requests = stubFetch((url) => (url.includes('/lists?') ? json([]) : json(fullPage)));
    const snapshot = await new TrelloClient(credential()).loadBoard('AbC123xy', true);

    expect(snapshot.cards).toHaveLength(1000);
    expect(requests).toHaveLength(3);
  });

  it('serves a loaded board from memory unless asked to refresh', async () => {
    const requests = stubFetch((url) => (url.includes('/lists?')
      ? json([{ id: 'l1', name: 'To Do', closed: false, pos: 1 }])
      : json([{ id: cardId(1) }])));
    const client = new TrelloClient(credential());
    await client.loadBoard('AbC123xy', true);
    const cached = await client.loadBoard('AbC123xy', false);
    expect(requests).toHaveLength(2);
    expect(cached.lists.map((list) => list.id)).toEqual(['l1']);
    expect(cached.cards.map((card) => card.id)).toEqual([cardId(1)]);
    await client.loadBoard('AbC123xy', true);
    expect(requests).toHaveLength(4);
  });
});

const TRELLO_DOWNLOAD_URL = 'https://trello.com/1/cards/6731f2a00000000000000101/attachments/6730f0000000000000000001/download/a.txt';

describe('TrelloClient - saving a credential', () => {
  it('stores the new credential and drops the board cache so the next load uses the new key', async () => {
    const requests = stubFetch(() => json([]));
    const client = new TrelloClient(credential());
    await client.loadBoard('AbC123xy', true);
    expect(requests).toHaveLength(2);

    const saved = await client.saveCredential('own-key', 'newkey123', 'newtoken456');
    expect(saveSpy).toHaveBeenCalledWith(saved);
    expect(saved).toMatchObject({ kind: 'own-key', apiKey: 'newkey123', token: 'newtoken456' });
    expect(Number.isNaN(Date.parse(saved.savedAt))).toBe(false);
    expect(new Date(saved.savedAt).toISOString()).toBe(saved.savedAt);

    await client.loadBoard('AbC123xy', false);
    expect(requests).toHaveLength(4);
    expect(requests[2].headers.Authorization).toBe(trelloAuthorizationHeader('newkey123', 'newtoken456'));
  });
});

describe('TrelloClient - retry policy', () => {
  it('retries a 503 and succeeds on the second request', async () => {
    const requests = stubFetch((_url, callIndex) => (callIndex === 0 ? plainText(503, 'unavailable') : json([])));
    await expect(new TrelloClient(credential()).listBoards()).resolves.toEqual([]);
    expect(requests).toHaveLength(2);
  });

  it('does not retry a 404, and names the path but not the query string', async () => {
    const requests = stubFetch(() => plainText(404, 'not found'));
    const failure = await new TrelloClient(credential()).listBoards().catch((error: unknown) => error);

    expect(requests).toHaveLength(1);
    expect(failure).toBeInstanceOf(TrelloError);
    expect((failure as InstanceType<typeof TrelloError>).status).toBe(404);
    const { message } = failure as Error;
    expect(message).toContain('/members/me/boards');
    expect(message).not.toContain('filter=');
  });
});

describe('TrelloClient - board name', () => {
  it('trims the name and serves it from memory on the second call', async () => {
    const requests = stubFetch(() => json({ name: ' Sprint ' }));
    const client = new TrelloClient(credential());
    expect(await client.getBoardName('AbC123xy')).toBe('Sprint');
    expect(await client.getBoardName('AbC123xy')).toBe('Sprint');
    expect(requests).toHaveLength(1);
  });

  it('returns null for an empty name and asks again next time', async () => {
    const requests = stubFetch(() => json({ name: '' }));
    const client = new TrelloClient(credential());
    expect(await client.getBoardName('AbC123xy')).toBeNull();
    expect(await client.getBoardName('AbC123xy')).toBeNull();
    expect(requests).toHaveLength(2);
  });
});

describe('TrelloClient - download edge cases', () => {
  it('counts a download that returns nothing as skipped', async () => {
    downloadFileSpy.mockResolvedValueOnce(null);
    const result = await new TrelloClient(credential()).downloadFileAttachments([
      { url: TRELLO_DOWNLOAD_URL, filename: 'a.txt', sizeBytes: 10 },
    ]);
    expect(result.skippedCount).toBe(1);
    expect(result.attachments).toEqual([]);
  });

  it('sends no headers to a Trello download address when no credential is stored', async () => {
    await new TrelloClient().downloadFileAttachments([
      { url: TRELLO_DOWNLOAD_URL, filename: 'a.txt', sizeBytes: 10 },
    ]);
    const [, , options] = downloadFileSpy.mock.calls[0];
    expect(options?.headers).toBeUndefined();
  });
});

describe('TrelloClient - validate failures', () => {
  it('throws a TrelloError with the status and no field for a 500', async () => {
    stubFetch(() => plainText(500, 'boom'));
    const failure = await new TrelloClient().validate(API_KEY, TOKEN).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TrelloError);
    expect((failure as InstanceType<typeof TrelloError>).status).toBe(500);
    expect((failure as InstanceType<typeof TrelloError>).field).toBeUndefined();
  });

  it('gives a fixed message and the token field for a 401 with no body', async () => {
    stubFetch(() => plainText(401, ''));
    const failure = await new TrelloClient().validate(API_KEY, TOKEN).catch((error: unknown) => error);
    expect((failure as Error).message).toBe('Trello refused the key or token.');
    expect((failure as InstanceType<typeof TrelloError>).field).toBe('token');
  });
});

describe('TrelloClient - not connected', () => {
  it('refuses with a Connect Trello message and never calls fetch', async () => {
    const requests = stubFetch(() => json([]));
    const failure = await new TrelloClient().listBoards().catch((error: unknown) => error);
    expect((failure as Error).name).toBe('RefusalError');
    expect((failure as Error).message).toContain('Connect Trello');
    expect(requests).toHaveLength(0);
  });
});

describe('TrelloClient - a dead credential', () => {
  it('drops the credential and both caches, so the next load says not connected without a request', async () => {
    const requests = stubFetch((url) => {
      if (url.includes('/members/me/boards')) return plainText(401, 'invalid token');
      return url.includes('/lists?') || url.includes('/cards/all') ? json([]) : json({ name: 'Sprint' });
    });
    const client = new TrelloClient(credential());
    await client.loadBoard('AbC123xy', true);
    await client.getBoardName('AbC123xy');
    const before = requests.length;

    await expect(client.listBoards()).rejects.toMatchObject({ message: 'invalid token' });
    expect(requests).toHaveLength(before + 1);

    const failure = await client.loadBoard('AbC123xy', false).catch((error: unknown) => error);
    expect((failure as Error).name).toBe('RefusalError');
    expect(requests).toHaveLength(before + 1);
  });

  it('still rejects with Trello\'s text when deleting the stored file fails', async () => {
    clearSpy.mockImplementation(() => {
      throw Object.assign(new Error('EPERM'), { code: 'EPERM' });
    });
    stubFetch(() => plainText(401, 'invalid token'));
    const client = new TrelloClient(credential());
    const failure = await client.listBoards().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(TrelloError);
    expect((failure as Error).message).toBe('invalid token');
    expect(await client.hasCredential()).toBe(false);
  });
});

describe('trelloAuthorizationHeader', () => {
  it('percent-encodes values so a quote or comma cannot add a parameter', () => {
    expect(trelloAuthorizationHeader('a"b,c', 'tok en'))
      .toBe('OAuth oauth_consumer_key="a%22b%2Cc", oauth_token="tok%20en"');
  });
});

describe('buildAuthorizeUrl', () => {
  it('asks Trello for a read-only token that never expires, shown on the page', () => {
    const url = new URL(buildAuthorizeUrl(API_KEY));
    expect(url.origin + url.pathname).toBe('https://trello.com/1/authorize');
    expect(url.searchParams.get('scope')).toBe('read');
    expect(url.searchParams.get('expiration')).toBe('never');
    expect(url.searchParams.get('response_type')).toBe('token');
    expect(url.searchParams.has('return_url')).toBe(false);
  });
});

describe('TrelloClient.listBoards - mapping and query', () => {
  it('maps each board, dropping one with no short link and filling the gaps', async () => {
    const requests = stubFetch(() => json([
      { id: 'b1', name: 'Sprint', shortLink: 'AbC123xy', url: 'https://trello.com/b/AbC123xy/sprint', organization: { id: 'o1', displayName: 'Acme' } },
      { id: 'b2', name: 'No link', shortLink: '', url: 'https://trello.com/b/none' },
      { id: 'b3', shortLink: 'Zz9Yy8xW' },
      { id: 'b4', name: '  Padded  ', shortLink: 'Pad00001', url: 'https://trello.com/b/Pad00001/padded' },
    ]));
    const boards = await new TrelloClient(credential()).listBoards();

    expect(boards).toEqual([
      { id: 'b1', shortLink: 'AbC123xy', name: 'Sprint', url: 'https://trello.com/b/AbC123xy/sprint', workspaceName: 'Acme' },
      { id: 'b3', shortLink: 'Zz9Yy8xW', name: 'Zz9Yy8xW', url: 'https://trello.com/b/Zz9Yy8xW', workspaceName: null },
      { id: 'b4', shortLink: 'Pad00001', name: 'Padded', url: 'https://trello.com/b/Pad00001/padded', workspaceName: null },
    ]);

    const query = new URL(requests[0].url).searchParams;
    expect(query.get('fields')).toBe('name,shortLink,url,idOrganization');
    expect(query.get('organization')).toBe('true');
    expect(query.get('organization_fields')).toBe('displayName');
    expect(query.get('filter')).toBe('open');
  });
});

describe('TrelloClient.loadBoard - request queries', () => {
  it('asks for the card fields, attachments, members and checklists, and the list fields', async () => {
    const requests = stubFetch((url) => (url.includes('/lists?') ? json([]) : json([])));
    await new TrelloClient(credential()).loadBoard('AbC123xy', true);

    const cardsRequest = requests.find((request) => request.url.includes('/cards/all?'))!;
    const cardQuery = new URL(cardsRequest.url).searchParams;
    const cardFields = (cardQuery.get('fields') ?? '').split(',');
    for (const field of ['idShort', 'shortUrl', 'closed', 'idList', 'dateLastActivity']) {
      expect(cardFields).toContain(field);
    }
    expect(cardQuery.get('attachments')).toBe('true');
    expect(cardQuery.get('attachment_fields')).toBe('name,url,bytes,isUpload');
    expect(cardQuery.get('members')).toBe('true');
    expect(cardQuery.get('member_fields')).toBe('fullName,username');
    expect(cardQuery.get('limit')).toBe('1000');
    expect(cardQuery.get('checklists')).toBe('all');

    const listsRequest = requests.find((request) => request.url.includes('/lists?'))!;
    const listQuery = new URL(listsRequest.url).searchParams;
    expect(listQuery.get('fields')).toBe('name,closed,pos');
    expect(listQuery.get('filter')).toBe('all');
  });

  it('URL-encodes the board reference in the request paths', async () => {
    const requests = stubFetch((url) => (url.includes('/lists?') || url.includes('/cards/all?') ? json([]) : json({ name: 'X' })));
    const client = new TrelloClient(credential());
    await client.loadBoard('a b/c', true);
    await client.getBoardName('a b/c');

    expect(requests.find((request) => request.url.includes('/lists?'))!.url).toContain('/boards/a%20b%2Fc/lists?');
    expect(requests.find((request) => request.url.includes('/cards/all?'))!.url).toContain('/boards/a%20b%2Fc/cards/all?');
    const nameRequest = requests.find((request) => request.url.includes('/boards/a%20b%2Fc?'))!;
    expect(new URL(nameRequest.url).searchParams.get('fields')).toBe('name');
  });
});

describe('TrelloClient - an answer that is not what was asked for', () => {
  it('rejects a non-array board list with a TrelloError, not a TypeError', async () => {
    stubFetch(() => json({}));
    const failure = await new TrelloClient(credential()).listBoards().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TrelloError);
    expect((failure as Error).message).toContain('did not return a list');
  });

  it('rejects a non-array card page with a TrelloError', async () => {
    stubFetch((url) => (url.includes('/lists?') ? json([]) : json({})));
    const failure = await new TrelloClient(credential()).loadBoard('AbC123xy', true).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TrelloError);
    expect((failure as Error).message).toContain('did not return a list');
  });

  it('rejects a 200 whose body is not JSON with a TrelloError', async () => {
    stubFetch(() => plainText(200, 'hello'));
    const failure = await new TrelloClient(credential()).listBoards().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TrelloError);
    expect((failure as Error).message).toContain('not JSON');
  });
});

describe('TrelloClient - retry boundaries', () => {
  it('does not retry a network failure', async () => {
    const networkFailure = new TypeError('fetch failed');
    const fetchSpy = vi.fn(async () => {
      throw networkFailure;
    });
    vi.stubGlobal('fetch', fetchSpy);
    const failure = await new TrelloClient(credential()).listBoards().catch((error: unknown) => error);

    expect(failure).toBe(networkFailure);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('stops after three requests on a persistent 500', async () => {
    const requests = stubFetch(() => plainText(500, 'boom'));
    const failure = await new TrelloClient(credential()).listBoards().catch((error: unknown) => error);

    expect(requests).toHaveLength(3);
    expect(failure).toBeInstanceOf(TrelloError);
    expect((failure as InstanceType<typeof TrelloError>).status).toBe(500);
  });
});

describe('TrelloClient - a 401 on a stored credential', () => {
  it('clears the credential and names the key when Trello says invalid key', async () => {
    stubFetch(() => plainText(401, 'invalid key'));
    const client = new TrelloClient(credential());
    const failure = await client.listBoards().catch((error: unknown) => error);

    expect((failure as Error).message).toBe('invalid key');
    expect((failure as InstanceType<typeof TrelloError>).field).toBe('apiKey');
    expect(clearSpy).toHaveBeenCalledTimes(1);
    expect(await client.hasCredential()).toBe(false);
  });

  it('keeps the credential and uses a fixed message when the 401 has no body', async () => {
    stubFetch(() => plainText(401, ''));
    const client = new TrelloClient(credential());
    const failure = await client.listBoards().catch((error: unknown) => error);

    expect((failure as Error).message).toBe('Trello refused the stored token.');
    expect(clearSpy).not.toHaveBeenCalled();
    expect(await client.hasCredential()).toBe(true);
  });
});

describe('isTrelloAuthedDownloadUrl - addresses that get no credentials', () => {
  it('refuses API paths that are not an attachment download, and a non-default port', () => {
    expect(isTrelloAuthedDownloadUrl('https://api.trello.com/1/members/me')).toBe(false);
    expect(isTrelloAuthedDownloadUrl('https://api.trello.com/1/boards/AbC123xy')).toBe(false);
    expect(isTrelloAuthedDownloadUrl(
      'https://trello.com:8443/1/cards/6731f2a00000000000000101/attachments/6730f0000000000000000001/download/a.png',
    )).toBe(false);
  });
});

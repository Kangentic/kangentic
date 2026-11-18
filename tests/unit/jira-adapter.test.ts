/**
 * The Jira adapter over a stubbed fetch: sign-in headers per method, the scoped
 * token gateway fallback, the Connect error codes, Cloud's cursor paging against
 * Data Center's offset paging, board columns as status, the source checks behind
 * the popover's error lines, and the issue mapping. Response bodies are shaped
 * from Atlassian's published REST examples (Cloud platform v3, Data Center v2,
 * Software agile 1.0); the owner has no Jira instance to record from.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { JiraSiteCredential } from '../../src/main/boards/adapters/jira/credential-store';

vi.mock('electron', () => ({ app: { isReady: () => true }, safeStorage: {}, ipcMain: { handle: vi.fn() } }));

const downloadFileSpy = vi.hoisted(() =>
  vi.fn<(url: string, filename: string, options?: { headers?: Record<string, string> }) => Promise<unknown>>(),
);

vi.mock('../../src/main/boards/shared/download-file', async () => {
  const actual = await vi.importActual<typeof import('../../src/main/boards/shared/download-file')>(
    '../../src/main/boards/shared/download-file',
  );
  return { ...actual, downloadFile: downloadFileSpy };
});

// Whether this build offers Sign in with Atlassian. The real answer follows the
// build's OAuth client id, so a test that pins the auth status sets it here.
const signInOffer = vi.hoisted(() => ({ available: false }));

vi.mock('../../src/main/boards/adapters/jira/constants', async () => {
  const actual = await vi.importActual<typeof import('../../src/main/boards/adapters/jira/constants')>(
    '../../src/main/boards/adapters/jira/constants',
  );
  return { ...actual, isJiraSignInAvailable: () => signInOffer.available };
});

// A browser sign-in's renewal saves the rotated pair here, not to the real keychain file.
const storedCredentials = vi.hoisted(() => ({ sites: {} as Record<string, JiraSiteCredential> }));
vi.mock('../../src/main/boards/adapters/jira/credential-store', () => ({
  loadJiraCredentials: async () => ({ ...storedCredentials.sites }),
  saveJiraCredential: async (saved: JiraSiteCredential) => {
    storedCredentials.sites[saved.site] = saved;
  },
}));

import { JiraAdapter } from '../../src/main/boards/adapters/jira/adapter';
import { JiraClient, JiraHttpError } from '../../src/main/boards/adapters/jira/client';
import { RefusalError, SIGN_IN_REFUSED_ERROR_NAME, SignInRefusedError } from '../../src/shared/refusal';
import { connectJiraSite } from '../../src/main/boards/adapters/jira/ipc-handlers';
import { mapJiraIssues, type JiraIssueRaw } from '../../src/main/boards/adapters/jira/mapper';
import { priorityIndexForName } from '../../src/shared/priority-scale';
import { DEFAULT_PRIORITY_CONFIG } from '../../src/shared/types';

const CLOUD = 'https://acme.atlassian.net';
const DATA_CENTER = 'https://jira.example.com';

interface StubResponse { status?: number; body?: unknown; headers?: Record<string, string> }
type Route = (url: URL, init: RequestInit | undefined) => StubResponse | undefined;

/** A fetch that answers from routes and records every call. */
function stubFetch(route: Route) {
  const calls: Array<{ url: URL; authorization: string | undefined }> = [];
  const fetchImpl = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, authorization: headers.Authorization });
    const answer = route(url, init) ?? { status: 404, body: { errorMessages: ['not routed'] } };
    const status = answer.status ?? 200;
    const text = typeof answer.body === 'string' ? answer.body : JSON.stringify(answer.body ?? {});
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name: string) => answer.headers?.[name.toLowerCase()] ?? null },
      json: async () => JSON.parse(text),
      text: async () => text,
    } as unknown as Response;
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function credential(overrides: Partial<JiraSiteCredential> = {}): JiraSiteCredential {
  return {
    site: CLOUD,
    deployment: 'cloud',
    method: 'api-token',
    email: 'dev@example.com',
    secret: 'token-value',
    account: 'dev@example.com',
    savedAt: '2026-11-17T00:00:00.000Z',
    ...overrides,
  };
}

const ISSUE: JiraIssueRaw = {
  id: '10001',
  key: 'ENG-142',
  fields: {
    summary: 'Retry webhook delivery when the endpoint times out',
    status: { id: '10002', name: 'Code Review', statusCategory: { key: 'indeterminate' } },
    issuetype: { name: 'Bug' },
    priority: { name: 'High' },
    labels: ['backend', 'webhooks'],
    assignee: { displayName: 'Dana Park' },
    duedate: '2026-12-01',
    created: '2026-11-10T09:30:00.000+0000',
    updated: '2026-11-12T15:07:00.000-0500',
    attachment: [
      { id: '20001', filename: 'trace.log', size: 2048, content: `${CLOUD}/rest/api/3/attachment/content/20001` },
      { id: '20002', filename: 'shot.png', size: 4096, content: `${CLOUD}/rest/api/3/attachment/content/20002` },
    ],
  },
  renderedFields: {
    description: '<p>Deliveries fail after <b>10 seconds</b>.</p><p><img src="/rest/api/3/attachment/content/20002" alt="shot.png"></p>',
  },
};

describe('mapJiraIssues', () => {
  it('maps an issue: key as display id, rendered description as Markdown, board column as state', () => {
    const [issue] = mapJiraIssues([ISSUE], {
      site: CLOUD,
      boardColumns: [
        { name: 'To Do', statusIds: ['10000'] },
        { name: 'In Review', statusIds: ['10002', '10003'] },
      ],
      alreadyImported: new Set(),
    });
    expect(issue).toMatchObject({
      externalId: '10001',
      displayId: 'ENG-142',
      externalUrl: `${CLOUD}/browse/ENG-142`,
      title: 'Retry webhook delivery when the endpoint times out',
      labels: ['backend', 'webhooks'],
      assignee: 'Dana Park',
      state: 'In Review',
      stateOrder: 1,
      stateCategory: 'open',
      workItemType: 'Bug',
      priority: 'High',
      dueDate: '2026-12-01',
      createdAt: '2026-11-10T09:30:00.000Z',
      updatedAt: '2026-11-12T20:07:00.000Z',
      attachmentCount: 2,
    });
    expect(issue.body).toContain('**10 seconds**');
    // The inline image's site-relative URL is made absolute so it can download.
    expect(issue.body).toContain(`![shot.png](${CLOUD}/rest/api/3/attachment/content/20002)`);
    // The inline image is not downloaded a second time as a file attachment.
    expect(issue.fileAttachments?.map((attachment) => attachment.externalRef)).toEqual(['20001']);
  });

  it('shows the Jira status without board columns, and done as closed', () => {
    const done: JiraIssueRaw = { ...ISSUE, fields: { ...ISSUE.fields, status: { id: '1', name: 'Done', statusCategory: { key: 'done' } } } };
    const [issue] = mapJiraIssues([done], { site: CLOUD, alreadyImported: new Set(['10001']) });
    expect(issue).toMatchObject({ state: 'Done', stateCategory: 'closed', alreadyImported: true });
    expect(issue.stateOrder).toBeUndefined();
  });
});

describe('priorityIndexForName with Jira priority names', () => {
  it('matches by name, maps Highest and Lowest, and gives None otherwise', () => {
    expect(priorityIndexForName('High', DEFAULT_PRIORITY_CONFIG)).toBe(3);
    expect(priorityIndexForName('medium', DEFAULT_PRIORITY_CONFIG)).toBe(2);
    expect(priorityIndexForName('Highest', DEFAULT_PRIORITY_CONFIG)).toBe(4);
    expect(priorityIndexForName('Lowest', DEFAULT_PRIORITY_CONFIG)).toBe(1);
    expect(priorityIndexForName('Blocker', DEFAULT_PRIORITY_CONFIG)).toBe(0);
    expect(priorityIndexForName(undefined, DEFAULT_PRIORITY_CONFIG)).toBe(0);
  });
});

describe('JiraClient sign-in header', () => {
  it('sends Basic email:token for a Cloud token, Bearer for a Data Center token, Basic user:pass for a password', () => {
    const basic = (pair: string) => `Basic ${Buffer.from(pair).toString('base64')}`;
    expect(new JiraClient(credential()).authorizationHeader()).toBe(basic('dev@example.com:token-value'));
    expect(new JiraClient(credential({ site: DATA_CENTER, deployment: 'datacenter', method: 'pat' })).authorizationHeader())
      .toBe('Bearer token-value');
    expect(new JiraClient(credential({ deployment: 'datacenter', method: 'password', username: 'dpark' })).authorizationHeader())
      .toBe(basic('dpark:token-value'));
  });
});

describe('connectJiraSite', () => {
  const serverInfo = (deploymentType: string): StubResponse => ({ body: { deploymentType } });

  it('saves a Cloud token that /myself accepts, with the account Jira reports', async () => {
    const save = vi.fn(async () => {});
    const { fetchImpl } = stubFetch((url) => {
      if (url.pathname.endsWith('/serverInfo')) return serverInfo('Cloud');
      if (url.pathname === '/rest/api/3/myself') return { body: { emailAddress: 'dana@acme.example', timeZone: 'UTC' } };
      return undefined;
    });
    const result = await connectJiraSite({ site: 'acme.atlassian.net', method: 'api-token', email: 'dana@acme.example', secret: 'token' }, fetchImpl, save);
    expect(result).toEqual({ ok: true, site: 'acme.atlassian.net', account: 'dana@acme.example' });
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ site: CLOUD, deployment: 'cloud', method: 'api-token' }));
  });

  it('retries a scoped Cloud token through the gateway and saves it as a gateway sign-in', async () => {
    const save = vi.fn(async () => {});
    const { fetchImpl, calls } = stubFetch((url) => {
      if (url.pathname.endsWith('/serverInfo')) return serverInfo('Cloud');
      if (url.pathname === '/_edge/tenant_info') return { body: { cloudId: 'cloud-123' } };
      if (url.host === 'acme.atlassian.net' && url.pathname === '/rest/api/3/myself') return { status: 401, body: {} };
      if (url.host === 'api.atlassian.com' && url.pathname === '/ex/jira/cloud-123/rest/api/3/myself') {
        return { body: { emailAddress: 'dana@acme.example' } };
      }
      return undefined;
    });
    const result = await connectJiraSite({ site: CLOUD, method: 'api-token', email: 'dana@acme.example', secret: 'scoped' }, fetchImpl, save);
    expect(result.ok).toBe(true);
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ viaGateway: true, cloudId: 'cloud-123' }));
    expect(calls.some((call) => call.url.host === 'api.atlassian.com')).toBe(true);
  });

  it('reports rejected, captcha and unreachable as codes, and saves nothing', async () => {
    const save = vi.fn(async () => {});
    const rejected = stubFetch((url) => (url.pathname.endsWith('/serverInfo') ? serverInfo('Server') : { status: 401, body: {} }));
    expect(await connectJiraSite({ site: DATA_CENTER, method: 'pat', secret: 'bad' }, rejected.fetchImpl, save))
      .toEqual({ ok: false, code: 'rejected', site: 'jira.example.com' });

    const captcha = stubFetch((url) => (url.pathname.endsWith('/serverInfo')
      ? serverInfo('Server')
      : { status: 403, body: {}, headers: { 'x-seraph-loginreason': 'AUTHENTICATION_DENIED' } }));
    expect(await connectJiraSite({ site: DATA_CENTER, method: 'password', username: 'dpark', secret: 'pw' }, captcha.fetchImpl, save))
      .toEqual({ ok: false, code: 'captcha', site: 'jira.example.com' });

    const unreachable = (async () => {
      throw Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    }) as unknown as typeof fetch;
    expect(await connectJiraSite({ site: 'jira.example.cmo', method: 'pat', secret: 'token' }, unreachable, save))
      .toEqual({ ok: false, code: 'unreachable', site: 'jira.example.cmo', detail: 'ENOTFOUND' });

    expect(await connectJiraSite({ site: CLOUD, method: 'api-token', email: '', secret: 'token' }, unreachable, save))
      .toEqual({ ok: false, code: 'invalid' });
    expect(save).not.toHaveBeenCalled();
  });
});

function adapterWith(credentials: Record<string, JiraSiteCredential>, route: Route) {
  const stub = stubFetch(route);
  return { adapter: new JiraAdapter({ loadCredentials: async () => credentials, fetchImpl: stub.fetchImpl }), ...stub };
}

const findNone = () => new Set<string>();

describe('JiraAdapter.fetch', () => {
  it('pages a Cloud query by cursor, remembering each next page token', async () => {
    const { adapter, calls } = adapterWith({ [CLOUD]: credential() }, (url) => {
      if (url.pathname !== '/rest/api/3/search/jql') return undefined;
      return url.searchParams.get('nextPageToken') === 'page-2'
        ? { body: { issues: [{ ...ISSUE, id: '10002', key: 'ENG-143' }], isLast: true } }
        : { body: { issues: [ISSUE], nextPageToken: 'page-2', isLast: false } };
    });
    const repository = `${CLOUD}::project::ENG`;
    const first = await adapter.fetch({ source: 'jira', repository, page: 1, perPage: 100, state: 'all' }, findNone);
    expect(first.hasNextPage).toBe(true);
    const second = await adapter.fetch({ source: 'jira', repository, page: 2, perPage: 100, state: 'all' }, findNone);
    expect(second.hasNextPage).toBe(false);
    expect(second.issues[0].displayId).toBe('ENG-143');
    expect(calls[0].url.searchParams.get('jql')).toBe('project = "ENG" ORDER BY updated DESC');
    expect(calls[0].url.searchParams.get('expand')).toBe('renderedFields');
  });

  it('pages a Data Center query from where the last page ended, when Jira caps a page short', async () => {
    const dc = credential({ site: DATA_CENTER, deployment: 'datacenter', method: 'pat' });
    const { adapter, calls } = adapterWith({ [DATA_CENTER]: dc }, (url) => {
      if (url.pathname !== '/rest/api/2/search') return undefined;
      const startAt = Number(url.searchParams.get('startAt'));
      // The site returns at most 50 issues a page, whatever maxResults asks for.
      const count = Math.min(50, 101 - startAt);
      const issues = Array.from({ length: count }, (_, index) => ({ ...ISSUE, id: String(startAt + index) }));
      return { body: { issues, startAt, total: 101 } };
    });
    const repository = `${DATA_CENTER}::jql::assignee = currentUser()`;
    const ids: string[] = [];
    let hasNextPage = true;
    for (let page = 1; hasNextPage; page++) {
      const result = await adapter.fetch({ source: 'jira', repository, page, perPage: 100 }, findNone);
      ids.push(...result.issues.map((issue) => issue.externalId));
      hasNextPage = result.hasNextPage;
    }
    expect(calls.map((call) => call.url.searchParams.get('startAt'))).toEqual(['0', '50', '100']);
    expect(new Set(ids).size).toBe(101);
  });

  it('refuses a page asked for before the page ahead of it', async () => {
    const dc = credential({ site: DATA_CENTER, deployment: 'datacenter', method: 'pat' });
    const { adapter, calls } = adapterWith({ [DATA_CENTER]: dc }, () => ({ body: { issues: [ISSUE], startAt: 0, total: 101 } }));
    await expect(adapter.fetch({ source: 'jira', repository: `${DATA_CENTER}::jql::project = ENG`, page: 2, perPage: 100 }, findNone))
      .rejects.toThrow('Jira page 2 was asked for before page 1.');
    expect(calls).toHaveLength(0);
  });

  it('shows a board source in its column names and narrows an incremental fetch in the user time zone', async () => {
    const { adapter, calls } = adapterWith({ [CLOUD]: credential() }, (url) => {
      if (url.pathname === '/rest/api/3/myself') return { body: { timeZone: 'America/New_York' } };
      if (url.pathname === '/rest/agile/1.0/board/12/configuration') {
        return { body: { columnConfig: { columns: [{ name: 'To Do', statuses: [{ id: '10000' }] }, { name: 'In Review', statuses: [{ id: '10002' }] }] } } };
      }
      if (url.pathname === '/rest/agile/1.0/board/12/issue') return { body: { issues: [ISSUE], startAt: 0, total: 1 } };
      return undefined;
    });
    const result = await adapter.fetch(
      { source: 'jira', repository: `${CLOUD}::board::12`, page: 1, perPage: 100, since: '2026-11-12T15:07:00.000Z' },
      findNone,
    );
    expect(result.issues[0]).toMatchObject({ state: 'In Review', stateOrder: 1 });
    const issueCall = calls.find((call) => call.url.pathname.endsWith('/board/12/issue'));
    expect(issueCall?.url.searchParams.get('jql')).toBe('updated >= "2026/11/12 10:02"');
  });

  it('turns a refused saved token into the line the Import dialog shows', async () => {
    const { adapter } = adapterWith({ [CLOUD]: credential() }, () => ({ status: 401, body: {} }));
    await expect(adapter.fetch({ source: 'jira', repository: `${CLOUD}::project::ENG`, page: 1, perPage: 100 }, findNone))
      .rejects.toThrow('Jira rejected the saved token.');
  });
});

describe('JiraAdapter.prepareSource', () => {
  it('names a board and completes typed JQL with the one connected site', async () => {
    const { adapter } = adapterWith({ [CLOUD]: credential() }, (url) => {
      if (url.pathname === '/rest/agile/1.0/board/12') return { body: { id: 12, name: 'ENG board' } };
      if (url.pathname === '/rest/api/3/search/jql') return { body: { issues: [], isLast: true } };
      return undefined;
    });
    expect(await adapter.prepareSource(`${CLOUD}::board::12`)).toEqual({ label: 'ENG board', repository: `${CLOUD}::board::12` });
    expect(await adapter.prepareSource('::jql::project = ENG')).toEqual({ label: 'project = ENG', repository: `${CLOUD}::jql::project = ENG` });
  });

  it('raises each popover line', async () => {
    const cases: Array<{ repository: string; status: number; body?: unknown; gateway?: boolean; line: string }> = [
      { repository: `${CLOUD}::board::12`, status: 404, line: 'No board 12 that this account can open.' },
      { repository: `${CLOUD}::filter::10021`, status: 400, line: 'No filter 10021 that this account can open.' },
      { repository: `${CLOUD}::board::12`, status: 403, line: 'This account has no Jira Software access.' },
      { repository: `${CLOUD}::board::12`, status: 401, gateway: true, line: "This token's scopes can't read boards." },
      {
        repository: `${CLOUD}::jql::ORDER BY created`,
        status: 400,
        body: { errorMessages: ['Unbounded JQL queries are not allowed here. Please add a search restriction to your query.'] },
        line: "Jira won't run JQL with no search condition.",
      },
    ];
    for (const testCase of cases) {
      const saved = testCase.gateway ? credential({ viaGateway: true, cloudId: 'cloud-123' }) : credential();
      const { adapter } = adapterWith({ [CLOUD]: saved }, () => ({ status: testCase.status, body: testCase.body ?? {} }));
      await expect(adapter.prepareSource(testCase.repository)).rejects.toThrow(testCase.line);
    }
  });

  // Add Source acts on the class, not the line: a refused sign-in reopens Connect, and a refusal
  // about the source itself (no such board) must not.
  it('marks a 401 as the saved sign-in being refused, and no other refusal', async () => {
    const refusedPlain = adapterWith({ [CLOUD]: credential() }, () => ({ status: 401, body: {} }));
    const plainError = await refusedPlain.adapter.prepareSource(`${CLOUD}::board::12`).then(() => null, (error: unknown) => error);
    expect(plainError).toBeInstanceOf(SignInRefusedError);
    expect((plainError as Error).name).toBe(SIGN_IN_REFUSED_ERROR_NAME);
    expect((plainError as Error).message).toBe('Jira rejected the saved token.');

    const refusedScoped = adapterWith({ [CLOUD]: credential({ viaGateway: true, cloudId: 'cloud-123' }) }, () => ({ status: 401, body: {} }));
    await expect(refusedScoped.adapter.prepareSource(`${CLOUD}::board::12`)).rejects.toBeInstanceOf(SignInRefusedError);

    const noSuchBoard = adapterWith({ [CLOUD]: credential() }, () => ({ status: 404, body: {} }));
    const sourceError = await noSuchBoard.adapter.prepareSource(`${CLOUD}::board::12`).then(() => null, (error: unknown) => error);
    expect(sourceError).toBeInstanceOf(RefusalError);
    expect(sourceError).not.toBeInstanceOf(SignInRefusedError);
  });

  it('asks for a link when typed JQL could run on two connected sites', async () => {
    const { adapter } = adapterWith({ [CLOUD]: credential(), [DATA_CENTER]: credential({ site: DATA_CENTER }) }, () => undefined);
    await expect(adapter.prepareSource('::jql::project = ENG')).rejects.toThrow('Paste a search link so the site is known.');
    expect(await adapter.getAuthStatus('project = ENG')).toEqual({ connected: false, reason: 'ambiguous-site', signInAvailable: false });
  });
});

describe('JiraAdapter.getAuthStatus', () => {
  it('answers per site, with a prefill that never carries the secret', async () => {
    const { adapter } = adapterWith({ [CLOUD]: credential() }, () => undefined);
    const connected = await adapter.getAuthStatus(`${CLOUD}/jira/software/projects/ENG/boards/12`);
    expect(connected).toMatchObject({ connected: true, account: 'dev@example.com', prefill: { site: 'acme.atlassian.net', method: 'api-token', email: 'dev@example.com' } });
    expect(JSON.stringify(connected)).not.toContain('token-value');
    expect(await adapter.getAuthStatus(`${DATA_CENTER}/browse/ENG`)).toMatchObject({ connected: false, reason: 'none', prefill: { site: 'jira.example.com' } });
  });
});

describe('JiraAdapter.listExternalIds', () => {
  it('lists every id of a Cloud query across cursor pages', async () => {
    const { adapter } = adapterWith({ [CLOUD]: credential() }, (url) => (url.searchParams.get('nextPageToken')
      ? { body: { issues: [{ id: '2' }], isLast: true } }
      : { body: { issues: [{ id: '1' }], nextPageToken: 'next', isLast: false } }));
    expect(await adapter.listExternalIds({ source: 'jira', repository: `${CLOUD}::jql::project = ENG` })).toEqual(['1', '2']);
  });

  it('lists every id of a board when the agile API caps each page at 50 whatever maxResults asks', async () => {
    const { adapter, calls } = adapterWith({ [CLOUD]: credential() }, (url) => {
      if (url.pathname !== '/rest/agile/1.0/board/12/issue') return undefined;
      return cappedOffsetPage(Number(url.searchParams.get('startAt')), 120);
    });
    const ids = await adapter.listExternalIds({ source: 'jira', repository: `${CLOUD}::board::12` });
    expect(calls.map((call) => call.url.searchParams.get('startAt'))).toEqual(['0', '50', '100']);
    expect(ids).toHaveLength(120);
    expect(new Set(ids).size).toBe(120);
  });

  it('lists every id of a Data Center JQL source when the search caps each page at 50', async () => {
    const dc = credential({ site: DATA_CENTER, deployment: 'datacenter', method: 'pat' });
    const { adapter, calls } = adapterWith({ [DATA_CENTER]: dc }, (url) => {
      if (url.pathname !== '/rest/api/2/search') return undefined;
      return cappedOffsetPage(Number(url.searchParams.get('startAt')), 120);
    });
    const ids = await adapter.listExternalIds({ source: 'jira', repository: `${DATA_CENTER}::jql::project = ENG` });
    expect(calls.map((call) => call.url.searchParams.get('startAt'))).toEqual(['0', '50', '100']);
    expect(ids).toHaveLength(120);
    expect(new Set(ids).size).toBe(120);
  });

  it('rejects, rather than answering an empty list the reconcile would prune against, when the search answers 500', async () => {
    const { adapter, calls } = adapterWith({ [CLOUD]: credential() }, () => ({ status: 500, body: { errorMessages: ['Internal error'] } }));
    await expect(runWithFakeTimers(() => adapter.listExternalIds({ source: 'jira', repository: `${CLOUD}::jql::project = ENG` })))
      .rejects.toThrow('failed (500)');
    // The client retried the 5xx up to its three attempts before giving up.
    expect(calls).toHaveLength(3);
  });

  it('rejects when a Cloud search keeps handing back the same cursor, instead of paging forever', async () => {
    const { adapter } = adapterWith({ [CLOUD]: credential() }, () => ({
      body: { issues: [{ id: '1' }], nextPageToken: 'same-token', isLast: false },
    }));
    await expect(adapter.listExternalIds({ source: 'jira', repository: `${CLOUD}::jql::project = ENG` }))
      .rejects.toThrow('Jira returned the same search cursor twice');
  });

  it('reads a saved filter fresh each time, so an edit to it in Jira reaches the next listing', async () => {
    let filterJql = 'project = ENG';
    const { adapter, calls } = adapterWith({ [CLOUD]: credential() }, (url) => {
      if (url.pathname === '/rest/api/3/filter/10021') return { body: { name: 'Mine', jql: filterJql } };
      if (url.pathname === '/rest/api/3/search/jql') return { body: { issues: [{ id: '1' }], isLast: true } };
      return undefined;
    });
    const input = { source: 'jira' as const, repository: `${CLOUD}::filter::10021` };
    await adapter.listExternalIds(input);
    filterJql = 'project = OPS';
    await adapter.listExternalIds(input);
    const searchedJql = calls.filter((call) => call.url.pathname === '/rest/api/3/search/jql').map((call) => call.url.searchParams.get('jql'));
    expect(searchedJql).toEqual(['project = ENG', 'project = OPS']);
  });
});

/** One page of an offset-paged listing that never returns more than 50 issues, as the agile API and Data Center do. */
function cappedOffsetPage(startAt: number, total: number): StubResponse {
  const count = Math.max(0, Math.min(50, total - startAt));
  const issues = Array.from({ length: count }, (_, index) => ({ ...ISSUE, id: String(startAt + index + 1) }));
  return { body: { issues, startAt, maxResults: 50, total } };
}

/**
 * Run work whose retry backoff would sleep for real, with timers advanced by
 * hand. Only setTimeout is faked, so the stubbed fetch still settles.
 */
async function runWithFakeTimers<T>(start: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ['setTimeout'] });
  try {
    const settled = start();
    settled.catch(() => undefined); // handled below by the caller's await; this only stops an early unhandled-rejection report
    await vi.runAllTimersAsync();
    return await settled;
  } finally {
    vi.useRealTimers();
  }
}

describe('JiraAdapter.fetch paging and run-scoped caches', () => {
  it('pages a board from where each page ended when the agile API returns 50 of the 100 asked for', async () => {
    const { adapter, calls } = adapterWith({ [CLOUD]: credential() }, (url) => {
      if (url.pathname === '/rest/agile/1.0/board/12/configuration') return { body: {} };
      if (url.pathname !== '/rest/agile/1.0/board/12/issue') return undefined;
      return cappedOffsetPage(Number(url.searchParams.get('startAt')), 120);
    });
    const repository = `${CLOUD}::board::12`;
    const first = await adapter.fetch({ source: 'jira', repository, page: 1, perPage: 100 }, findNone);
    expect(first.issues).toHaveLength(50);
    expect(first.hasNextPage).toBe(true);
    expect(first.totalCount).toBe(120);
    await adapter.fetch({ source: 'jira', repository, page: 2, perPage: 100 }, findNone);
    const issueCalls = calls.filter((call) => call.url.pathname.endsWith('/board/12/issue'));
    expect(issueCalls.map((call) => call.url.searchParams.get('startAt'))).toEqual(['0', '50']);
  });

  it('reads a saved filter again on each run page 1, so a Jira-side edit shows on the next fetch', async () => {
    let filterJql = 'project = ENG ORDER BY created DESC';
    const { adapter, calls } = adapterWith({ [CLOUD]: credential() }, (url) => {
      if (url.pathname === '/rest/api/3/filter/10021') return { body: { name: 'Mine', jql: filterJql } };
      if (url.pathname === '/rest/api/3/search/jql') return { body: { issues: [ISSUE], isLast: true } };
      return undefined;
    });
    const input = { source: 'jira' as const, repository: `${CLOUD}::filter::10021`, page: 1, perPage: 100 };
    await adapter.fetch(input, findNone);
    filterJql = 'project = OPS ORDER BY created DESC';
    await adapter.fetch(input, findNone);
    const searchedJql = calls.filter((call) => call.url.pathname === '/rest/api/3/search/jql').map((call) => call.url.searchParams.get('jql'));
    expect(searchedJql).toEqual(['project = ENG ORDER BY created DESC', 'project = OPS ORDER BY created DESC']);
  });

  it('reads a board configuration once per run: pages 1 and 2 share one call, a new page 1 makes another', async () => {
    const { adapter, calls } = adapterWith({ [CLOUD]: credential() }, (url) => {
      if (url.pathname === '/rest/agile/1.0/board/12/configuration') {
        return { body: { columnConfig: { columns: [{ name: 'In Review', statuses: [{ id: '10002' }] }] } } };
      }
      if (url.pathname !== '/rest/agile/1.0/board/12/issue') return undefined;
      return cappedOffsetPage(Number(url.searchParams.get('startAt')), 120);
    });
    const repository = `${CLOUD}::board::12`;
    const configurationCalls = () => calls.filter((call) => call.url.pathname.endsWith('/configuration')).length;
    await adapter.fetch({ source: 'jira', repository, page: 1, perPage: 100 }, findNone);
    await adapter.fetch({ source: 'jira', repository, page: 2, perPage: 100 }, findNone);
    expect(configurationCalls()).toBe(1);
    await adapter.fetch({ source: 'jira', repository, page: 1, perPage: 100 }, findNone);
    expect(configurationCalls()).toBe(2);
  });

  it('refuses a Cloud page asked for with no remembered cursor', async () => {
    const { adapter, calls } = adapterWith({ [CLOUD]: credential() }, () => ({ body: { issues: [ISSUE], isLast: true } }));
    await expect(adapter.fetch({ source: 'jira', repository: `${CLOUD}::jql::project = ENG`, page: 2, perPage: 100 }, findNone))
      .rejects.toThrow('Jira page 2 was asked for before page 1.');
    expect(calls).toHaveLength(0);
  });

  it('narrows a JQL source with since in the user time zone, keeping its ORDER BY last', async () => {
    const { adapter, calls } = adapterWith({ [CLOUD]: credential() }, (url) => {
      if (url.pathname === '/rest/api/3/myself') return { body: { timeZone: 'America/New_York' } };
      if (url.pathname === '/rest/api/3/search/jql') return { body: { issues: [ISSUE], isLast: true } };
      return undefined;
    });
    await adapter.fetch({
      source: 'jira',
      repository: `${CLOUD}::jql::project = ENG ORDER BY created DESC`,
      page: 1,
      perPage: 100,
      since: '2026-11-12T15:07:00.000Z',
    }, findNone);
    const searchCall = calls.find((call) => call.url.pathname === '/rest/api/3/search/jql');
    expect(searchCall?.url.searchParams.get('jql')).toBe('(project = ENG) AND updated >= "2026/11/12 10:02" ORDER BY created DESC');
  });
});

describe('JiraAdapter.checkCli', () => {
  const repository = `${CLOUD}::project::ENG`;

  it('reports a refused saved token (401) as not authenticated, with the Reconnect line', async () => {
    const { adapter } = adapterWith({ [CLOUD]: credential() }, () => ({ status: 401, body: {} }));
    expect(await adapter.checkCli(repository)).toEqual({ available: true, authenticated: false, error: 'Jira rejected the saved token.' });
  });

  it('does not offer Reconnect when the site is down (503): the fetch reports its own error', async () => {
    const { adapter } = adapterWith({ [CLOUD]: credential() }, () => ({ status: 503, body: {} }));
    const result = await runWithFakeTimers(() => adapter.checkCli(repository));
    expect(result.available).toBe(true);
    expect(result.authenticated).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('accepts a token /myself answers for', async () => {
    const { adapter } = adapterWith({ [CLOUD]: credential() }, () => ({ body: { accountId: 'abc' } }));
    expect(await adapter.checkCli(repository)).toMatchObject({ available: true, authenticated: true });
  });

  it('names the site when the repository belongs to one with no saved sign-in', async () => {
    const { adapter, calls } = adapterWith({ [DATA_CENTER]: credential({ site: DATA_CENTER }) }, () => ({ body: {} }));
    expect(await adapter.checkCli(repository)).toEqual({ available: true, authenticated: false, error: 'Not connected to acme.atlassian.net.' });
    expect(calls).toHaveLength(0);
  });

  it('with no repository, answers by whether any site is saved', async () => {
    const connected = adapterWith({ [CLOUD]: credential() }, () => undefined);
    expect(await connected.adapter.checkCli()).toMatchObject({ available: true, authenticated: true });
    const none = adapterWith({}, () => undefined);
    expect(await none.adapter.checkCli()).toEqual({ available: true, authenticated: false, error: 'Not connected to Jira.' });
  });
});

describe('JiraAdapter.hydrateForImport', () => {
  type HydrateIssue = Parameters<JiraAdapter['hydrateForImport']>[1][number];
  const importIssue = (externalId: string, body = ''): HydrateIssue => ({
    externalId,
    externalUrl: `${CLOUD}/browse/ENG-${externalId}`,
    title: `Issue ${externalId}`,
    body,
    labels: [],
    assignee: null,
  });
  const comment = (author: string, renderedBody: string) => ({ author: { displayName: author }, created: '2026-11-10T09:30:00.000+0000', renderedBody });
  const commentRoute = (perIssue: Record<string, StubResponse>): Route => (url) => {
    const match = /^\/rest\/api\/3\/issue\/([^/]+)\/comment$/.exec(url.pathname);
    return match ? perIssue[match[1]] : undefined;
  };
  const repository = `${CLOUD}::project::ENG`;

  it('appends a comments section after an existing body with a blank line, and skips comments with no rendered body', async () => {
    const { adapter } = adapterWith({ [CLOUD]: credential() }, commentRoute({
      '1': { body: { comments: [comment('Dana Park', '<p>Looks good.</p>'), comment('Silent Sam', ''), comment('Blank Bo', '   ')], total: 3 } },
    }));
    const [hydrated] = await adapter.hydrateForImport(repository, [importIssue('1', 'Original description')]);
    expect(hydrated.body.startsWith('Original description\n\n## Comments')).toBe(true);
    expect(hydrated.body).toContain('Dana Park');
    expect(hydrated.body).toContain('Looks good.');
    expect(hydrated.body).not.toContain('Silent Sam');
    expect(hydrated.body).not.toContain('Blank Bo');
  });

  it('makes the comments section the whole body when the issue had no description', async () => {
    const { adapter } = adapterWith({ [CLOUD]: credential() }, commentRoute({
      '1': { body: { comments: [comment('Dana Park', '<p>First.</p>')], total: 1 } },
    }));
    const [hydrated] = await adapter.hydrateForImport(repository, [importIssue('1', '')]);
    expect(hydrated.body.startsWith('## Comments')).toBe(true);
  });

  it('returns an issue with no comments (or only empty ones) unchanged', async () => {
    const { adapter } = adapterWith({ [CLOUD]: credential() }, commentRoute({
      '1': { body: { comments: [], total: 0 } },
      '2': { body: { comments: [comment('Silent Sam', '')], total: 1 } },
    }));
    const issues = [importIssue('1', 'Body one'), importIssue('2', 'Body two')];
    expect(await adapter.hydrateForImport(repository, issues)).toEqual(issues);
  });

  it('imports an issue whose comments answer 403 or 404 without them, while the others still get theirs', async () => {
    const { adapter } = adapterWith({ [CLOUD]: credential() }, commentRoute({
      '1': { status: 404, body: { errorMessages: ['Issue Does Not Exist'] } },
      '2': { status: 403, body: { errorMessages: ['No permission'] } },
      '3': { body: { comments: [comment('Dana Park', '<p>Kept.</p>')], total: 1 } },
    }));
    const result = await adapter.hydrateForImport(repository, [importIssue('1', 'One'), importIssue('2', 'Two'), importIssue('3', 'Three')]);
    expect(result[0].body).toBe('One');
    expect(result[1].body).toBe('Two');
    expect(result[2].body).toContain('Kept.');
  });

  it('rejects the whole call when a comments request keeps answering 500', async () => {
    const { adapter } = adapterWith({ [CLOUD]: credential() }, commentRoute({
      '1': { body: { comments: [comment('Dana Park', '<p>Fine.</p>')], total: 1 } },
      '2': { status: 500, body: {} },
    }));
    await expect(runWithFakeTimers(() => adapter.hydrateForImport(repository, [importIssue('1'), importIssue('2')])))
      .rejects.toThrow('failed (500)');
  });

  it('pages an issue with more comments than one page holds and folds every one in', async () => {
    const starts: string[] = [];
    const { adapter } = adapterWith({ [CLOUD]: credential() }, (url) => {
      if (url.pathname !== '/rest/api/3/issue/1/comment') return undefined;
      const startAt = Number(url.searchParams.get('startAt'));
      starts.push(String(startAt));
      const count = Math.min(100, 150 - startAt);
      const comments = Array.from({ length: count }, (_, index) => comment('Dana Park', `<p>remark-${startAt + index}</p>`));
      return { body: { comments, startAt, maxResults: 100, total: 150 } };
    });
    const [hydrated] = await adapter.hydrateForImport(repository, [importIssue('1', 'Body')]);
    expect(starts).toEqual(['0', '100']);
    expect(hydrated.body).toContain('remark-0');
    expect(hydrated.body).toContain('remark-149');
    expect(hydrated.body.match(/^### /gm)).toHaveLength(150);
  });
});

describe('JiraClient URL ownership', () => {
  const cloudClient = new JiraClient(credential());
  const gatewayClient = new JiraClient(credential({ viaGateway: true, cloudId: 'cloud-123' }));

  it('owns the site own scheme and host, host compared case-insensitively', () => {
    expect(cloudClient.ownsUrl(`${CLOUD}/secure/attachment/1/a.png`)).toBe(true);
    expect(cloudClient.ownsUrl('https://ACME.Atlassian.NET/secure/attachment/1/a.png')).toBe(true);
  });

  it('never owns http:// on the host of an https:// site, so the sign-in cannot cross in cleartext', () => {
    expect(cloudClient.ownsUrl('http://acme.atlassian.net/secure/attachment/1/a.png')).toBe(false);
  });

  it('owns the gateway host only for a sign-in that goes through it', () => {
    const gatewayUrl = 'https://api.atlassian.com/ex/jira/cloud-123/rest/api/3/attachment/content/1';
    expect(gatewayClient.ownsUrl(gatewayUrl)).toBe(true);
    expect(cloudClient.ownsUrl(gatewayUrl)).toBe(false);
    expect(gatewayClient.ownsUrl('http://api.atlassian.com/ex/jira/cloud-123/rest/api/3/attachment/content/1')).toBe(false);
  });

  it('owns no other host and no malformed URL', () => {
    expect(cloudClient.ownsUrl('https://elsewhere.example/a.png')).toBe(false);
    expect(cloudClient.ownsUrl('https://acme.atlassian.net.evil.example/a.png')).toBe(false);
    expect(cloudClient.ownsUrl('not a url')).toBe(false);
  });
});

describe('JiraClient.attachmentDownloadUrl', () => {
  it('asks Cloud for the bytes directly, through the API base, so a redirect cannot carry the sign-in away', () => {
    const original = `${CLOUD}/rest/api/3/attachment/content/20001`;
    expect(new JiraClient(credential()).attachmentDownloadUrl('20001', original))
      .toBe(`${CLOUD}/rest/api/3/attachment/content/20001?redirect=false`);
    expect(new JiraClient(credential({ viaGateway: true, cloudId: 'cloud-123' })).attachmentDownloadUrl('20001', original))
      .toBe('https://api.atlassian.com/ex/jira/cloud-123/rest/api/3/attachment/content/20001?redirect=false');
  });

  it('keeps the original content URL for Data Center', () => {
    const dc = new JiraClient(credential({ site: DATA_CENTER, deployment: 'datacenter', method: 'pat' }));
    const original = `${DATA_CENTER}/secure/attachment/20001/trace.log`;
    expect(dc.attachmentDownloadUrl('20001', original)).toBe(original);
  });
});

describe('JiraAdapter downloads', () => {
  const siteAuthorization = new JiraClient(credential()).authorizationHeader();
  const headersFor = (url: string): Record<string, string> | undefined => {
    const call = downloadFileSpy.mock.calls.find(([calledUrl]) => calledUrl === url);
    if (!call) throw new Error(`downloadFile was never called with ${url}`);
    return call[2]?.headers;
  };

  beforeEach(() => {
    downloadFileSpy.mockReset();
    downloadFileSpy.mockImplementation(async (url: string, filename: string) => ({
      filename, data: 'AAAA', mediaType: 'application/octet-stream', sizeBytes: 4, sourceUrl: url,
    }));
  });

  it('sends the sign-in with an inline image only when the URL is on the site', async () => {
    const { adapter } = adapterWith({ [CLOUD]: credential() }, () => undefined);
    const ownImage = `${CLOUD}/rest/api/3/attachment/content/20002`;
    const foreignImage = 'https://elsewhere.example/x.png';
    const cleartextImage = 'http://acme.atlassian.net/x.png';
    await adapter.downloadImages(`![a](${ownImage}) ![b](${foreignImage}) ![c](${cleartextImage})`);
    expect(downloadFileSpy).toHaveBeenCalledTimes(3);
    expect(headersFor(ownImage)).toEqual({ Authorization: siteAuthorization });
    expect(headersFor(foreignImage)).toBeUndefined();
    expect(headersFor(cleartextImage)).toBeUndefined();
  });

  it('sends the sign-in with a file attachment only when the URL is on the site, fetching Cloud bytes directly', async () => {
    const { adapter } = adapterWith({ [CLOUD]: credential() }, () => undefined);
    const foreignFile = 'https://elsewhere.example/x.png';
    const cleartextFile = 'http://acme.atlassian.net/x.png';
    await adapter.downloadFileAttachments([
      { url: `${CLOUD}/rest/api/3/attachment/content/20001`, filename: 'trace.log', sizeBytes: 1, externalRef: '20001' },
      { url: foreignFile, filename: 'x.png', sizeBytes: 1, externalRef: '20002' },
      { url: cleartextFile, filename: 'y.png', sizeBytes: 1, externalRef: '20003' },
    ]);
    expect(downloadFileSpy).toHaveBeenCalledTimes(3);
    expect(headersFor(`${CLOUD}/rest/api/3/attachment/content/20001?redirect=false`)).toEqual({ Authorization: siteAuthorization });
    expect(headersFor(foreignFile)).toBeUndefined();
    expect(headersFor(cleartextFile)).toBeUndefined();
  });
});

describe('connectJiraSite failure branches', () => {
  const serverInfo = (deploymentType: string): StubResponse => ({ body: { deploymentType } });

  it('maps a Data Center password refused with a Basic-authentication body to password-off', async () => {
    const save = vi.fn(async () => {});
    const { fetchImpl } = stubFetch((url) => (url.pathname.endsWith('/serverInfo')
      ? serverInfo('Server')
      : { status: 401, body: 'Basic authentication with passwords is deprecated and disabled.' }));
    expect(await connectJiraSite({ site: DATA_CENTER, method: 'password', username: 'dpark', secret: 'pw' }, fetchImpl, save))
      .toEqual({ ok: false, code: 'password-off', site: 'jira.example.com' });
    expect(save).not.toHaveBeenCalled();
  });

  it('maps a request timeout to unreachable with the ETIMEDOUT detail', async () => {
    const save = vi.fn(async () => {});
    const timedOut = (async () => {
      throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    }) as unknown as typeof fetch;
    expect(await connectJiraSite({ site: DATA_CENTER, method: 'pat', secret: 'token' }, timedOut, save))
      .toEqual({ ok: false, code: 'unreachable', site: 'jira.example.com', detail: 'ETIMEDOUT' });
    expect(save).not.toHaveBeenCalled();
  });

  it('maps a site that keeps answering 500 to unreachable with the status as detail', async () => {
    const save = vi.fn(async () => {});
    const { fetchImpl } = stubFetch((url) => (url.pathname.endsWith('/serverInfo') ? serverInfo('Server') : { status: 500, body: {} }));
    const result = await runWithFakeTimers(() => connectJiraSite({ site: DATA_CENTER, method: 'pat', secret: 'token' }, fetchImpl, save));
    expect(result).toEqual({ ok: false, code: 'unreachable', site: 'jira.example.com', detail: '500' });
    expect(save).not.toHaveBeenCalled();
  });

  it('maps a 403 that names no CAPTCHA to rejected', async () => {
    const save = vi.fn(async () => {});
    const { fetchImpl } = stubFetch((url) => (url.pathname.endsWith('/serverInfo') ? serverInfo('Server') : { status: 403, body: {} }));
    expect(await connectJiraSite({ site: DATA_CENTER, method: 'pat', secret: 'token' }, fetchImpl, save))
      .toEqual({ ok: false, code: 'rejected', site: 'jira.example.com' });
    expect(save).not.toHaveBeenCalled();
  });

  it('retries a Cloud token refused with 401 at the site through the gateway, and saves it as a gateway sign-in', async () => {
    const save = vi.fn(async () => {});
    const { fetchImpl, calls } = stubFetch((url) => {
      if (url.pathname.endsWith('/serverInfo')) return serverInfo('Cloud');
      if (url.pathname === '/_edge/tenant_info') return { body: { cloudId: 'cloud-123' } };
      if (url.host === 'api.atlassian.com' && url.pathname === '/ex/jira/cloud-123/rest/api/3/myself') return { body: { emailAddress: 'dana@acme.example' } };
      if (url.pathname === '/rest/api/3/myself') return { status: 401, body: {} };
      return undefined;
    });
    expect(await connectJiraSite({ site: CLOUD, method: 'api-token', email: 'dana@acme.example', secret: 'scoped' }, fetchImpl, save))
      .toEqual({ ok: true, site: 'acme.atlassian.net', account: 'dana@acme.example' });
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ viaGateway: true, cloudId: 'cloud-123', account: 'dana@acme.example' }));
    expect(calls.some((call) => call.url.pathname === '/_edge/tenant_info')).toBe(true);
  });

  it('ends as rejected, saving nothing, when the gateway refuses the Cloud token too', async () => {
    const save = vi.fn(async () => {});
    const { fetchImpl } = stubFetch((url) => {
      if (url.pathname.endsWith('/serverInfo')) return serverInfo('Cloud');
      if (url.pathname === '/_edge/tenant_info') return { body: { cloudId: 'cloud-123' } };
      return { status: 401, body: {} };
    });
    expect(await connectJiraSite({ site: CLOUD, method: 'api-token', email: 'dana@acme.example', secret: 'bad' }, fetchImpl, save))
      .toEqual({ ok: false, code: 'rejected', site: 'acme.atlassian.net' });
    expect(save).not.toHaveBeenCalled();
  });

  it('ends as rejected when the Cloud site publishes no cloud id to try the gateway with', async () => {
    const save = vi.fn(async () => {});
    const { fetchImpl } = stubFetch((url) => {
      if (url.pathname.endsWith('/serverInfo')) return serverInfo('Cloud');
      if (url.pathname === '/_edge/tenant_info') return { status: 404, body: {} };
      return { status: 401, body: {} };
    });
    expect(await connectJiraSite({ site: CLOUD, method: 'api-token', email: 'dana@acme.example', secret: 'bad' }, fetchImpl, save))
      .toEqual({ ok: false, code: 'rejected', site: 'acme.atlassian.net' });
    expect(save).not.toHaveBeenCalled();
  });
});

describe('Cloud search page with a cursor and no isLast', () => {
  const repository = `${CLOUD}::jql::project = ENG`;
  const route: Route = (url) => (url.searchParams.get('nextPageToken') === 'page-2'
    ? { body: { issues: [{ ...ISSUE, id: '10002', key: 'ENG-143' }] } }
    : { body: { issues: [ISSUE], nextPageToken: 'page-2' } });

  it('fetch reports hasNextPage: a token with no isLast is not the last page', async () => {
    const { adapter } = adapterWith({ [CLOUD]: credential() }, route);
    const first = await adapter.fetch({ source: 'jira', repository, page: 1, perPage: 100 }, findNone);
    expect(first.hasNextPage).toBe(true);
    const second = await adapter.fetch({ source: 'jira', repository, page: 2, perPage: 100 }, findNone);
    expect(second.hasNextPage).toBe(false);
    expect(second.issues[0].displayId).toBe('ENG-143');
  });

  it('listExternalIds requests the second page and returns the ids of both', async () => {
    const { adapter, calls } = adapterWith({ [CLOUD]: credential() }, route);
    const ids = await adapter.listExternalIds({ source: 'jira', repository });
    expect(ids).toEqual(['10001', '10002']);
    expect(calls.map((call) => call.url.searchParams.get('nextPageToken'))).toEqual([null, 'page-2']);
  });
});

describe('JiraAdapter.getAuthStatus with text that names no source', () => {
  it('rejects with the parse refusal for link-shaped text that names no Jira source', async () => {
    const { adapter } = adapterWith({ [CLOUD]: credential() }, () => undefined);
    const rejection = adapter.getAuthStatus('https://acme.atlassian.net/wiki/spaces/X');
    await expect(rejection).rejects.toBeInstanceOf(RefusalError);
    await expect(rejection).rejects.toThrow("That link doesn't name a Jira board, project, filter or search.");
  });

  it('answers none with no target and no saved site', async () => {
    const { adapter } = adapterWith({}, () => undefined);
    // signInAvailable is false: the mocked build offers no Sign in with Atlassian.
    expect(await adapter.getAuthStatus()).toEqual({ connected: false, reason: 'none', signInAvailable: false });
    expect(await adapter.getAuthStatus('   ')).toEqual({ connected: false, reason: 'none', signInAvailable: false });
  });

  it('answers none for typed JQL when no site is saved', async () => {
    const { adapter } = adapterWith({}, () => undefined);
    expect(await adapter.getAuthStatus('assignee = currentUser()')).toEqual({ connected: false, reason: 'none', signInAvailable: false });
  });
});

describe('JiraAdapter.getAuthStatus signInAvailable', () => {
  const offered = async (run: () => Promise<void>) => {
    signInOffer.available = true;
    try {
      await run();
    } finally {
      signInOffer.available = false;
    }
  };

  it('reports signInAvailable true on a not-connected answer when the build offers Sign in with Atlassian', async () => {
    await offered(async () => {
      const { adapter } = adapterWith({}, () => undefined);
      expect(await adapter.getAuthStatus()).toEqual({ connected: false, reason: 'none', signInAvailable: true });
    });
  });

  it('reports signInAvailable true on a connected answer when the build offers Sign in with Atlassian', async () => {
    await offered(async () => {
      const { adapter } = adapterWith({ [CLOUD]: credential() }, () => undefined);
      expect(await adapter.getAuthStatus()).toEqual({ connected: true, signInAvailable: true });
      expect(await adapter.getAuthStatus(`${CLOUD}/jira/software/projects/ENG/boards/1`)).toMatchObject({
        connected: true,
        site: CLOUD,
        signInAvailable: true,
      });
    });
  });
});

describe('JiraAdapter downloads for a browser sign-in', () => {
  const REFRESH_URL = 'https://kangentic.com/oauth/jira/refresh';

  beforeEach(() => {
    downloadFileSpy.mockReset();
    downloadFileSpy.mockImplementation(async (url: string, filename: string) => ({
      filename, data: 'AAAA', mediaType: 'application/octet-stream', sizeBytes: 4, sourceUrl: url,
    }));
    storedCredentials.sites = {};
  });

  it('sends the renewed bearer, not the expired one, with a file attachment', async () => {
    const expired = credential({
      method: 'oauth',
      email: undefined,
      secret: 'access-old',
      refreshToken: 'refresh-old',
      expiresAt: new Date(Date.now() - 60_000).toISOString(),
      cloudId: 'cloud-123',
      viaGateway: true,
    });
    storedCredentials.sites[CLOUD] = expired;
    const { adapter, calls } = adapterWith({ [CLOUD]: expired }, (url) => {
      if (url.toString() === REFRESH_URL) {
        return { body: { access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600 } };
      }
      return undefined;
    });

    await adapter.downloadFileAttachments([
      { url: `${CLOUD}/rest/api/3/attachment/content/20001`, filename: 'trace.log', sizeBytes: 1, externalRef: '20001' },
    ]);

    expect(calls.some((call) => call.url.toString() === REFRESH_URL)).toBe(true);
    const downloaded = downloadFileSpy.mock.calls.find(([calledUrl]) => calledUrl.includes('/attachment/content/20001'));
    expect(downloaded?.[2]?.headers).toEqual({ Authorization: 'Bearer access-new' });
    expect(storedCredentials.sites[CLOUD]).toMatchObject({ secret: 'access-new', refreshToken: 'refresh-new' });
  });
});

describe('JiraClient retries and non-JSON answers', () => {
  it('waits the 429 Retry-After before the second attempt and returns its answer', async () => {
    let attempt = 0;
    const { fetchImpl, calls } = stubFetch(() => {
      attempt += 1;
      return attempt === 1
        ? { status: 429, body: {}, headers: { 'retry-after': '1' } }
        : { body: { accountId: 'abc' } };
    });
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const pending = new JiraClient(credential(), fetchImpl).myself();
      // The default backoff would retry after 500 ms; Retry-After: 1 asks for 1000 ms.
      await vi.advanceTimersByTimeAsync(600);
      expect(calls).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(400);
      expect(calls).toHaveLength(2);
      expect(await pending).toEqual({ accountId: 'abc' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects a 200 whose body is an HTML page with a JiraHttpError carrying status 200', async () => {
    const { fetchImpl } = stubFetch(() => ({ body: '<html><body>Sign in</body></html>' }));
    const failure = await new JiraClient(credential(), fetchImpl).myself().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(JiraHttpError);
    expect((failure as JiraHttpError).status).toBe(200);
  });
});

describe('connectJiraSite remaining branches', () => {
  const serverInfo = (deploymentType: string): StubResponse => ({ body: { deploymentType } });

  it('reports a 200 HTML answer from /myself as unreachable with no detail', async () => {
    const save = vi.fn(async () => {});
    const { fetchImpl } = stubFetch((url) => (url.pathname.endsWith('/serverInfo')
      ? serverInfo('Server')
      : { body: '<html>SSO sign-in</html>' }));
    const result = await connectJiraSite({ site: DATA_CENTER, method: 'pat', secret: 'token' }, fetchImpl, save);
    expect(result).toEqual({ ok: false, code: 'unreachable', site: 'jira.example.com' });
    expect(result).not.toHaveProperty('detail');
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses an unknown method as invalid', async () => {
    const save = vi.fn(async () => {});
    const { fetchImpl, calls } = stubFetch(() => undefined);
    const input = { site: DATA_CENTER, method: 'oauth', secret: 'token' } as unknown as Parameters<typeof connectJiraSite>[0];
    expect(await connectJiraSite(input, fetchImpl, save)).toEqual({ ok: false, code: 'invalid' });
    expect(calls).toHaveLength(0);
    expect(save).not.toHaveBeenCalled();
  });

  it('refuses a site that is not a site as invalid, without calling out', async () => {
    const save = vi.fn(async () => {});
    const { fetchImpl, calls } = stubFetch(() => undefined);
    expect(await connectJiraSite({ site: 'not a site', method: 'pat', secret: 'token' }, fetchImpl, save))
      .toEqual({ ok: false, code: 'invalid' });
    expect(calls).toHaveLength(0);
    expect(save).not.toHaveBeenCalled();
  });

  it('names the account from /myself: emailAddress, else name, else displayName', async () => {
    const accountFor = async (myself: Record<string, string>) => {
      const save = vi.fn(async () => {});
      const { fetchImpl } = stubFetch((url) => (url.pathname.endsWith('/serverInfo') ? serverInfo('Server') : { body: myself }));
      const result = await connectJiraSite({ site: DATA_CENTER, method: 'pat', secret: 'token' }, fetchImpl, save);
      expect(save).toHaveBeenCalledWith(expect.objectContaining({ account: (result as { account: string }).account }));
      return (result as { account: string }).account;
    };
    expect(await accountFor({ emailAddress: 'dana@acme.example', name: 'dpark', displayName: 'Dana Park' })).toBe('dana@acme.example');
    expect(await accountFor({ name: 'dpark', displayName: 'Dana Park' })).toBe('dpark');
    expect(await accountFor({ displayName: 'Dana Park' })).toBe('Dana Park');
  });
});

describe('JiraAdapter.fetch run ends', () => {
  it('ends an offset run on an empty page even when the total says more, so the reconcile cannot ask for it forever', async () => {
    const dc = credential({ site: DATA_CENTER, deployment: 'datacenter', method: 'pat' });
    const { adapter } = adapterWith({ [DATA_CENTER]: dc }, (url) => (url.pathname === '/rest/api/2/search'
      ? { body: { issues: [], startAt: Number(url.searchParams.get('startAt')), total: 40 } }
      : undefined));
    const result = await adapter.fetch({ source: 'jira', repository: `${DATA_CENTER}::jql::project = ENG`, page: 1, perPage: 100 }, findNone);
    expect(result.issues).toHaveLength(0);
    expect(result.hasNextPage).toBe(false);
  });

  it('reads the user time zone again at the start of each incremental run', async () => {
    let timeZone = 'America/New_York';
    const { adapter, calls } = adapterWith({ [CLOUD]: credential() }, (url) => {
      if (url.pathname === '/rest/api/3/myself') return { body: { timeZone } };
      if (url.pathname === '/rest/api/3/search/jql') return { body: { issues: [ISSUE], isLast: true } };
      return undefined;
    });
    const input = { source: 'jira' as const, repository: `${CLOUD}::jql::project = ENG`, page: 1, perPage: 100, since: '2026-11-12T15:07:00.000Z' };
    await adapter.fetch(input, findNone);
    timeZone = 'Asia/Tokyo';
    await adapter.fetch(input, findNone);
    const searchedJql = calls
      .filter((call) => call.url.pathname === '/rest/api/3/search/jql')
      .map((call) => call.url.searchParams.get('jql'));
    expect(searchedJql).toEqual([
      '(project = ENG) AND updated >= "2026/11/12 10:02"',
      '(project = ENG) AND updated >= "2026/11/13 00:02"',
    ]);
  });
});

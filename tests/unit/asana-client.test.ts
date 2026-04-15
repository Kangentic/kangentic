/**
 * AsanaClient behavior tests. Focuses on the three non-obvious pieces of the
 * client:
 *   - offset-based pagination cursor caching
 *   - proactive and reactive token refresh
 *   - refresh serialization across concurrent callers
 *
 * All network calls are stubbed via `vi.stubGlobal('fetch', ...)`. The
 * credential-store module is mocked so nothing touches disk.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AsanaCredential } from '../../src/main/boards/adapters/asana/credential-store';

// Hoisted spies so they exist at module-evaluation time for vi.mock factories.
const refreshSpy = vi.hoisted(() => vi.fn<(refreshToken: string) => Promise<unknown>>());
const loadSpy = vi.hoisted(() => vi.fn<() => AsanaCredential | null>(() => null));
const saveSpy = vi.hoisted(() => vi.fn<(credential: AsanaCredential) => void>());
const clearSpy = vi.hoisted(() => vi.fn<() => void>());

vi.mock('../../src/main/boards/adapters/asana/credential-store', () => ({
  loadAsanaCredential: loadSpy,
  saveAsanaCredential: saveSpy,
  clearAsanaCredential: clearSpy,
}));

vi.mock('../../src/main/boards/adapters/asana/oauth', async () => {
  const actual = await vi.importActual<typeof import('../../src/main/boards/adapters/asana/oauth')>(
    '../../src/main/boards/adapters/asana/oauth',
  );
  return { ...actual, refreshAsanaToken: refreshSpy };
});

const { AsanaClient } = await import('../../src/main/boards/adapters/asana/client');

type FetchResponder = (url: string, init?: RequestInit) => Promise<Response> | Response;

let fetchResponder: FetchResponder;
let fetchCalls: Array<{ url: string; init?: RequestInit }>;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeCredential(overrides: Partial<AsanaCredential> = {}): AsanaCredential {
  return {
    accessToken: 'initial-access-token',
    refreshToken: 'initial-refresh-token',
    expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    userEmail: 'user@example.com',
    savedAt: new Date().toISOString(),
    ...overrides,
  };
}

function taskListResponse(ids: string[], nextOffset: string | null) {
  return {
    data: ids.map((gid) => ({ gid, name: `Task ${gid}` })),
    next_page: nextOffset ? { offset: nextOffset, path: '/x', uri: 'https://x' } : null,
  };
}

beforeEach(() => {
  fetchCalls = [];
  fetchResponder = () => jsonResponse(200, { data: [] });
  loadSpy.mockReset();
  loadSpy.mockReturnValue(null);
  saveSpy.mockReset();
  clearSpy.mockReset();
  refreshSpy.mockReset();
  refreshSpy.mockImplementation(async () => ({
    accessToken: 'refreshed-access-token',
    refreshToken: 'rotated-refresh-token',
    expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
  }));
  vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
    fetchCalls.push({ url, init });
    return fetchResponder(url, init);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AsanaClient.listTasks pagination cursor cache', () => {
  it('does not send an offset on page 1', async () => {
    fetchResponder = () => jsonResponse(200, taskListResponse(['1', '2'], 'CURSOR-FOR-PAGE-2'));
    const client = new AsanaClient(makeCredential());

    await client.listTasks('1199999', { page: 1, perPage: 2 });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).not.toContain('offset=');
  });

  it('uses the cursor stashed by the previous page on page 2', async () => {
    let callNumber = 0;
    fetchResponder = () => {
      callNumber += 1;
      if (callNumber === 1) return jsonResponse(200, taskListResponse(['1', '2'], 'CURSOR-FOR-PAGE-2'));
      return jsonResponse(200, taskListResponse(['3', '4'], null));
    };
    const client = new AsanaClient(makeCredential());

    await client.listTasks('1199999', { page: 1, perPage: 2 });
    await client.listTasks('1199999', { page: 2, perPage: 2 });

    expect(fetchCalls).toHaveLength(2);
    expect(fetchCalls[1].url).toContain('offset=CURSOR-FOR-PAGE-2');
  });

  it('throws when asked for page N without first fetching page N-1', async () => {
    const client = new AsanaClient(makeCredential());
    await expect(client.listTasks('1199999', { page: 2, perPage: 2 })).rejects.toThrow(
      /Asana pagination skipped/,
    );
  });

  it('re-fetching page 1 clears the stored cursor so page 2 is not reusable', async () => {
    let callNumber = 0;
    fetchResponder = () => {
      callNumber += 1;
      // Page 1 (first call) returns no next_page; this clears the cursor.
      if (callNumber === 1) return jsonResponse(200, taskListResponse(['a'], null));
      throw new Error('unreachable');
    };
    const client = new AsanaClient(makeCredential());

    await client.listTasks('1199999', { page: 1, perPage: 2 });
    await expect(client.listTasks('1199999', { page: 2, perPage: 2 })).rejects.toThrow(
      /Asana pagination skipped/,
    );
  });
});

describe('AsanaClient proactive token refresh', () => {
  it('refreshes before the first request when the credential is past its margin', async () => {
    // Credential expires in 10s, well inside the 60s safety margin.
    const nearExpiry = makeCredential({
      expiresAt: new Date(Date.now() + 10 * 1000).toISOString(),
    });
    fetchResponder = () => jsonResponse(200, { data: [] });

    const client = new AsanaClient(nearExpiry);
    await client.getMe();

    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(saveSpy).toHaveBeenCalledTimes(1);
    // The request should have gone out with the refreshed access token, not
    // the original one.
    expect(fetchCalls).toHaveLength(1);
    const authHeader = (fetchCalls[0].init?.headers as Record<string, string>).Authorization;
    expect(authHeader).toBe('Bearer refreshed-access-token');
  });

  it('does not refresh when the credential is comfortably valid', async () => {
    fetchResponder = () => jsonResponse(200, { data: {} });
    const client = new AsanaClient(makeCredential());
    await client.getMe();
    expect(refreshSpy).not.toHaveBeenCalled();
  });
});

describe('AsanaClient reactive 401 handling', () => {
  it('refreshes once and retries when the first request returns 401', async () => {
    let callNumber = 0;
    fetchResponder = () => {
      callNumber += 1;
      if (callNumber === 1) return jsonResponse(401, { errors: [{ message: 'expired' }] });
      return jsonResponse(200, { data: { gid: '1' } });
    };
    const client = new AsanaClient(makeCredential());

    await client.getMe();

    expect(refreshSpy).toHaveBeenCalledTimes(1);
    expect(fetchCalls).toHaveLength(2);
    const retryAuth = (fetchCalls[1].init?.headers as Record<string, string>).Authorization;
    expect(retryAuth).toBe('Bearer refreshed-access-token');
  });

  it('clears the credential and rethrows when the refresh itself fails', async () => {
    let callNumber = 0;
    fetchResponder = () => {
      callNumber += 1;
      if (callNumber === 1) return jsonResponse(401, { errors: [] });
      throw new Error('should not reach retry');
    };
    refreshSpy.mockRejectedValueOnce(new Error('refresh exchange failed'));

    const client = new AsanaClient(makeCredential());
    await expect(client.getMe()).rejects.toThrow(/refresh exchange failed/);
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });
});

describe('AsanaClient refresh serialization', () => {
  it('coalesces concurrent refresh attempts into a single refresh call', async () => {
    // Credential is inside the refresh margin so every request sees shouldRefresh=true.
    const nearExpiry = makeCredential({
      expiresAt: new Date(Date.now() + 5 * 1000).toISOString(),
    });

    // Block the refresh until we release it, so both callers have a chance
    // to observe the in-flight state.
    let release: () => void = () => {};
    const block = new Promise<void>((resolve) => { release = resolve; });
    refreshSpy.mockImplementation(async () => {
      await block;
      return {
        accessToken: 'refreshed-access-token',
        refreshToken: 'rotated-refresh-token',
        expiresAt: new Date(Date.now() + 3600 * 1000).toISOString(),
      };
    });

    fetchResponder = () => jsonResponse(200, { data: {} });
    const client = new AsanaClient(nearExpiry);

    const firstRequest = client.getMe();
    const secondRequest = client.getMe();

    // Allow any queued microtasks to run, then release the refresh.
    await Promise.resolve();
    release();

    await Promise.all([firstRequest, secondRequest]);

    expect(refreshSpy).toHaveBeenCalledTimes(1);
    // Both API requests went out with the refreshed token.
    expect(fetchCalls).toHaveLength(2);
    for (const call of fetchCalls) {
      const authHeader = (call.init?.headers as Record<string, string>).Authorization;
      expect(authHeader).toBe('Bearer refreshed-access-token');
    }
  });
});

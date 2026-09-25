/**
 * Unit tests for `respondCookieJar` in src/devtools/main/cookie-jar-routes.ts.
 *
 * Dev-only cookie experiment rig: exercises the request-shape validation and
 * the error-envelope mapping, plus the one property that is a real security
 * boundary rather than a rig convenience - a list response redacts cookie
 * VALUES unless the caller explicitly opts in.
 *
 * Mocks only `electron` (app.getPath, session.fromPartition). `node:fs` is
 * left real: `jarExistsOnDisk` stats a path built from the mocked userData
 * directory, which never exists on disk in a test run, so `existsSync`
 * returns false without ever touching a real jar. `cookie-seed.ts` and
 * `browser-partition.ts` are pure logic and are exercised for real.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Cookie } from 'electron';

const { fakeGetPath, fromPartition, sessionsByPartition } = vi.hoisted(() => {
  function makeFakeSession() {
    return {
      cookies: {
        get: vi.fn(async () => [] as Cookie[]),
        set: vi.fn(async () => undefined),
        flushStore: vi.fn(async () => undefined),
      },
    };
  }
  const sessionsByPartition = new Map<string, ReturnType<typeof makeFakeSession>>();
  const fromPartition = vi.fn((partition: string) => {
    let existing = sessionsByPartition.get(partition);
    if (!existing) {
      existing = makeFakeSession();
      sessionsByPartition.set(partition, existing);
    }
    return existing;
  });
  const fakeGetPath = vi.fn(() => '/mock/userData');
  return { fakeGetPath, fromPartition, sessionsByPartition };
});

vi.mock('electron', () => ({
  app: { getPath: (name: string) => fakeGetPath(name) },
  session: { fromPartition: (partition: string) => fromPartition(partition) },
}));

// ---------------------------------------------------------------------------
// Import under test (must come after all vi.mock() calls)
// ---------------------------------------------------------------------------

import { respondCookieJar } from '../../src/devtools/main/cookie-jar-routes';

// ---------------------------------------------------------------------------
// Fixtures and helpers
// ---------------------------------------------------------------------------

function makeCookie(overrides: Partial<Cookie> & Pick<Cookie, 'name' | 'value'>): Cookie {
  return {
    domain: '.example.com',
    path: '/',
    secure: true,
    httpOnly: true,
    hostOnly: false,
    session: false,
    sameSite: 'lax',
    expirationDate: 2_000_000_000,
    ...overrides,
  } as Cookie;
}

interface RecordedJsonCall {
  statusCode: number;
  body: unknown;
}
interface RecordedErrorCall {
  statusCode: number;
  kind: string;
  detail: string;
}

function makeResponder(): {
  responder: {
    json: (statusCode: number, body: unknown) => void;
    error: (statusCode: number, kind: string, detail: string) => void;
  };
  jsonCalls: RecordedJsonCall[];
  errorCalls: RecordedErrorCall[];
} {
  const jsonCalls: RecordedJsonCall[] = [];
  const errorCalls: RecordedErrorCall[] = [];
  return {
    responder: {
      json: (statusCode, body) => { jsonCalls.push({ statusCode, body }); },
      error: (statusCode, kind, detail) => { errorCalls.push({ statusCode, kind, detail }); },
    },
    jsonCalls,
    errorCalls,
  };
}

function primeCookies(partition: string, cookies: Cookie[]): void {
  const session = fromPartition(partition);
  session.cookies.get.mockResolvedValue(cookies);
}

beforeEach(() => {
  sessionsByPartition.clear();
  fromPartition.mockClear();
  fakeGetPath.mockClear();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('respondCookieJar - list', () => {
  const PARTITION = 'persist:kng-project1-task1';

  it('omits the cookie value unless includeValues is true; valueLength is always present', async () => {
    const secretCookie = makeCookie({ name: 'SID', value: 'secret123' });
    primeCookies(PARTITION, [secretCookie]);

    const withoutValues = makeResponder();
    await respondCookieJar('POST /cookie-jar-list', { partition: PARTITION }, withoutValues.responder);

    expect(withoutValues.jsonCalls).toHaveLength(1);
    const bodyWithoutValues = withoutValues.jsonCalls[0].body as { cookies: Array<Record<string, unknown>> };
    expect(bodyWithoutValues.cookies).toHaveLength(1);
    expect(bodyWithoutValues.cookies[0].value).toBeUndefined();
    expect(bodyWithoutValues.cookies[0].valueLength).toBe('secret123'.length);

    const withValues = makeResponder();
    await respondCookieJar(
      'POST /cookie-jar-list',
      { partition: PARTITION, includeValues: true },
      withValues.responder,
    );

    expect(withValues.jsonCalls).toHaveLength(1);
    const bodyWithValues = withValues.jsonCalls[0].body as { cookies: Array<Record<string, unknown>> };
    expect(bodyWithValues.cookies[0].value).toBe('secret123');
    expect(bodyWithValues.cookies[0].valueLength).toBe('secret123'.length);
  });
});

describe('respondCookieJar - copy', () => {
  it('missing or empty domains returns a 400 missing-domains and copies nothing', async () => {
    const missing = makeResponder();
    await respondCookieJar(
      'POST /cookie-jar-copy',
      { sourcePartition: 'persist:kng-project1-source', targetPartition: 'persist:kng-project1-target' },
      missing.responder,
    );
    expect(missing.errorCalls).toEqual([{ statusCode: 400, kind: 'missing-domains', detail: expect.any(String) }]);
    // Nothing was copied: the request never got far enough to resolve a
    // session for either partition.
    expect(fromPartition).not.toHaveBeenCalled();

    const empty = makeResponder();
    await respondCookieJar(
      'POST /cookie-jar-copy',
      {
        sourcePartition: 'persist:kng-project1-source',
        targetPartition: 'persist:kng-project1-target',
        domains: [],
      },
      empty.responder,
    );
    expect(empty.errorCalls).toEqual([{ statusCode: 400, kind: 'missing-domains', detail: expect.any(String) }]);
    expect(fromPartition).not.toHaveBeenCalled();
  });
});

describe('respondCookieJar - request validation and error envelope', () => {
  it('a missing partition string returns a 400 missing-target', async () => {
    const { responder, errorCalls } = makeResponder();
    await respondCookieJar('POST /cookie-jar-list', {}, responder);
    expect(errorCalls).toEqual([{ statusCode: 400, kind: 'missing-target', detail: expect.any(String) }]);
  });

  it('a thrown non-request error surfaces as a 500 cookie-jar-failed', async () => {
    fromPartition.mockImplementationOnce(() => {
      throw new Error('partition explosion');
    });
    const { responder, errorCalls } = makeResponder();
    await respondCookieJar('POST /cookie-jar-list', { partition: 'persist:kng-project1-unprimed' }, responder);
    expect(errorCalls).toEqual([{ statusCode: 500, kind: 'cookie-jar-failed', detail: 'partition explosion' }]);
  });
});

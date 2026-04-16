/**
 * Asana attachment download + adapter wiring.
 *
 * Covers the two real defects fixed in the PAT-migration change:
 *   1. `downloadFileAttachments` must attach a Bearer token when the URL host
 *      is one of Asana's authed hosts. Without it Asana's redirector at
 *      app.asana.com returns 401 and downloads silently fail.
 *   2. The adapter's `fetch` must merge `<img>` URLs from `html_notes` into
 *      the file-attachments list so inline images embedded in the description
 *      flow through the same authed download path.
 *
 * Network calls are stubbed via `vi.stubGlobal('fetch', ...)` for the API
 * surface and via `vi.mock` for the lower-level `downloadFile` helper.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { AsanaCredential } from '../../src/main/boards/adapters/asana/credential-store';

const downloadFileSpy = vi.hoisted(() =>
  vi.fn<(url: string, filename: string, options?: { headers?: Record<string, string> }) => Promise<unknown>>(),
);
const loadSpy = vi.hoisted(() => vi.fn<() => AsanaCredential | null>(() => null));
const saveSpy = vi.hoisted(() => vi.fn<(credential: AsanaCredential) => void>());
const clearSpy = vi.hoisted(() => vi.fn<() => void>());

vi.mock('../../src/main/boards/adapters/asana/credential-store', () => ({
  loadAsanaCredential: loadSpy,
  saveAsanaCredential: saveSpy,
  clearAsanaCredential: clearSpy,
}));

vi.mock('../../src/main/boards/shared/download-file', async () => {
  const actual = await vi.importActual<typeof import('../../src/main/boards/shared/download-file')>(
    '../../src/main/boards/shared/download-file',
  );
  return { ...actual, downloadFile: downloadFileSpy };
});


const { AsanaClient } = await import('../../src/main/boards/adapters/asana/client');
const { AsanaAdapter } = await import('../../src/main/boards/adapters/asana/adapter');

function makeCredential(overrides: Partial<AsanaCredential> = {}): AsanaCredential {
  return {
    accessToken: 'pat-token-1234567890',
    userEmail: 'user@example.com',
    savedAt: new Date().toISOString(),
    ...overrides,
  };
}

beforeEach(() => {
  loadSpy.mockReset();
  loadSpy.mockReturnValue(null);
  saveSpy.mockReset();
  clearSpy.mockReset();
  downloadFileSpy.mockReset();
  downloadFileSpy.mockImplementation(async (url: string, filename: string) => ({
    filename,
    data: 'AAAA',
    mediaType: 'application/octet-stream',
    sizeBytes: 4,
    sourceUrl: url,
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('AsanaClient.downloadFileAttachments - auth header on Asana hosts', () => {
  it('attaches Bearer when host is app.asana.com', async () => {
    const client = new AsanaClient(makeCredential());
    await client.downloadFileAttachments([
      { url: 'https://app.asana.com/api/1.0/attachments/123/download', filename: 'pasted.png', sizeBytes: 0 },
    ]);

    expect(downloadFileSpy).toHaveBeenCalledTimes(1);
    const [, , options] = downloadFileSpy.mock.calls[0];
    expect(options?.headers?.Authorization).toBe('Bearer pat-token-1234567890');
  });

  it('attaches Bearer when host is a regional asana-user-private S3 bucket', async () => {
    const client = new AsanaClient(makeCredential());
    await client.downloadFileAttachments([
      { url: 'https://asana-user-private-us-east-1.s3.amazonaws.com/abc?X-Amz-...', filename: 'doc.pdf', sizeBytes: 0 },
    ]);

    const [, , options] = downloadFileSpy.mock.calls[0];
    expect(options?.headers?.Authorization).toBe('Bearer pat-token-1234567890');
  });

  it('does NOT attach Bearer for non-Asana hosts (avoids leaking PAT to third-party CDNs)', async () => {
    const client = new AsanaClient(makeCredential());
    await client.downloadFileAttachments([
      { url: 'https://cdn.example.com/some-image.png', filename: 'thirdparty.png', sizeBytes: 0 },
    ]);

    const [, , options] = downloadFileSpy.mock.calls[0];
    expect(options).toBeUndefined();
  });

  it('still downloads (anonymously) when no credential is stored', async () => {
    loadSpy.mockReturnValue(null);
    const client = new AsanaClient();
    await client.downloadFileAttachments([
      { url: 'https://app.asana.com/api/1.0/attachments/123/download', filename: 'pasted.png', sizeBytes: 0 },
    ]);

    const [, , options] = downloadFileSpy.mock.calls[0];
    expect(options).toBeUndefined();
  });

  it('skips entries with malformed URLs and reports them as skippedCount', async () => {
    const client = new AsanaClient(makeCredential());
    const result = await client.downloadFileAttachments([
      { url: 'not a url at all', filename: 'broken.png', sizeBytes: 0 },
    ]);

    expect(result.skippedCount).toBe(1);
    expect(result.attachments).toHaveLength(0);
    expect(downloadFileSpy).not.toHaveBeenCalled();
  });
});

describe('AsanaAdapter.fetch - file attachments and externalRef passthrough', () => {
  /**
   * Subset of AsanaClient that AsanaAdapter calls. Defining this lets us
   * stub the client without a double `as unknown as` cast.
   */
  type AdapterFacingClient = Pick<
    InstanceType<typeof AsanaClient>,
    'hasCredential' | 'getMe' | 'getProject' | 'listTasks' | 'listAttachments'
    | 'fetchAttachmentsForTasks' | 'getAttachment' | 'downloadInlineImages'
    | 'downloadFileAttachments'
  >;

  /**
   * Build a minimal AsanaClient stub that returns the given tasks and an
   * empty attachment list by default.
   */
  function makeStubClient(tasks: unknown[]): AdapterFacingClient {
    return {
      hasCredential: () => true,
      getMe: async () => ({ gid: '1', email: 'u@x.com' }),
      getProject: async () => null,
      listTasks: async () => ({ tasks, hasNextPage: false }),
      listAttachments: async () => [],
      fetchAttachmentsForTasks: async () => new Map(),
      getAttachment: async () => null,
      downloadInlineImages: async () => ({ attachments: [], skippedCount: 0 }),
      downloadFileAttachments: async () => ({ attachments: [], skippedCount: 0 }),
    } as AdapterFacingClient;
  }

  it('passes the attachment gid through as externalRef so the executor can refresh URLs', async () => {
    const url = 'https://app.asana.com/api/1.0/attachments/999/foo.png';
    const tasks = [
      {
        gid: '42',
        name: 'GWPC photo',
        notes: 'See the pasted image.',
        html_notes: '<body>See <img data-asana-gid="999" src="..."/></body>',
        permalink_url: 'https://app.asana.com/0/1/42',
        num_attachments: 1,
      },
    ];
    const stubClient = makeStubClient(tasks);
    stubClient.fetchAttachmentsForTasks = async () =>
      new Map([['42', [{ gid: '999', name: 'pasted.png', size: 1234, download_url: url }]]]);
    const adapter = new AsanaAdapter(stubClient);

    const result = await adapter.fetch(
      { source: 'asana', repository: '1', page: 1, perPage: 10 },
      () => new Set<string>(),
    );

    expect(result.issues).toHaveLength(1);
    expect(result.issues[0].fileAttachments).toHaveLength(1);
    const attachment = result.issues[0].fileAttachments![0];
    expect(attachment.url).toBe(url);
    expect(attachment.filename).toBe('pasted.png');
    expect(attachment.externalRef).toBe('999');
  });

  it('drops attachments returned with null download_url (Box/Dropbox-hosted refs)', async () => {
    const tasks = [{ gid: '7', name: 'External', num_attachments: 1 }];
    const stubClient = makeStubClient(tasks);
    stubClient.fetchAttachmentsForTasks = async () =>
      new Map([['7', [{ gid: 'b1', name: 'box-file.docx', size: 0, download_url: null, resource_subtype: 'box' }]]]);
    const adapter = new AsanaAdapter(stubClient);

    const result = await adapter.fetch(
      { source: 'asana', repository: '1', page: 1, perPage: 10 },
      () => new Set<string>(),
    );

    expect(result.issues[0].fileAttachments).toBeUndefined();
  });
});

describe('AsanaClient.downloadFileAttachments - URL refresh', () => {
  it('re-fetches a fresh download_url via /attachments/{gid} when externalRef is set', async () => {
    const fetchCalls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      fetchCalls.push(url);
      // /attachments/{gid} returns a fresh download_url
      return new Response(
        JSON.stringify({ data: { gid: '999', name: 'pasted.png', size: 1234, download_url: 'https://app.asana.com/api/1.0/attachments/999/FRESH' } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });

    const client = new AsanaClient(makeCredential());
    await client.downloadFileAttachments([
      {
        url: 'https://app.asana.com/api/1.0/attachments/999/STALE',
        filename: 'pasted.png',
        sizeBytes: 1234,
        externalRef: '999',
      },
    ]);

    // First call refreshes metadata; downloadFile (mocked separately) consumes the fresh URL.
    expect(fetchCalls.some((url) => url.includes('/attachments/999'))).toBe(true);
    // The actual download went through downloadFileSpy (mocked at module level).
    const [downloadedUrl] = downloadFileSpy.mock.calls[0];
    expect(downloadedUrl).toBe('https://app.asana.com/api/1.0/attachments/999/FRESH');
  });

  it('falls back to the original URL when externalRef refresh returns no download_url', async () => {
    vi.stubGlobal('fetch', async () => {
      return new Response(JSON.stringify({ data: { gid: '999' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const client = new AsanaClient(makeCredential());
    await client.downloadFileAttachments([
      {
        url: 'https://app.asana.com/api/1.0/attachments/999/ORIGINAL',
        filename: 'file.png',
        sizeBytes: 0,
        externalRef: '999',
      },
    ]);

    const [downloadedUrl] = downloadFileSpy.mock.calls[0];
    expect(downloadedUrl).toBe('https://app.asana.com/api/1.0/attachments/999/ORIGINAL');
  });

  it('skips the refresh when externalRef is missing (e.g. external adapter)', async () => {
    let fetchCalled = false;
    vi.stubGlobal('fetch', async () => {
      fetchCalled = true;
      return new Response('', { status: 500 });
    });

    const client = new AsanaClient(makeCredential());
    await client.downloadFileAttachments([
      { url: 'https://example.com/img.png', filename: 'img.png', sizeBytes: 0 },
    ]);

    expect(fetchCalled).toBe(false);
    const [downloadedUrl] = downloadFileSpy.mock.calls[0];
    expect(downloadedUrl).toBe('https://example.com/img.png');
  });
});

describe('isAsanaAuthedDownloadHost', () => {
  // Import the predicate directly - it has no deps and runs in vitest without mocks.
  let isAsanaAuthedDownloadHost: (host: string) => boolean;

  beforeEach(async () => {
    const module = await import('../../src/main/boards/adapters/asana/constants');
    isAsanaAuthedDownloadHost = module.isAsanaAuthedDownloadHost;
  });

  it('accepts app.asana.com (exact match)', () => {
    expect(isAsanaAuthedDownloadHost('app.asana.com')).toBe(true);
  });

  it('accepts asana-user-private-us-east-1.s3.amazonaws.com', () => {
    expect(isAsanaAuthedDownloadHost('asana-user-private-us-east-1.s3.amazonaws.com')).toBe(true);
  });

  it('accepts asana-user-private-eu-west-1.s3.amazonaws.com', () => {
    expect(isAsanaAuthedDownloadHost('asana-user-private-eu-west-1.s3.amazonaws.com')).toBe(true);
  });

  it('accepts asana-user-private-us-west-2.s3.amazonaws.com', () => {
    expect(isAsanaAuthedDownloadHost('asana-user-private-us-west-2.s3.amazonaws.com')).toBe(true);
  });

  it('rejects s3.amazonaws.com (no asana-user-private prefix)', () => {
    expect(isAsanaAuthedDownloadHost('s3.amazonaws.com')).toBe(false);
  });

  it('rejects app.asana.com.evil.com (suffix attack, not an exact match)', () => {
    expect(isAsanaAuthedDownloadHost('app.asana.com.evil.com')).toBe(false);
  });

  it('rejects cdn.example.com (unrelated host)', () => {
    expect(isAsanaAuthedDownloadHost('cdn.example.com')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isAsanaAuthedDownloadHost('')).toBe(false);
  });
});

describe('AsanaClient.downloadFileAttachments - getAttachment network error fallback', () => {
  it('returns null from getAttachment on a 500 and falls back to the original URL', async () => {
    // Use fake timers so withBackoff's retry sleep() calls complete without
    // burning real wall-clock time (500 + 1000ms across 3 attempts).
    vi.useFakeTimers();

    vi.stubGlobal('fetch', async () => {
      return new Response('Internal Server Error', { status: 500 });
    });

    const client = new AsanaClient(makeCredential());
    const downloadPromise = client.downloadFileAttachments([
      {
        url: 'https://app.asana.com/api/1.0/attachments/999/ORIGINAL',
        filename: 'photo.png',
        sizeBytes: 0,
        externalRef: '999',
      },
    ]);

    // Advance fake timers to skip all backoff delays.
    await vi.runAllTimersAsync();
    const result = await downloadPromise;

    vi.useRealTimers();

    // downloadOne is called with the original URL because getAttachment returned null.
    const [downloadedUrl] = downloadFileSpy.mock.calls[0];
    expect(downloadedUrl).toBe('https://app.asana.com/api/1.0/attachments/999/ORIGINAL');
    // The attachment was still downloaded (no skip).
    expect(result.skippedCount).toBe(0);
    expect(result.attachments).toHaveLength(1);
  });

  it('does not throw when getAttachment throws an exception', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('network timeout');
    });

    const client = new AsanaClient(makeCredential());
    // Should not throw - the try/catch in getAttachment returns null.
    const result = await client.downloadFileAttachments([
      {
        url: 'https://app.asana.com/api/1.0/attachments/777/ORIGINAL',
        filename: 'file.pdf',
        sizeBytes: 100,
        externalRef: '777',
      },
    ]);

    // downloadFile was still called with the original URL.
    const [downloadedUrl] = downloadFileSpy.mock.calls[0];
    expect(downloadedUrl).toBe('https://app.asana.com/api/1.0/attachments/777/ORIGINAL');
    expect(result.skippedCount).toBe(0);
    expect(result.attachments).toHaveLength(1);
  });
});

describe('AsanaClient request behavior - no refresh path under PAT auth', () => {
  it('clears the stored credential on 401 (no refresh, no retry)', async () => {
    let callNumber = 0;
    vi.stubGlobal('fetch', async () => {
      callNumber += 1;
      return new Response(JSON.stringify({ errors: [{ message: 'token revoked' }] }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    });

    const client = new AsanaClient(makeCredential());
    await expect(client.getMe()).rejects.toThrow(/Re-paste your Personal Access Token/);
    expect(callNumber).toBe(1);
    expect(clearSpy).toHaveBeenCalledTimes(1);
  });

  it('validateToken sends Bearer with the supplied token (independent of stored credential)', async () => {
    const fetchCalls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      fetchCalls.push({ url, init });
      return new Response(JSON.stringify({ data: { gid: '1', email: 'paste@example.com' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const client = new AsanaClient();
    const user = await client.validateToken('freshly-pasted-pat');
    expect(user.email).toBe('paste@example.com');
    expect(fetchCalls).toHaveLength(1);
    const headers = fetchCalls[0].init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer freshly-pasted-pat');
    // Validation must not touch the stored credential.
    expect(saveSpy).not.toHaveBeenCalled();
  });
});

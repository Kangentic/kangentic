/**
 * Azure DevOps download auth: which hosts receive the bearer token.
 *
 * Guards the fix for the CodeQL `js/incomplete-url-substring-sanitization`
 * alerts on `azure-devops/adapter.ts`. The adapter used to gate the token on
 * `url.includes('dev.azure.com')`, and inline image URLs are parsed straight
 * out of a work item body, so anyone able to edit a work item could point the
 * download at their own host and collect the user's Azure AD access token.
 *
 * The download helper is mocked at its leaf module (`shared/download-file`)
 * rather than at the `shared/index.ts` barrel the adapter imports through;
 * the barrel re-exports from the leaf, so the mock still intercepts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const downloadFileSpy = vi.hoisted(() =>
  vi.fn<(url: string, filename: string, options?: { headers?: Record<string, string> }) => Promise<unknown>>(),
);

vi.mock('../../src/main/boards/shared/download-file', async () => {
  const actual = await vi.importActual<typeof import('../../src/main/boards/shared/download-file')>(
    '../../src/main/boards/shared/download-file',
  );
  return { ...actual, downloadFile: downloadFileSpy };
});

const { AzureDevOpsAdapter } = await import('../../src/main/boards/adapters/azure-devops/adapter');
const { AzureDevOpsImporter } = await import('../../src/main/boards/adapters/azure-devops/client');
const { isAzureDevOpsAuthedDownloadUrl } = await import('../../src/main/boards/adapters/azure-devops/url-parser');

const ACCESS_TOKEN = 'ado-access-token-1234567890';
const EXPECTED_AUTHORIZATION = `Bearer ${ACCESS_TOKEN}`;

const MODERN_IMAGE_URL = 'https://dev.azure.com/myorg/_apis/wit/attachments/abc.png';
const LEGACY_IMAGE_URL = 'https://myorg.visualstudio.com/_apis/wit/attachments/abc.png';
const SPOOFED_QUERY_URL = 'https://attacker.example/x.png?ref=dev.azure.com';
const SPOOFED_PATH_URL = 'https://attacker.example/dev.azure.com/y.png';
const SPOOFED_SUFFIX_URL = 'https://dev.azure.com.attacker.example/z.png';

/** Build an adapter whose token minting is stubbed, so no `az` process is spawned. */
function makeAdapter() {
  const importer = new AzureDevOpsImporter();
  const getAccessToken = vi.spyOn(importer, 'getAccessToken').mockResolvedValue(ACCESS_TOKEN);
  return { adapter: new AzureDevOpsAdapter(importer), getAccessToken };
}

/** Find the mocked download call for a given URL, so assertions do not depend on batch ordering. */
function optionsForUrl(url: string): { headers?: Record<string, string> } | undefined {
  const call = downloadFileSpy.mock.calls.find(([calledUrl]) => calledUrl === url);
  if (!call) throw new Error(`downloadFile was never called with ${url}`);
  return call[2];
}

beforeEach(() => {
  downloadFileSpy.mockReset();
  downloadFileSpy.mockImplementation(async (url: string, filename: string) => ({
    filename,
    data: 'AAAA',
    mediaType: 'application/octet-stream',
    sizeBytes: 4,
    sourceUrl: url,
  }));
});

describe('isAzureDevOpsAuthedDownloadUrl', () => {
  it('accepts the modern dev.azure.com host', () => {
    expect(isAzureDevOpsAuthedDownloadUrl(MODERN_IMAGE_URL)).toBe(true);
  });

  it('accepts a legacy {org}.visualstudio.com host', () => {
    expect(isAzureDevOpsAuthedDownloadUrl(LEGACY_IMAGE_URL)).toBe(true);
  });

  it('accepts a legacy host regardless of case, since URL lowercases the hostname', () => {
    expect(isAzureDevOpsAuthedDownloadUrl('https://SOA-DCCED.visualstudio.com/x.png')).toBe(true);
  });

  it('accepts an explicit port, because the check reads hostname rather than host', () => {
    expect(isAzureDevOpsAuthedDownloadUrl('https://dev.azure.com:8443/x.png')).toBe(true);
  });

  it('rejects a foreign host that only mentions dev.azure.com in the query string', () => {
    expect(isAzureDevOpsAuthedDownloadUrl(SPOOFED_QUERY_URL)).toBe(false);
  });

  it('rejects a foreign host that only mentions dev.azure.com in the path', () => {
    expect(isAzureDevOpsAuthedDownloadUrl(SPOOFED_PATH_URL)).toBe(false);
  });

  it('rejects a foreign host that uses dev.azure.com as a subdomain prefix', () => {
    expect(isAzureDevOpsAuthedDownloadUrl(SPOOFED_SUFFIX_URL)).toBe(false);
  });

  it('rejects a host that merely ends in visualstudio.com without the dot separator', () => {
    expect(isAzureDevOpsAuthedDownloadUrl('https://evilvisualstudio.com/x.png')).toBe(false);
  });

  it('rejects a bare .visualstudio.com with no org label', () => {
    expect(isAzureDevOpsAuthedDownloadUrl('https://.visualstudio.com/x.png')).toBe(false);
  });

  it('returns false rather than throwing on a relative or malformed URL', () => {
    expect(isAzureDevOpsAuthedDownloadUrl('/relative/x.png')).toBe(false);
    expect(isAzureDevOpsAuthedDownloadUrl('not a url at all')).toBe(false);
    expect(isAzureDevOpsAuthedDownloadUrl('')).toBe(false);
  });
});

describe('AzureDevOpsAdapter.downloadImages - bearer token host gate', () => {
  it('attaches the bearer token to a dev.azure.com image', async () => {
    const { adapter } = makeAdapter();
    await adapter.downloadImages(`![screenshot](${MODERN_IMAGE_URL})`);

    expect(optionsForUrl(MODERN_IMAGE_URL)?.headers?.Authorization).toBe(EXPECTED_AUTHORIZATION);
  });

  it('attaches the bearer token to a legacy visualstudio.com image', async () => {
    const { adapter } = makeAdapter();
    await adapter.downloadImages(`![screenshot](${LEGACY_IMAGE_URL})`);

    expect(optionsForUrl(LEGACY_IMAGE_URL)?.headers?.Authorization).toBe(EXPECTED_AUTHORIZATION);
  });

  it('never mints or sends a token when every image points at a spoofed host', async () => {
    const { adapter, getAccessToken } = makeAdapter();
    await adapter.downloadImages(
      `![a](${SPOOFED_QUERY_URL}) ![b](${SPOOFED_PATH_URL}) ![c](${SPOOFED_SUFFIX_URL})`,
    );

    expect(downloadFileSpy).toHaveBeenCalledTimes(3);
    expect(optionsForUrl(SPOOFED_QUERY_URL)).toBeUndefined();
    expect(optionsForUrl(SPOOFED_PATH_URL)).toBeUndefined();
    expect(optionsForUrl(SPOOFED_SUFFIX_URL)).toBeUndefined();
    // The token is never even requested, which is what proves the needsAuth
    // pre-check reads the host rather than a substring of the whole URL.
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it('authenticates only the real host when a body mixes real and spoofed images', async () => {
    const { adapter, getAccessToken } = makeAdapter();
    await adapter.downloadImages(`![real](${MODERN_IMAGE_URL}) ![fake](${SPOOFED_SUFFIX_URL})`);

    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(optionsForUrl(MODERN_IMAGE_URL)?.headers?.Authorization).toBe(EXPECTED_AUTHORIZATION);
    expect(optionsForUrl(SPOOFED_SUFFIX_URL)).toBeUndefined();
  });

  it('applies the same gate to an HTML img tag', async () => {
    const { adapter } = makeAdapter();
    await adapter.downloadImages(`<img src="${SPOOFED_QUERY_URL}" alt="a"><img src="${MODERN_IMAGE_URL}" alt="b">`);

    expect(optionsForUrl(MODERN_IMAGE_URL)?.headers?.Authorization).toBe(EXPECTED_AUTHORIZATION);
    expect(optionsForUrl(SPOOFED_QUERY_URL)).toBeUndefined();
  });
});

describe('AzureDevOpsAdapter.downloadFileAttachments - bearer token host gate', () => {
  it('attaches the bearer token to an Azure DevOps attachment relation URL', async () => {
    const { adapter } = makeAdapter();
    await adapter.downloadFileAttachments([
      { url: 'https://dev.azure.com/myorg/_apis/wit/attachments/abc?api-version=7.0', filename: 'spec.pdf', sizeBytes: 0 },
    ]);

    const options = optionsForUrl('https://dev.azure.com/myorg/_apis/wit/attachments/abc?api-version=7.0');
    expect(options?.headers?.Authorization).toBe(EXPECTED_AUTHORIZATION);
  });

  it('does not attach the bearer token to a relation URL on a foreign host', async () => {
    const { adapter } = makeAdapter();
    await adapter.downloadFileAttachments([
      { url: 'https://attacker.example/dev.azure.com/spec.pdf', filename: 'spec.pdf', sizeBytes: 0 },
    ]);

    expect(optionsForUrl('https://attacker.example/dev.azure.com/spec.pdf')).toBeUndefined();
  });

  it('never mints a token when every attachment points at a foreign host', async () => {
    const { adapter, getAccessToken } = makeAdapter();
    await adapter.downloadFileAttachments([
      { url: 'https://attacker.example/dev.azure.com/spec.pdf', filename: 'spec.pdf', sizeBytes: 0 },
      { url: 'https://dev.azure.com.attacker.example/notes.pdf', filename: 'notes.pdf', sizeBytes: 0 },
    ]);

    expect(downloadFileSpy).toHaveBeenCalledTimes(2);
    // Mirrors the downloadImages pre-check: an all-foreign batch must not spawn
    // `az` at all, so a signed-out user still gets the unauthenticated downloads
    // instead of a rejection from token minting.
    expect(getAccessToken).not.toHaveBeenCalled();
  });

  it('mints the token once when a batch mixes an Azure DevOps host with a foreign one', async () => {
    const { adapter, getAccessToken } = makeAdapter();
    const azureUrl = 'https://dev.azure.com/myorg/_apis/wit/attachments/abc?api-version=7.0';
    const foreignUrl = 'https://attacker.example/dev.azure.com/spec.pdf';
    await adapter.downloadFileAttachments([
      { url: azureUrl, filename: 'real.pdf', sizeBytes: 0 },
      { url: foreignUrl, filename: 'spec.pdf', sizeBytes: 0 },
    ]);

    expect(getAccessToken).toHaveBeenCalledTimes(1);
    expect(optionsForUrl(azureUrl)?.headers?.Authorization).toBe(EXPECTED_AUTHORIZATION);
    expect(optionsForUrl(foreignUrl)).toBeUndefined();
  });
});

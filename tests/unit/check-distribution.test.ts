/**
 * scripts/check-distribution.mjs, the daily check of what an install and an
 * update depend on outside this repository: the release GitHub calls latest,
 * the npm launcher, the site's star count, and the end dates of the domain and
 * its certificates (.github/workflows/integrations.yml).
 *
 * What goes wrong without each block:
 * - the shipped values: the check keeps asking about a repository, a package,
 *   a site or a relay host the app has left, and stays green;
 * - the release rows: "latest" pointing at an older release, a file that no
 *   longer downloads, or a feed naming another version reads as ok, which is
 *   every installed app no longer updating with nothing on screen;
 * - the npm row: a publish that never happened reads as ok, or one still
 *   running turns the nightly red;
 * - the star count: one slow read of GitHub by the page turns the nightly red,
 *   or a count that is never shown reads as ok;
 * - the end dates: a lapse is found the day it happens.
 *
 * No test here sends a request. The release rows run the real publish gate
 * (scripts/verify-release-assets.js and the two files it requires), served to
 * the script from this checkout the way the released tag would serve them.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { __testing } from '../../scripts/check-distribution.mjs';
import { DOCS_BASE_URL } from '../../src/shared/docs-links';
import { KANGENTIC_HOSTED_RELAY_URL } from '../../src/shared/relay';

const {
  SOURCE_FILES,
  GATE_FILES,
  NPM_GRACE_MS,
  DOMAIN_WARN_DAYS,
  TLS_WARN_DAYS,
  STAR_READ_WAITS_MS,
  readShippedValues,
  compareVersions,
  feedEntries,
  checkRelease,
  checkSiteStars,
  checkDomain,
  checkCertificates,
  runChecks,
  summaryMarkdown,
  main,
} = __testing;

const require = createRequire(import.meta.url);
const { expectedReleaseAssets, CHANNEL_FILES } = require('../../scripts/release-assets.js') as {
  expectedReleaseAssets: (version: string) => string[];
  CHANNEL_FILES: string[];
};

type SendRequest = (url: string, init?: RequestInit) => Promise<Response>;
type Dependencies = Parameters<typeof runChecks>[1];

const REPO_ROOT = path.resolve(__dirname, '../..');
const shipped = readShippedValues(REPO_ROOT, {});
const REPOSITORY = `https://github.com/${shipped.owner}/${shipped.repo}`;

const TAG = 'v1.2.3';
const VERSION = '1.2.3';
const NOW = Date.parse('2026-11-18T00:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

function answer(status: number, body: string | null = null, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

function statusesOf(results: Array<{ status: string }>): string[] {
  return results.map((result) => result.status);
}

function rowOf(results: Array<{ area: string; check: string; status: string; detail: string }>, name: string) {
  const row = results.find(({ area, check }) => `${area} ${check}` === name);
  if (!row) throw new Error(`no row named ${name} among ${results.map(({ area, check }) => `${area} ${check}`).join(', ')}`);
  return row;
}

// ---------------------------------------------------------------------------
// A canned outside world, each part answering the way the real one did on 2026-11-17
// ---------------------------------------------------------------------------

/** An update feed as electron-builder writes one. The Mac feed lists a zip per arch. */
function feedText(name: string, version: string, macZips: string[] = [`Kangentic-${version}-arm64-mac.zip`, `Kangentic-${version}-x64-mac.zip`]): string {
  const files = name === 'latest-mac.yml' ? macZips : [`artifact-for-${name}`];
  return [
    `version: ${version}`,
    'files:',
    ...files.flatMap((file) => [`  - url: ${file}`, '    sha512: c2hhNTEy', '    size: 1']),
    `path: ${files[0] ?? 'none'}`,
    'sha512: c2hhNTEy',
    "releaseDate: '2026-11-17T01:31:38.000Z'",
    '',
  ].join('\n');
}

function atomFeed(entries: Array<{ tag: string; updated: string }>): string {
  const items = entries.map(({ tag, updated }) =>
    `<entry>\n<id>tag:github.com,2008:Repository/1/${tag}</id>\n<updated>${updated}</updated>\n` +
    `<link rel="alternate" type="text/html" href="${REPOSITORY}/releases/tag/${tag}"/>\n<title>${tag}</title>\n</entry>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<feed xmlns="http://www.w3.org/2005/Atom">\n<updated>2026-11-17T01:41:51Z</updated>\n${items.join('\n')}\n</feed>`;
}

function landingPage(chipAttributes: string, count: string): string {
  return `<!doctype html><a class="btn" href="https://github.com/">Star on GitHub<span class="btn-star-count" ${chipAttributes}><span data-count>${count}</span></span></a>`;
}

interface World {
  /** What `releases/latest` redirects to. */
  latestTag: string;
  feed: Array<{ tag: string; updated: string }>;
  /** The files that download, by name. */
  assets: string[];
  /** The status a HEAD of one named file gets in place of the usual answer. */
  headStatus: Record<string, number>;
  feedTexts: Record<string, string>;
  /** The status the gate files answer at the tag. */
  gateStatus: number;
  npm: Response | (() => Response);
  /** The landing page, one answer per read. The last one repeats. */
  pages: Response[];
  rdap: Response | (() => Response);
  certificateEnds: Record<string, Date | Error>;
}

function world(overrides: Partial<World> = {}): World {
  const assets = expectedReleaseAssets(VERSION);
  return {
    latestTag: TAG,
    feed: [
      { tag: TAG, updated: new Date(NOW - 3 * DAY_MS).toISOString() },
      { tag: 'v1.2.2', updated: new Date(NOW - 9 * DAY_MS).toISOString() },
      { tag: 'v1.1.0', updated: new Date(NOW - 30 * DAY_MS).toISOString() },
    ],
    assets,
    headStatus: {},
    feedTexts: Object.fromEntries(CHANNEL_FILES.map((name) => [name, feedText(name, VERSION)])),
    gateStatus: 200,
    npm: answer(200, JSON.stringify({ name: shipped.launcherName, version: VERSION }), { 'content-type': 'application/json' }),
    pages: [answer(200, landingPage('data-github-stars', '142'))],
    rdap: answer(200, JSON.stringify({
      events: [
        { eventAction: 'registration', eventDate: '2026-02-22T19:20:27Z' },
        { eventAction: 'expiration', eventDate: new Date(NOW + 96 * DAY_MS).toISOString() },
      ],
      status: ['client delete prohibited', 'client transfer prohibited'],
    })),
    certificateEnds: {
      [shipped.siteHost]: new Date(NOW + 70 * DAY_MS),
      [shipped.relayHost]: new Date(NOW + 70 * DAY_MS),
    },
    ...overrides,
  };
}

/** The dependencies a run takes, answering from `state`, with every request and wait recorded. */
function dependenciesFor(state: World) {
  const requests: Array<{ url: string; method: string }> = [];
  const waits: number[] = [];
  let pageReads = 0;
  const fresh = (response: Response | (() => Response)) => (typeof response === 'function' ? response() : response.clone());

  const send: SendRequest = async (url, init) => {
    const method = init?.method ?? 'GET';
    requests.push({ url, method });
    if (url === `${REPOSITORY}/releases/latest`) {
      return answer(302, null, { location: `${REPOSITORY}/releases/tag/${state.latestTag}` });
    }
    if (url === `${REPOSITORY}/releases.atom`) return answer(200, atomFeed(state.feed), { 'content-type': 'application/atom+xml' });
    const raw = `https://raw.githubusercontent.com/${shipped.owner}/${shipped.repo}/${state.latestTag}/`;
    if (url.startsWith(raw)) {
      if (state.gateStatus !== 200) return answer(state.gateStatus, 'Not Found');
      return answer(200, fs.readFileSync(path.join(REPO_ROOT, url.slice(raw.length)), 'utf8'));
    }
    const download = `${REPOSITORY}/releases/download/${state.latestTag}/`;
    if (url.startsWith(download)) {
      const name = decodeURIComponent(url.slice(download.length));
      if (method === 'HEAD' && name in state.headStatus) return answer(state.headStatus[name]);
      if (!state.assets.includes(name)) return answer(404, method === 'HEAD' ? null : 'Not Found');
      return answer(302, null, { location: `https://release-assets.example.test/${encodeURIComponent(name)}` });
    }
    if (url.startsWith('https://release-assets.example.test/')) {
      const name = decodeURIComponent(url.slice('https://release-assets.example.test/'.length));
      return name in state.feedTexts ? answer(200, state.feedTexts[name]) : answer(404, 'Not Found');
    }
    if (url.startsWith('https://registry.npmjs.org/')) return fresh(state.npm);
    if (url === `${shipped.site}/`) {
      const page = state.pages[Math.min(pageReads, state.pages.length - 1)];
      pageReads += 1;
      return page.clone();
    }
    if (url.startsWith('https://rdap.')) return fresh(state.rdap);
    throw new Error(`the run asked ${url}, which the check has no reason to ask`);
  };

  const dependencies: Dependencies = {
    send,
    wait: async (milliseconds) => {
      waits.push(milliseconds);
    },
    certificateEndOf: async (host) => {
      const end = state.certificateEnds[host];
      if (end === undefined) throw new Error(`no certificate is canned for ${host}`);
      if (end instanceof Error) throw end;
      return end;
    },
    now: () => NOW,
  };
  return { dependencies, requests, waits };
}

const copies: string[] = [];

/** A temp directory, removed after the test. */
function tempDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'check-distribution-'));
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
  vi.restoreAllMocks();
  for (const root of copies.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('the shipped values it reads', () => {
  it('are what the app, the launcher and the updater use', () => {
    const launcherPackage = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'packages/launcher/package.json'), 'utf8')) as { name: string };
    const launcherSource = fs.readFileSync(path.join(REPO_ROOT, 'packages/launcher/bin/kangentic.js'), 'utf8');
    expect(shipped.launcherName).toBe(launcherPackage.name);
    expect(shipped.site).toBe(DOCS_BASE_URL);
    expect(shipped.siteHost).toBe(new URL(DOCS_BASE_URL).hostname);
    expect(shipped.relayHost).toBe(new URL(KANGENTIC_HOSTED_RELAY_URL).hostname);
    // The release the updater reads is the one the launcher downloads from.
    expect(launcherSource).toContain(`const REPO_OWNER = '${shipped.owner}';`);
    expect(launcherSource).toContain(`const REPO_NAME = '${shipped.repo}';`);
  });

  it('read the same from a checkout with CRLF line endings', () => {
    const windowsCheckout = checkoutWith((_file, text) => text.replace(/\r?\n/g, '\r\n'));
    expect(readShippedValues(windowsCheckout, {})).toEqual(shipped);
  });

  it.each([
    {
      change: 'the publish block pointing somewhere that is not GitHub',
      file: 'electron-builder.yml',
      edit: (text: string) => text.replace(/^( {2}provider: )github$/m, '$1generic'),
      message: 'publish.provider is no longer github in electron-builder.yml',
    },
    {
      change: 'the publish owner gone',
      file: 'electron-builder.yml',
      edit: (text: string) => text.replace(/^ {2}owner: .*\n/m, ''),
      message: 'publish.owner is no longer a key of the publish block in electron-builder.yml',
    },
    {
      change: 'the relay address renamed',
      file: 'src/shared/relay.ts',
      edit: (text: string) => text.replace('export const KANGENTIC_HOSTED_RELAY_URL =', 'export const HOSTED_RELAY ='),
      message: 'KANGENTIC_HOSTED_RELAY_URL is no longer a quoted string in src/shared/relay.ts',
    },
    {
      change: 'the launcher package with no name',
      file: 'packages/launcher/package.json',
      edit: (text: string) => text.replace(/^ {2}"name": "[^"]*",\n/m, ''),
      message: 'name is no longer a package name in packages/launcher/package.json',
    },
    {
      change: 'a file deleted',
      file: 'src/shared/docs-links.ts',
      edit: () => null,
      message: 'src/shared/docs-links.ts is gone',
    },
  ])('throw, naming the value and its file, on $change', ({ file, edit, message }) => {
    const moved = checkoutWith((candidate, text) => (candidate === file ? edit(text) : text));
    expect(() => readShippedValues(moved, {})).toThrow(message);
    // An override never hides a value that moved.
    expect(() => readShippedValues(moved, { DOCS_BASE_URL: 'https://example.test' })).toThrow(message);
  });

  it('take the site from the environment, and treat an empty variable as unset', () => {
    expect(readShippedValues(REPO_ROOT, { DOCS_BASE_URL: ' http://localhost:8788/ ' })).toMatchObject({ site: 'http://localhost:8788', siteHost: 'localhost' });
    expect(readShippedValues(REPO_ROOT, { DOCS_BASE_URL: '   ' })).toEqual(shipped);
  });
});

describe('the release GitHub calls latest', () => {
  const RELEASE_ROWS = ['release latest tag', 'release highest version', 'release assets', 'release feed versions', 'npm launcher'];
  const namesOf = (results: Array<{ area: string; check: string }>) => results.map(({ area, check }) => `${area} ${check}`);

  it('passes when the newest release is whole and npm carries it', async () => {
    const { dependencies, requests } = dependenciesFor(world());
    const results = await checkRelease(shipped, dependencies);
    expect(namesOf(results)).toEqual(RELEASE_ROWS);
    expect(statusesOf(results)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    // Every file the release must carry was asked for by name, and nothing was downloaded but the feeds.
    const heads = requests.filter(({ method }) => method === 'HEAD').map(({ url }) => decodeURIComponent(url.split('/').pop() ?? ''));
    expect(heads.sort()).toEqual([...expectedReleaseAssets(VERSION)].sort());
  });

  it('reads the gate from the released tag, not from this checkout', async () => {
    const { dependencies, requests } = dependenciesFor(world());
    await checkRelease(shipped, dependencies);
    const gateRequests = requests.map(({ url }) => url).filter((url) => url.startsWith('https://raw.githubusercontent.com/'));
    expect(gateRequests.sort()).toEqual(GATE_FILES.map((file) => `https://raw.githubusercontent.com/${shipped.owner}/${shipped.repo}/${TAG}/${file}`).sort());
  });

  it('checks nothing else when GitHub names no release', async () => {
    const { dependencies } = dependenciesFor(world({ latestTag: 'nightly' }));
    const results = await checkRelease(shipped, dependencies);
    expect(namesOf(results)).toEqual(['release latest tag']);
    expect(statusesOf(results)).toEqual(['fail']);
    expect(results[0].detail).toContain('the tag "nightly"');
  });

  it('fails when a higher version is published than the one GitHub calls latest', async () => {
    const feed = [{ tag: 'v1.3.0', updated: new Date(NOW - DAY_MS).toISOString() }, ...world().feed];
    const { dependencies } = dependenciesFor(world({ feed }));
    const row = rowOf(await checkRelease(shipped, dependencies), 'release highest version');
    expect(row.status).toBe('fail');
    expect(row.detail).toContain('v1.3.0 is published and GitHub calls v1.2.3 the latest release');
  });

  it('compares versions by number, and leaves out a tag that is not a plain version', async () => {
    expect(compareVersions('v1.10.0', 'v1.9.9')).toBeGreaterThan(0);
    expect(compareVersions('v2.0.0', 'v10.0.0')).toBeLessThan(0);
    expect(compareVersions('v1.2.3', '1.2.3')).toBe(0);
    // A protocol tag or a prerelease is not a desktop release the updater offers.
    const feed = [{ tag: 'protocol-v9.0.0', updated: '' }, { tag: 'v9.0.0-beta.1', updated: '' }, ...world().feed];
    const { dependencies } = dependenciesFor(world({ feed }));
    expect(rowOf(await checkRelease(shipped, dependencies), 'release highest version').status).toBe('ok');
  });

  it('fails when the release feed does not list the latest release', async () => {
    const { dependencies } = dependenciesFor(world({ feed: [{ tag: 'v1.2.2', updated: '' }] }));
    const row = rowOf(await checkRelease(shipped, dependencies), 'release highest version');
    expect(row.status).toBe('fail');
    expect(row.detail).toContain('does not list v1.2.3');
  });

  it('reads tags and dates out of the feed', () => {
    expect(feedEntries(atomFeed([{ tag: 'v1.2.3', updated: '2026-11-17T01:41:51Z' }]))).toEqual([{ tag: 'v1.2.3', updated: '2026-11-17T01:41:51Z' }]);
    expect(feedEntries('<feed></feed>')).toEqual([]);
  });

  it('fails, naming the file, when one no longer downloads', async () => {
    const gone = `kangentic_${VERSION}_amd64.deb`;
    const { dependencies } = dependenciesFor(world({ assets: expectedReleaseAssets(VERSION).filter((name) => name !== gone) }));
    const results = await checkRelease(shipped, dependencies);
    const row = rowOf(results, 'release assets');
    expect(row.status).toBe('fail');
    expect(row.detail).toContain(gone);
    expect(rowOf(results, 'release feed versions').status).toBe('ok');
  });

  it('fails both rows when an update feed is gone', async () => {
    const { dependencies } = dependenciesFor(world({ assets: expectedReleaseAssets(VERSION).filter((name) => name !== 'latest-linux.yml') }));
    const results = await checkRelease(shipped, dependencies);
    expect(rowOf(results, 'release assets').detail).toContain('updater channel files');
    expect(rowOf(results, 'release feed versions').detail).toContain('latest-linux.yml did not download');
  });

  it('fails when the Mac feed lists one arch, though every file is there', async () => {
    const feedTexts = { ...world().feedTexts, 'latest-mac.yml': feedText('latest-mac.yml', VERSION, [`Kangentic-${VERSION}-arm64-mac.zip`]) };
    const { dependencies } = dependenciesFor(world({ feedTexts }));
    const row = rowOf(await checkRelease(shipped, dependencies), 'release assets');
    expect(row.status).toBe('fail');
    expect(row.detail).toContain(`does not list Kangentic-${VERSION}-x64-mac.zip`);
  });

  it('does not pass a file it could not ask about', async () => {
    const { dependencies } = dependenciesFor(world({ headStatus: { [`Kangentic-Setup-${VERSION}.exe`]: 503 } }));
    const row = rowOf(await checkRelease(shipped, dependencies), 'release assets');
    expect(row.status).toBe('fail');
    expect(row.detail).toContain(`Kangentic-Setup-${VERSION}.exe, which answered 503`);
  });

  it('fails a feed that names another version', async () => {
    const feedTexts = { ...world().feedTexts, 'latest.yml': feedText('latest.yml', '1.2.2') };
    const { dependencies } = dependenciesFor(world({ feedTexts }));
    const row = rowOf(await checkRelease(shipped, dependencies), 'release feed versions');
    expect(row.status).toBe('fail');
    expect(row.detail).toContain('latest.yml names 1.2.2');
  });

  it('fails both file rows, and says why, when the tag carries no gate', async () => {
    const { dependencies } = dependenciesFor(world({ gateStatus: 404 }));
    const results = await checkRelease(shipped, dependencies);
    expect(rowOf(results, 'release assets').status).toBe('fail');
    expect(rowOf(results, 'release feed versions').status).toBe('fail');
    expect(rowOf(results, 'release assets').detail).toContain('at v1.2.3 answered 404');
  });

  /** The canned world, except that `intercept` may answer a URL itself. */
  function withAnswers(intercept: (url: string) => Response | null): Dependencies {
    const { dependencies } = dependenciesFor(world());
    return { ...dependencies, send: async (url, init) => intercept(url) ?? dependencies.send(url, init) };
  }

  it('fails the highest-version row, and keeps the other rows, when the release feed does not answer', async () => {
    const results = await checkRelease(shipped, withAnswers((url) => (url === `${REPOSITORY}/releases.atom` ? answer(503, 'unavailable') : null)));
    expect(namesOf(results)).toEqual(RELEASE_ROWS);
    const row = rowOf(results, 'release highest version');
    expect(row.status).toBe('fail');
    expect(row.detail).toContain('answered 503');
    expect(rowOf(results, 'release assets').status).toBe('ok');
  });

  it('fails when the release feed lists no plain vX.Y.Z release', async () => {
    const { dependencies } = dependenciesFor(world({ feed: [{ tag: 'protocol-v1.0.0', updated: '' }] }));
    const row = rowOf(await checkRelease(shipped, dependencies), 'release highest version');
    expect(row.status).toBe('fail');
    expect(row.detail).toContain('lists no vX.Y.Z release');
  });

  it('fails both file rows, without crashing the run, when a feed download keeps redirecting', async () => {
    const loop = 'https://release-assets.example.test/latest.yml';
    const results = await checkRelease(shipped, withAnswers((url) => (url.startsWith(loop) ? answer(302, null, { location: `${loop}?again` }) : null)));
    expect(namesOf(results)).toEqual(RELEASE_ROWS);
    for (const name of ['release assets', 'release feed versions']) {
      expect(rowOf(results, name).status).toBe('fail');
      expect(rowOf(results, name).detail).toContain('redirected more than three times');
    }
  });

  it('fails both file rows when the gate files at the tag no longer export what the check calls', async () => {
    const gateUrl = `https://raw.githubusercontent.com/${shipped.owner}/${shipped.repo}/${TAG}/scripts/verify-release-assets.js`;
    const results = await checkRelease(shipped, withAnswers((url) => (url === gateUrl ? answer(200, 'module.exports = {};') : null)));
    for (const name of ['release assets', 'release feed versions']) {
      expect(rowOf(results, name).status).toBe('fail');
      expect(rowOf(results, name).detail).toContain('no longer export what this check calls');
    }
  });

  it('reads the latest tag from the JSON body when releases/latest answers 200 instead of redirecting', async () => {
    const results = await checkRelease(shipped, withAnswers((url) => (url === `${REPOSITORY}/releases/latest` ? answer(200, JSON.stringify({ tag_name: TAG })) : null)));
    expect(statusesOf(results)).toEqual(['ok', 'ok', 'ok', 'ok', 'ok']);
    expect(rowOf(results, 'release latest tag').detail).toContain(`GitHub calls ${TAG} the latest release`);
  });

  it('fails the one row, and keeps the rest of the run, when GitHub does not answer', async () => {
    const down: Dependencies = { ...dependenciesFor(world()).dependencies, send: async () => { throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND github.com') }); } };
    const results = await checkRelease(shipped, down);
    expect(namesOf(results)).toEqual(['release latest tag']);
    expect(results[0].detail).toContain('ENOTFOUND github.com');
  });
});

describe('the npm launcher', () => {
  const npmAt = (version: string) => () => answer(200, JSON.stringify({ version }), { 'content-type': 'application/json' });
  const releasedAgo = (milliseconds: number) => [{ tag: TAG, updated: new Date(NOW - milliseconds).toISOString() }, { tag: 'v1.2.2', updated: '' }];

  it('is pending while a new release is young enough for its publish to be running', async () => {
    const { dependencies } = dependenciesFor(world({ npm: npmAt('1.2.2'), feed: releasedAgo(30 * 60_000) }));
    const row = rowOf(await checkRelease(shipped, dependencies), 'npm launcher');
    expect(row.status).toBe('pending');
    expect(row.detail).toContain('30 minutes old');
  });

  it('fails once that time has passed', async () => {
    const { dependencies } = dependenciesFor(world({ npm: npmAt('1.2.2'), feed: releasedAgo(NPM_GRACE_MS + 60_000) }));
    const row = rowOf(await checkRelease(shipped, dependencies), 'npm launcher');
    expect(row.status).toBe('fail');
    expect(row.detail).toContain('installs 1.2.2, and the newest release is 1.2.3');
  });

  it('fails when npm is ahead of the release GitHub calls latest', async () => {
    const { dependencies } = dependenciesFor(world({ npm: npmAt('1.3.0'), feed: releasedAgo(60_000) }));
    expect(rowOf(await checkRelease(shipped, dependencies), 'npm launcher').status).toBe('fail');
  });

  it('fails an answer with no version', async () => {
    const { dependencies } = dependenciesFor(world({ npm: () => answer(404, JSON.stringify({ error: 'Not found' })) }));
    const row = rowOf(await checkRelease(shipped, dependencies), 'npm launcher');
    expect(row.status).toBe('fail');
    expect(row.detail).toContain('npm answered 404 with no version');
  });
});

describe('the star count on the landing page', () => {
  const HIDDEN = () => answer(200, landingPage('data-github-stars hidden', ''));

  it('passes on the first read when the count is shown', async () => {
    const { dependencies, waits } = dependenciesFor(world());
    expect(statusesOf(await checkSiteStars(shipped, dependencies))).toEqual(['ok']);
    expect(waits).toEqual([]);
  });

  it('reads again when the first read came without a count, which a cold cache serves', async () => {
    const { dependencies, waits } = dependenciesFor(world({ pages: [HIDDEN(), answer(200, landingPage('data-github-stars', '1.2k'))] }));
    const results = await checkSiteStars(shipped, dependencies);
    expect(statusesOf(results)).toEqual(['ok']);
    expect(results[0].detail).toContain('1.2k');
    expect(waits).toEqual([STAR_READ_WAITS_MS[1]]);
  });

  it('fails only after every read, having waited out the page\'s own failure cache', async () => {
    const { dependencies, waits } = dependenciesFor(world({ pages: [HIDDEN()] }));
    const results = await checkSiteStars(shipped, dependencies);
    expect(statusesOf(results)).toEqual(['fail']);
    expect(results[0].detail).toContain('the star count is hidden');
    expect(waits).toEqual(STAR_READ_WAITS_MS.slice(1));
    expect(Math.max(...STAR_READ_WAITS_MS)).toBeGreaterThan(60_000);
  });

  it('does not take a class name for the hidden attribute', async () => {
    const { dependencies } = dependenciesFor(world({ pages: [answer(200, landingPage('class="hidden sm:inline" data-github-stars', '87'))] }));
    expect(statusesOf(await checkSiteStars(shipped, dependencies))).toEqual(['ok']);
  });

  it('fails a count that is not a number', async () => {
    const { dependencies } = dependenciesFor(world({ pages: [answer(200, landingPage('data-github-stars', 'NaN'))] }));
    const results = await checkSiteStars(shipped, dependencies);
    expect(statusesOf(results)).toEqual(['fail']);
    expect(results[0].detail).toContain('reads "NaN"');
  });

  it('fails at once, asking for an update, when the page has no count element', async () => {
    const { dependencies, waits } = dependenciesFor(world({ pages: [answer(200, '<!doctype html><a class="btn">Star on GitHub</a>')] }));
    const results = await checkSiteStars(shipped, dependencies);
    expect(statusesOf(results)).toEqual(['fail']);
    expect(results[0].detail).toContain('needs updating');
    expect(waits).toEqual([]);
  });

  it('fails when the site does not serve the page', async () => {
    const { dependencies } = dependenciesFor(world({ pages: [answer(503, 'unavailable')] }));
    const results = await checkSiteStars(shipped, dependencies);
    expect(statusesOf(results)).toEqual(['fail']);
    expect(results[0].detail).toContain('answered 503');
  });
});

describe('the domain and its certificates', () => {
  const registeredFor = (days: number, status: string[] = []) => () => answer(200, JSON.stringify({
    events: [{ eventAction: 'expiration', eventDate: new Date(NOW + days * DAY_MS + 60_000).toISOString() }],
    status,
  }));

  it('passes a registration with more days left than the threshold, and fails one at it', async () => {
    const comfortable = dependenciesFor(world({ rdap: registeredFor(DOMAIN_WARN_DAYS + 1) })).dependencies;
    const close = dependenciesFor(world({ rdap: registeredFor(DOMAIN_WARN_DAYS) })).dependencies;
    expect(statusesOf(await checkDomain(shipped, comfortable))).toEqual(['ok']);
    const results = await checkDomain(shipped, close);
    expect(statusesOf(results)).toEqual(['fail']);
    expect(results[0].detail).toContain(`${DOMAIN_WARN_DAYS} days from now`);
  });

  it('fails a domain its registry already holds for deletion, whatever its date says', async () => {
    const { dependencies } = dependenciesFor(world({ rdap: registeredFor(300, ['redemption period']) }));
    const results = await checkDomain(shipped, dependencies);
    expect(statusesOf(results)).toEqual(['fail']);
    expect(results[0].detail).toContain('redemption period');
  });

  it('fails a registry that has no such domain, or gives no date', async () => {
    expect(statusesOf(await checkDomain(shipped, dependenciesFor(world({ rdap: () => answer(404) })).dependencies))).toEqual(['fail']);
    expect(statusesOf(await checkDomain(shipped, dependenciesFor(world({ rdap: () => answer(200, '{"events":[]}') })).dependencies))).toEqual(['fail']);
  });

  it('asks the registry about the registered domain, not a host under it', async () => {
    const { dependencies, requests } = dependenciesFor(world());
    await checkDomain({ ...shipped, siteHost: `www.${shipped.siteHost}` }, dependencies);
    expect(requests.map(({ url }) => url)).toEqual([`https://rdap.verisign.com/com/v1/domain/${shipped.siteHost}`]);
  });

  it('fails, asking for a registry address, on a top-level domain it has none for', async () => {
    const { dependencies, requests } = dependenciesFor(world());
    const results = await checkDomain({ ...shipped, siteHost: 'kangentic.example' }, dependencies);
    expect(statusesOf(results)).toEqual(['fail']);
    expect(results[0].detail).toContain('no RDAP server is listed for .example');
    expect(requests).toEqual([]);
  });

  it('passes a certificate with more days left than the threshold, and fails one at it', async () => {
    const certificateEnds = {
      [shipped.siteHost]: new Date(NOW + (TLS_WARN_DAYS + 1) * DAY_MS + 60_000),
      [shipped.relayHost]: new Date(NOW + TLS_WARN_DAYS * DAY_MS + 60_000),
    };
    const results = await checkCertificates(shipped, dependenciesFor(world({ certificateEnds })).dependencies);
    expect(results.map(({ check, status }) => `${check} ${status}`)).toEqual(['tls site ok', 'tls relay fail']);
    expect(results[1].detail).toContain(shipped.relayHost);
  });

  it('fails a host whose certificate is refused, and still reads the other', async () => {
    const certificateEnds = { [shipped.siteHost]: new Error('certificate has expired'), [shipped.relayHost]: new Date(NOW + 70 * DAY_MS) };
    const results = await checkCertificates(shipped, dependenciesFor(world({ certificateEnds })).dependencies);
    expect(statusesOf(results)).toEqual(['fail', 'ok']);
    expect(results[0].detail).toContain('certificate has expired');
  });
});

describe('the run', () => {
  const CHECKS = [
    'release latest tag',
    'release highest version',
    'release assets',
    'release feed versions',
    'npm launcher',
    'site hero stars',
    'domain registration',
    'domain tls site',
    'domain tls relay',
  ];

  it('passes with a row per check, in table order, when everything outside is as it should be', async () => {
    const results = await runChecks(shipped, dependenciesFor(world()).dependencies);
    expect(results.map(({ area, check }) => `${area} ${check}`)).toEqual(CHECKS);
    expect(statusesOf(results)).toEqual(CHECKS.map(() => 'ok'));
  });

  it('keeps every area and check name inside the table\'s columns', async () => {
    const results = await runChecks(shipped, dependenciesFor(world()).dependencies);
    for (const { area, check } of results) {
      expect(area.length, area).toBeLessThan(8);
      expect(check.length, check).toBeLessThan(16);
    }
  });

  it('names the repository and the site in the summary, and says so when neither was read', () => {
    const rows = [{ area: 'npm', check: 'launcher', status: 'ok' as const, detail: 'fine' }];
    expect(summaryMarkdown(rows, shipped)).toContain(`Release: ${shipped.owner}/${shipped.repo}. Site: ${shipped.site}`);
    expect(summaryMarkdown(rows, shipped)).toContain('| ok | npm | launcher | fine |');
    expect(summaryMarkdown(rows, null)).toContain('Values: not read');
  });
});

describe('main', () => {
  function printedLines(): string[] {
    return vi.mocked(console.log).mock.calls.map((call) => String(call[0]));
  }

  it('returns 0 and prints a row per check when every answer is good', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await main({ repoRoot: REPO_ROOT, env: {}, dependencies: dependenciesFor(world()).dependencies })).toBe(0);
    const lines = printedLines();
    expect(lines).toHaveLength(10);
    expect(lines[0]).toMatch(/^ok\s+release\s+latest tag\s+GitHub calls v1\.2\.3 the latest release$/);
    expect(lines.at(-1)).toBe('\nNo check failed.');
  });

  it('returns 1, counts the failure, and writes the annotation and summary in GitHub Actions', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const summaryFile = path.join(tempDirectory(), 'summary.md');
    const dependencies = dependenciesFor(world({ pages: [answer(200, landingPage('data-github-stars hidden', ''))] })).dependencies;
    expect(await main({ repoRoot: REPO_ROOT, env: { GITHUB_ACTIONS: 'true', GITHUB_STEP_SUMMARY: summaryFile }, dependencies })).toBe(1);
    const lines = printedLines();
    expect(lines.at(-1)).toBe('\n1 check failed.');
    expect(lines.some((line) => line.startsWith('::error title=site hero stars::'))).toBe(true);
    const summary = fs.readFileSync(summaryFile, 'utf8');
    expect(summary).toContain('## Distribution check');
    expect(summary).toContain('| fail | site | hero stars |');
  });

  it('fails with one row, and asks nothing, when a source file is gone', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { dependencies, requests } = dependenciesFor(world());
    const root = checkoutWith((file, text) => (file === 'src/shared/relay.ts' ? null : text));
    expect(await main({ repoRoot: root, env: {}, dependencies })).toBe(1);
    const lines = printedLines();
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^fail\s+desktop\s+shipped values\s+.*No probe ran\.$/);
    expect(requests).toEqual([]);
  });

  it('runs when the file is run, and its return becomes the exit status', () => {
    const root = tempDirectory();
    for (const file of ['scripts/check-distribution.mjs', 'scripts/lib/is-entrypoint.mjs', 'scripts/lib/check-report.mjs']) {
      fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      fs.copyFileSync(path.join(REPO_ROOT, file), path.join(root, file));
    }
    const env = { ...process.env };
    delete env.GITHUB_ACTIONS;
    delete env.GITHUB_STEP_SUMMARY;
    // No source file exists in the copy, so nothing is read and no request is sent.
    const run = spawnSync(process.execPath, [path.join(root, 'scripts/check-distribution.mjs')], { encoding: 'utf8', env, timeout: 30_000 });
    expect(run.status).toBe(1);
    expect(run.stdout).toMatch(/desktop\s+shipped values/);
  });
});

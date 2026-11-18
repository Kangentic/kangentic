/**
 * Checks what an install and an update depend on outside this repository, and
 * what lapses on a date: the release GitHub calls latest, the npm launcher, the
 * site's star count, and the end dates of the domain and its certificates.
 * .github/workflows/integrations.yml runs it every day beside
 * scripts/check-integrations.mjs, and `npm run check:distribution` runs it by
 * hand. It holds no secret and needs no install. Every probe is a request a
 * stranger could make.
 *
 * None of these can break in a pull request, and none had anyone watching:
 * - release, latest tag: the tag `releases/latest` redirects to, which is how
 *   electron-updater finds the release to offer.
 * - release, highest version: no published release is newer than that tag. A
 *   release re-created for an older tag can take "latest" back, and every
 *   installed app then stops at the older version with nothing on screen.
 * - release, assets: every file the release must carry still downloads, and
 *   latest-mac.yml lists a zip for each Mac arch. It is the publish gate's own
 *   decision (`verifyReleaseAssets` in scripts/verify-release-assets.js), run
 *   again against what is public today. The npm launcher downloads these names.
 * - release, feed versions: each update feed names the release's own version.
 * - npm, launcher: `npx kangentic` installs the newest release. The launcher
 *   sends no telemetry, so a publish that failed was seen by nobody.
 * - site, hero stars: the landing page shows its star count. The page's
 *   Function reads it as a GitHub App, and when that read fails it serves the
 *   plain button and writes one line to a log nobody tails.
 * - domain, registration and tls: the end dates of the domain and of the
 *   certificates the site and the relay serve. The site, the relay and two
 *   sign-ins stop together when one lapses.
 *
 * The expected asset list is read from the released tag, not from this
 * checkout. Main's list (scripts/release-assets.js) describes the next release,
 * so a change to it would turn the row red until that release shipped. The
 * three gate files are fetched from the tag into a temp folder and loaded from
 * there. They need nothing but Node's own modules and each other.
 *
 * The values it reads from this checkout are in SOURCE_FILES, and
 * tests/unit/check-distribution.test.ts holds each equal to its source. Set
 * DOCS_BASE_URL in the environment to point the site check at another origin.
 *
 * Any answer not named in a check fails it, and so does no answer at all. Exits
 * 1 when any check fails. In GitHub Actions it also writes the step summary, an
 * `::error` annotation per failure and a `::notice` per pending check.
 */
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import tls from 'node:tls';
import { fileURLToPath } from 'node:url';
import { isEntrypoint } from './lib/is-entrypoint.mjs';
import {
  TIMEOUT_MS,
  annotationLines,
  exitCodeFor,
  markdownCell,
  messageOf,
  result,
  sendRequest,
  singleLine,
  snippet,
  summaryTable,
  tableLines,
} from './lib/check-report.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT_NAME = 'scripts/check-distribution.mjs';

const BUILDER_FILE = 'electron-builder.yml';
const LAUNCHER_FILE = 'packages/launcher/package.json';
const DOCS_LINKS_FILE = 'src/shared/docs-links.ts';
const RELAY_FILE = 'src/shared/relay.ts';

/** Every file a value is read from. The workflow's path filter names each of them. */
const SOURCE_FILES = [BUILDER_FILE, LAUNCHER_FILE, DOCS_LINKS_FILE, RELAY_FILE];

/** The publish gate and what it requires, fetched from the released tag. */
const GATE_FILES = ['scripts/release-assets.js', 'scripts/merge-mac-update-feeds.js', 'scripts/verify-release-assets.js'];

/** release.yml publishes to npm after the GitHub release, so npm may trail a new release this long. */
const NPM_GRACE_MS = 2 * 60 * 60 * 1000;
/**
 * Red this many days before the domain's registration ends. Below the registrar's own auto-renew
 * lead (about 14 days, by a third party's account of it), so a domain with auto-renew on never
 * reaches it, and one with auto-renew off does.
 */
const DOMAIN_WARN_DAYS = 10;
/**
 * Red this many days before a certificate ends. Both hosts serve 90-day certificates that are
 * replaced about 30 days before their end, so one this close has stopped renewing.
 */
const TLS_WARN_DAYS = 14;
/**
 * When to read the landing page, in milliseconds after the read before. The page's Function gives
 * GitHub 800 ms and serves the plain button past that, while the read finishes behind it and fills
 * the cache, so a second read a few seconds on shows the count. A failed read is cached for 60
 * seconds, which the third read waits out.
 */
const STAR_READ_WAITS_MS = [0, 5_000, 65_000, 5_000];
/** Where each top-level domain's registry answers RDAP. */
const RDAP_BY_TLD = { com: 'https://rdap.verisign.com/com/v1/domain/' };

const DAY_MS = 24 * 60 * 60 * 1000;
const PLAIN_TAG = /^v(\d+)\.(\d+)\.(\d+)$/;

/** @typedef {import('./lib/check-report.mjs').Result} Result */
/** @typedef {import('./lib/check-report.mjs').SendRequest} SendRequest */
/**
 * @typedef {object} ShippedValues
 * @property {string} owner The GitHub owner the app's updater reads releases from.
 * @property {string} repo
 * @property {string} launcherName The npm package `npx` runs.
 * @property {string} site The site's origin, with no trailing slash.
 * @property {string} siteHost
 * @property {string} relayHost
 */
/**
 * @typedef {object} Dependencies
 * @property {SendRequest} send
 * @property {(milliseconds: number) => Promise<void>} wait
 * @property {(host: string) => Promise<Date>} certificateEndOf
 * @property {() => number} now
 */

// ---------------------------------------------------------------------------
// The values this checkout ships
// ---------------------------------------------------------------------------

function readSource(repoRoot, file) {
  let text;
  try {
    text = fs.readFileSync(path.join(repoRoot, file), 'utf8');
  } catch (problem) {
    if (problem?.code === 'ENOENT') {
      throw new Error(`${file} is gone. Update ${SCRIPT_NAME} to read its values where they went.`, { cause: problem });
    }
    throw new Error(`${file} could not be read (${problem?.code ?? 'no error code'}).`, { cause: problem });
  }
  return text.replace(/\r\n/g, '\n');
}

function moved(name, file, shape) {
  return new Error(`${name} is no longer ${shape} in ${file}. Update ${SCRIPT_NAME} to read it where it went.`);
}

function stringConstant(source, file, name) {
  const match = new RegExp(`^export const ${name}(?:: [^=\\n]+)? = '([^'\\\\]*)';$`, 'm').exec(source);
  if (!match) throw moved(name, file, 'a quoted string');
  return match[1];
}

/** One key of electron-builder.yml's top-level `publish:` block. */
function publishKey(source, key) {
  const block = /^publish:\n((?: {2}\S.*\n?)+)/m.exec(source)?.[1] ?? '';
  const value = new RegExp(`^ {2}${key}: (\\S+)$`, 'm').exec(block)?.[1];
  if (!value) throw moved(`publish.${key}`, BUILDER_FILE, 'a key of the publish block');
  return value;
}

/**
 * Everything the probes need, read from `repoRoot`. Throws when a value is gone or written another
 * way, naming it and its file.
 *
 * @param {string} [repoRoot]
 * @param {Record<string, string | undefined>} [env]
 * @returns {ShippedValues}
 */
function readShippedValues(repoRoot = REPO_ROOT, env = process.env) {
  const builder = readSource(repoRoot, BUILDER_FILE);
  if (publishKey(builder, 'provider') !== 'github') throw moved('publish.provider', BUILDER_FILE, 'github');

  let launcherName;
  try {
    launcherName = JSON.parse(readSource(repoRoot, LAUNCHER_FILE)).name;
  } catch (problem) {
    if (problem instanceof SyntaxError) throw new Error(`${LAUNCHER_FILE} is not JSON.`, { cause: problem });
    throw problem;
  }
  if (typeof launcherName !== 'string' || launcherName === '') throw moved('name', LAUNCHER_FILE, 'a package name');

  // The constant is read even when the environment overrides it, so a moved one never hides behind an override.
  const shippedSite = stringConstant(readSource(repoRoot, DOCS_LINKS_FILE), DOCS_LINKS_FILE, 'DOCS_BASE_URL');
  const site = (env.DOCS_BASE_URL?.trim() || shippedSite).replace(/\/+$/, '');
  const relayUrl = stringConstant(readSource(repoRoot, RELAY_FILE), RELAY_FILE, 'KANGENTIC_HOSTED_RELAY_URL');
  if (!URL.canParse(site)) throw moved('DOCS_BASE_URL', DOCS_LINKS_FILE, 'a URL');
  if (!URL.canParse(relayUrl)) throw moved('KANGENTIC_HOSTED_RELAY_URL', RELAY_FILE, 'a URL');

  return {
    owner: publishKey(builder, 'owner'),
    repo: publishKey(builder, 'repo'),
    launcherName,
    site,
    siteHost: new URL(site).hostname,
    relayHost: new URL(relayUrl).hostname,
  };
}

// ---------------------------------------------------------------------------
// Reading GitHub the way a browser and the updater do
// ---------------------------------------------------------------------------

function repositoryUrl(values) {
  return `https://github.com/${values.owner}/${values.repo}`;
}

/** `sendRequest` never follows a redirect, so a download is followed here, a few hops at most. */
async function sendFollowing(send, url, init) {
  let target = url;
  for (let hop = 0; hop < 4; hop++) {
    const answer = await send(target, init);
    const location = answer.headers.get('location');
    if (answer.status < 300 || answer.status >= 400 || !location) return answer;
    target = new URL(location, target).toString();
  }
  throw new Error(`${url} redirected more than three times`);
}

/** Positive when `left` is the higher version, by its three numbers. */
function compareVersions(left, right) {
  const numbers = (version) => version.replace(/^v/, '').split('.').map(Number);
  const [a, b] = [numbers(left), numbers(right)];
  for (let index = 0; index < 3; index++) {
    if (a[index] !== b[index]) return a[index] - b[index];
  }
  return 0;
}

/** Each release in GitHub's Atom feed, newest first: its tag and when it was last updated. */
function feedEntries(atom) {
  return atom.split('<entry>').slice(1).map((entry) => ({
    tag: decodeURIComponent(/\/releases\/tag\/([^"<\s]+)"/.exec(entry)?.[1] ?? ''),
    updated: /<updated>([^<]+)<\/updated>/.exec(entry)?.[1] ?? '',
  }));
}

/**
 * The publish gate as the released tag carries it. The three files are written to a temp folder
 * and required from there, then the folder is removed.
 */
async function loadReleaseGate(values, tag, send) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-release-gate-'));
  try {
    for (const file of GATE_FILES) {
      const answer = await send(`https://raw.githubusercontent.com/${values.owner}/${values.repo}/${tag}/${file}`);
      if (answer.status !== 200) throw new Error(`${file} at ${tag} answered ${answer.status}`);
      fs.writeFileSync(path.join(directory, path.basename(file)), await answer.text());
    }
    const requireFromTag = createRequire(path.join(directory, 'gate.cjs'));
    const { expectedReleaseAssets, CHANNEL_FILES } = requireFromTag('./release-assets.js');
    const { verifyReleaseAssets } = requireFromTag('./verify-release-assets.js');
    if (typeof expectedReleaseAssets !== 'function' || !Array.isArray(CHANNEL_FILES) || typeof verifyReleaseAssets !== 'function') {
      throw new Error(`the gate files at ${tag} no longer export what this check calls`);
    }
    return { expectedReleaseAssets, channelFiles: CHANNEL_FILES, verifyReleaseAssets };
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/**
 * The release rows and the npm row, which all start from the tag GitHub calls latest.
 *
 * @param {ShippedValues} values
 * @param {Dependencies} dependencies
 * @returns {Promise<Result[]>}
 */
async function checkRelease(values, dependencies) {
  const { send } = dependencies;
  const area = 'release';
  let tag = '';
  try {
    const answer = await send(`${repositoryUrl(values)}/releases/latest`, { headers: { Accept: 'application/json' } });
    if (answer.status >= 300 && answer.status < 400) {
      tag = decodeURIComponent((answer.headers.get('location') ?? '').split('/releases/tag/')[1] ?? '');
    } else if (answer.status === 200) {
      const body = await answer.json().catch(() => ({}));
      tag = typeof body?.tag_name === 'string' ? body.tag_name : '';
    }
    if (!PLAIN_TAG.test(tag)) {
      const seen = tag ? `the tag "${snippet(tag)}"` : `${answer.status} and no tag`;
      return [result(area, 'latest tag', 'fail', `GitHub's releases/latest answered ${seen}, so the assets, the feeds and the npm launcher were not checked`)];
    }
  } catch (problem) {
    return [result(area, 'latest tag', 'fail', `no answer from GitHub, so nothing about the release was checked: ${messageOf(problem)}`)];
  }

  const latest = result(area, 'latest tag', 'ok', `GitHub calls ${tag} the latest release`);
  const [feed, files] = await Promise.all([checkHighestVersion(values, tag, send), checkReleaseFiles(values, tag, send)]);
  const launcher = await checkLauncher(values, tag, feed.publishedAt, dependencies);
  return [latest, feed.row, ...files, launcher];
}

/** @returns {Promise<{ row: Result, publishedAt: number | null }>} */
async function checkHighestVersion(values, tag, send) {
  const area = 'release';
  const check = 'highest version';
  try {
    const answer = await send(`${repositoryUrl(values)}/releases.atom`);
    if (answer.status !== 200) return { row: result(area, check, 'fail', `the release feed answered ${answer.status}`), publishedAt: null };
    const entries = feedEntries(await answer.text());
    const updated = Date.parse(entries.find((entry) => entry.tag === tag)?.updated ?? '');
    const publishedAt = Number.isNaN(updated) ? null : updated;
    const plain = entries.map((entry) => entry.tag).filter((candidate) => PLAIN_TAG.test(candidate));
    if (plain.length === 0) return { row: result(area, check, 'fail', 'the release feed lists no vX.Y.Z release'), publishedAt };
    const highest = plain.reduce((best, candidate) => (compareVersions(candidate, best) > 0 ? candidate : best));
    if (highest === tag) return { row: result(area, check, 'ok', `${tag} is the highest of the ${plain.length} newest releases`), publishedAt };
    if (compareVersions(highest, tag) > 0) {
      return { row: result(area, check, 'fail', `${highest} is published and GitHub calls ${tag} the latest release, so installed apps stop at ${tag}`), publishedAt };
    }
    return { row: result(area, check, 'fail', `the release feed does not list ${tag}, which GitHub calls the latest release`), publishedAt };
  } catch (problem) {
    return { row: result(area, check, 'fail', `no answer from GitHub's release feed: ${messageOf(problem)}`), publishedAt: null };
  }
}

/** @returns {Promise<Result[]>} The assets row and the feed versions row. */
async function checkReleaseFiles(values, tag, send) {
  const area = 'release';
  const version = tag.replace(/^v/, '');
  const downloadUrl = (name) => `${repositoryUrl(values)}/releases/download/${tag}/${encodeURIComponent(name)}`;
  try {
    const gate = await loadReleaseGate(values, tag, send);
    const expected = gate.expectedReleaseAssets(version);

    // A file that downloads answers with a redirect to its storage. One that is gone answers 404.
    const downloads = (status) => status === 200 || (status >= 300 && status < 400);
    const heads = await Promise.all(expected.map(async (name) => ({ name, status: (await send(downloadUrl(name), { method: 'HEAD' })).status })));
    const present = heads.filter(({ status }) => downloads(status)).map(({ name }) => name);
    // Neither a download nor a 404 says nothing about the file, so it cannot pass as either.
    const unreadable = heads.filter(({ status }) => !downloads(status) && status !== 404);

    const feedTexts = new Map();
    await Promise.all(gate.channelFiles.filter((name) => present.includes(name)).map(async (name) => {
      const answer = await sendFollowing(send, downloadUrl(name));
      if (answer.status === 200) feedTexts.set(name, await answer.text());
    }));

    const release = { id: 0, draft: false, assets: present.map((name) => ({ id: 0, name, state: 'uploaded' })) };
    const verdict = gate.verifyReleaseAssets([release], tag, (asset) => {
      const text = feedTexts.get(asset.name);
      if (text === undefined) throw new Error(`${asset.name} did not download`);
      return text;
    });
    let assets;
    if (unreadable.length > 0) {
      const sample = unreadable[0];
      assets = result(area, 'assets', 'fail', `${unreadable.length} of ${expected.length} files could not be checked, such as ${sample.name}, which answered ${sample.status}`);
    } else if (verdict.ok) {
      assets = result(area, 'assets', 'ok', `all ${expected.length} files of ${tag} download, and latest-mac.yml lists a zip for each Mac arch`);
    } else {
      assets = result(area, 'assets', 'fail', verdict.problems.join(' '));
    }

    const wrong = gate.channelFiles.flatMap((name) => {
      const text = feedTexts.get(name);
      if (text === undefined) return [`${name} did not download`];
      const feedVersion = /^version:\s*(\S+)\s*$/m.exec(text)?.[1] ?? '';
      return feedVersion === version ? [] : [`${name} names ${feedVersion ? snippet(feedVersion) : 'no version'}`];
    });
    const feeds = wrong.length === 0
      ? result(area, 'feed versions', 'ok', `the ${gate.channelFiles.length} update feeds name ${version}`)
      : result(area, 'feed versions', 'fail', `${wrong.join(', ')}, and the release is ${version}, so those platforms are not offered it`);
    return [assets, feeds];
  } catch (problem) {
    const detail = `the files of ${tag} were not checked: ${messageOf(problem)}`;
    return [result(area, 'assets', 'fail', detail), result(area, 'feed versions', 'fail', detail)];
  }
}

/**
 * @param {ShippedValues} values
 * @param {string} tag
 * @param {number | null} publishedAt When the release was last updated, by the feed.
 * @param {Dependencies} dependencies
 * @returns {Promise<Result>}
 */
async function checkLauncher(values, tag, publishedAt, { send, now }) {
  const area = 'npm';
  const check = 'launcher';
  const version = tag.replace(/^v/, '');
  try {
    const answer = await send(`https://registry.npmjs.org/${encodeURIComponent(values.launcherName)}/latest`, { headers: { Accept: 'application/json' } });
    const body = await answer.json().catch(() => ({}));
    const published = typeof body?.version === 'string' ? body.version : '';
    if (answer.status !== 200 || !/^\d+\.\d+\.\d+$/.test(published)) {
      return result(area, check, 'fail', `npm answered ${answer.status} ${published ? `"${snippet(published)}"` : 'with no version'} for ${values.launcherName}`);
    }
    if (published === version) return result(area, check, 'ok', `npx ${values.launcherName} installs ${version}, the newest release`);
    const age = publishedAt === null ? null : now() - publishedAt;
    if (compareVersions(published, version) < 0 && age !== null && age >= 0 && age < NPM_GRACE_MS) {
      return result(area, check, 'pending', `npm is still at ${published} and ${tag} is ${Math.round(age / 60_000)} minutes old, so its publish may still be running`);
    }
    return result(area, check, 'fail', `npx ${values.launcherName} installs ${published}, and the newest release is ${version}`);
  } catch (problem) {
    return result(area, check, 'fail', `no answer from npm: ${messageOf(problem)}`);
  }
}

/**
 * @param {ShippedValues} values
 * @param {Dependencies} dependencies
 * @returns {Promise<Result[]>}
 */
async function checkSiteStars(values, { send, wait }) {
  const area = 'site';
  const check = 'hero stars';
  let last = 'the page was never read';
  for (const delay of STAR_READ_WAITS_MS) {
    if (delay > 0) await wait(delay);
    try {
      const answer = await send(`${values.site}/`);
      if (answer.status !== 200) {
        last = `${values.site}/ answered ${answer.status}`;
        continue;
      }
      const html = await answer.text();
      const chip = /<[a-z0-9]+\b[^>]*\sdata-github-stars\b[^>]*>/i.exec(html)?.[0];
      if (!chip) {
        return [result(area, check, 'fail', `${values.site}/ has no data-github-stars element, so the hero changed and ${SCRIPT_NAME} needs updating`)];
      }
      // An attribute's value could hold the word, so the values are dropped before looking for the attribute.
      const hidden = /\shidden\b/i.test(chip.replace(/"[^"]*"|'[^']*'/g, '""'));
      const count = (/\sdata-count\b[^>]*>([^<]*)</i.exec(html)?.[1] ?? '').trim();
      if (!hidden && /^(\d{1,3}|\d+(\.\d)?k)$/.test(count)) return [result(area, check, 'ok', `the hero shows ${count} stars`)];
      last = hidden
        ? 'the star count is hidden, which is what the page serves when its GitHub App read fails'
        : `the star count reads "${snippet(count)}"`;
    } catch (problem) {
      last = `no answer from ${values.site}: ${messageOf(problem)}`;
    }
  }
  return [result(area, check, 'fail', `${last}, on each of ${STAR_READ_WAITS_MS.length} reads`)];
}

function wholeDays(milliseconds) {
  return Math.floor(milliseconds / DAY_MS);
}

function dayOf(time) {
  return new Date(time).toISOString().slice(0, 10);
}

/**
 * @param {ShippedValues} values
 * @param {Dependencies} dependencies
 * @returns {Promise<Result[]>}
 */
async function checkDomain(values, { send, now }) {
  const area = 'domain';
  const check = 'registration';
  const domain = values.siteHost.split('.').slice(-2).join('.');
  const topLevel = domain.split('.').pop() ?? '';
  const registry = RDAP_BY_TLD[topLevel];
  if (!registry) return [result(area, check, 'fail', `no RDAP server is listed for .${topLevel}. Add one to RDAP_BY_TLD in ${SCRIPT_NAME}`)];
  try {
    const answer = await send(registry + domain, { headers: { Accept: 'application/rdap+json' } });
    if (answer.status === 404) return [result(area, check, 'fail', `the registry has no ${domain}`)];
    const body = await answer.json().catch(() => ({}));
    const events = Array.isArray(body?.events) ? body.events : [];
    const expires = Date.parse(events.find((event) => event?.eventAction === 'expiration')?.eventDate ?? '');
    if (answer.status !== 200 || Number.isNaN(expires)) return [result(area, check, 'fail', `the registry answered ${answer.status} with no expiration date for ${domain}`)];
    const statuses = (Array.isArray(body.status) ? body.status : []).map((status) => String(status).toLowerCase());
    const lapsed = statuses.find((status) => status === 'redemption period' || status === 'pending delete');
    if (lapsed) return [result(area, check, 'fail', `${domain} is in "${lapsed}" at its registry`)];
    const days = wholeDays(expires - now());
    if (days > DOMAIN_WARN_DAYS) return [result(area, check, 'ok', `${domain} is registered until ${dayOf(expires)}, ${days} days from now`)];
    return [result(area, check, 'fail', `${domain}'s registration ends on ${dayOf(expires)}, ${days} days from now, and has not renewed`)];
  } catch (problem) {
    return [result(area, check, 'fail', `no answer from the registry for ${domain}: ${messageOf(problem)}`)];
  }
}

/**
 * @param {ShippedValues} values
 * @param {Dependencies} dependencies
 * @returns {Promise<Result[]>}
 */
async function checkCertificates(values, { certificateEndOf, now }) {
  const area = 'domain';
  const hosts = [
    { check: 'tls site', host: values.siteHost },
    { check: 'tls relay', host: values.relayHost },
  ];
  return Promise.all(hosts.map(async ({ check, host }) => {
    try {
      const end = (await certificateEndOf(host)).getTime();
      const days = wholeDays(end - now());
      if (days > TLS_WARN_DAYS) return result(area, check, 'ok', `${host}'s certificate is good until ${dayOf(end)}, ${days} days from now`);
      return result(area, check, 'fail', `${host}'s certificate ends on ${dayOf(end)}, ${days} days from now, and has not been replaced`);
    } catch (problem) {
      return result(area, check, 'fail', `${host} did not complete a TLS handshake: ${messageOf(problem)}`);
    }
  }));
}

/**
 * Every check at once. The order of the list is the order of the table.
 *
 * @param {ShippedValues} values
 * @param {Dependencies} dependencies
 * @returns {Promise<Result[]>}
 */
async function runChecks(values, dependencies) {
  const groups = await Promise.all([
    checkRelease(values, dependencies),
    checkSiteStars(values, dependencies),
    checkDomain(values, dependencies),
    checkCertificates(values, dependencies),
  ]);
  return groups.flat();
}

// ---------------------------------------------------------------------------
// The real world
// ---------------------------------------------------------------------------

/** When the certificate `host` serves on port 443 ends. A certificate that is not valid rejects. */
function certificateEndOf(host) {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host, port: 443, servername: host, timeout: TIMEOUT_MS }, () => {
      const validTo = socket.getPeerCertificate().valid_to;
      socket.end();
      const end = new Date(validTo);
      if (Number.isNaN(end.getTime())) reject(new Error(`the certificate's end date reads "${validTo}"`));
      else resolve(end);
    });
    socket.once('timeout', () => socket.destroy(new Error(`no handshake within ${TIMEOUT_MS / 1000} seconds`)));
    socket.once('error', reject);
  });
}

/** @type {Dependencies} */
const REAL_DEPENDENCIES = {
  send: sendRequest,
  wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  certificateEndOf,
  now: () => Date.now(),
};

/** The step summary: one table row per check. */
function summaryMarkdown(results, values) {
  const about = values ? `Release: ${markdownCell(`${values.owner}/${values.repo}`)}. Site: ${markdownCell(values.site)}` : 'Values: not read';
  return ['## Distribution check', '', about, '', ...summaryTable(results), ''].join('\n');
}

/**
 * Reads the shipped values, runs every check and prints the result. Returns the exit code and
 * leaves setting it to the caller.
 *
 * @param {{ repoRoot?: string, env?: Record<string, string | undefined>, dependencies?: Partial<Dependencies> }} [options]
 * @returns {Promise<number>}
 */
async function main({ repoRoot = REPO_ROOT, env = process.env, dependencies = {} } = {}) {
  let values = null;
  let results;
  try {
    values = readShippedValues(repoRoot, env);
  } catch (problem) {
    results = [result('desktop', 'shipped values', 'fail', `${problem instanceof Error ? problem.message : String(problem)} No probe ran.`)];
  }
  if (values) results = await runChecks(values, { ...REAL_DEPENDENCIES, ...dependencies });

  for (const line of tableLines(results)) console.log(line);

  if (env.GITHUB_ACTIONS === 'true') {
    for (const line of annotationLines(results)) console.log(line);
    if (env.GITHUB_STEP_SUMMARY) fs.appendFileSync(env.GITHUB_STEP_SUMMARY, summaryMarkdown(results, values));
  }

  const failed = results.filter(({ status }) => status === 'fail').length;
  console.log(failed > 0 ? `\n${failed} check${failed === 1 ? '' : 's'} failed.` : '\nNo check failed.');
  return exitCodeFor(results);
}

export const __testing = {
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
};

if (isEntrypoint(import.meta.url)) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((problem) => {
      console.error(`[check-distribution] FAILED: ${singleLine(problem instanceof Error ? problem.message : String(problem))}`);
      process.exit(1);
    });
}

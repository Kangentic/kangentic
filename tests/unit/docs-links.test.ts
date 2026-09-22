/**
 * Every link from the app into the docs site is built from one base URL
 * (src/shared/docs-links.ts). Before that constant existed, five shipped link
 * sites each carried their own copy and they did not agree: WelcomeScreen and
 * MobileDevicesTab used the `www` host while mcp-tool-manifest.ts and
 * announcements.json used the apex, with the same `/mobile/` page linked both
 * ways. Nothing was broken (neither host redirects), but a docs move had to
 * find all five by grep and each new link picked whichever host its author had
 * last seen.
 *
 * Four checks:
 *   1. the base is the canonical apex, with no `www` and no trailing slash
 *   2. the five contract paths are pinned, so a rename is a deliberate edit
 *   3. no source file outside docs-links.ts spells out a docs URL
 *   4. announcements.json, which no import can reach, uses the apex host
 *
 * Where this stops: the scan covers src/ and announcements.json only. Prose in
 * docs/, README.md, and .claude/ can drift back to the `www` host and nothing
 * here catches it. That is deliberate (README is marketing-facing and stays on
 * `www` on purpose), but it means docs prose is review-only, not mechanically
 * held.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { DOCS_BASE_URL, DOCS_URLS } from '../../src/shared/docs-links';
import { hasOptOutMarker } from './helpers/opt-out-marker';

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCAN_DIR = 'src';
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.css']);

/** The one file allowed to spell out a docs URL. */
const DEFINITION_FILE = 'src/shared/docs-links.ts';

/**
 * A docs link, not any mention of the domain. Requiring the scheme is what
 * keeps three legitimate non-link uses out of the scan: `wss://relay.kangentic.com`
 * (a different host and scheme), `support@kangentic.com` (a contact address),
 * and the schemeless prose in handler-helpers.ts and index.css.
 */
const DOCS_URL_PATTERN = /https?:\/\/(?:www\.)?kangentic\.com/;

const OK_MARKER = 'docs-link-ok';

/**
 * Files that opt out, pinned rather than merely tolerated. An unbounded marker
 * escape drifts into a blanket suppression nobody notices; naming the set here
 * means a second opt-out has to be argued for in a diff.
 */
const EXPECTED_MARKED_FILES = ['src/devtools/main/seed-git-changes.ts'];

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function toPosix(relativePath: string): string {
  return relativePath.replace(/\\/g, '/');
}

interface ScanResult {
  /** Unmarked docs URLs: `<relative path>:<line> <line text>`. */
  violations: string[];
  /** Relative paths that carry at least one `docs-link-ok` escape. */
  markedFiles: string[];
  filesScanned: number;
}

function scanSources(): ScanResult {
  const violations: string[] = [];
  const markedFiles = new Set<string>();
  const files = collectSourceFiles(path.join(REPO_ROOT, SCAN_DIR));

  for (const file of files) {
    const relativePath = toPosix(path.relative(REPO_ROOT, file));
    if (relativePath === DEFINITION_FILE) continue;

    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (!DOCS_URL_PATTERN.test(line)) return;
      if (hasOptOutMarker(lines, index, OK_MARKER)) {
        markedFiles.add(relativePath);
        return;
      }
      violations.push(`${relativePath}:${index + 1} ${line.trim()}`);
    });
  }

  return { violations, markedFiles: [...markedFiles].sort(), filesScanned: files.length };
}

describe('DOCS_BASE_URL', () => {
  it('is the canonical apex host, with no www and no trailing slash', () => {
    // Asserted as a literal rather than by regex so a regression prints the
    // value that broke it.
    expect(DOCS_BASE_URL).toBe('https://kangentic.com');
  });

  it('pins the five URLs the website treats as contracts', () => {
    // The site owes these paths. A rename should be a deliberate two-sided
    // edit, not a silent one. The sixth half of the contract, the
    // `#kangentic_<tool>` anchor form, is pinned by mcp-tool-docs-url.test.ts;
    // do not add a third assertion for it here.
    expect(DOCS_URLS).toEqual({
      gettingStarted: 'https://kangentic.com/getting-started/',
      mobile: 'https://kangentic.com/mobile/',
      mobilePairing: 'https://kangentic.com/mobile/pairing/',
      relay: 'https://kangentic.com/relay/',
      mcpServer: 'https://kangentic.com/mcp-server/',
    });
  });

  it('builds every contract URL from the base', () => {
    for (const [name, url] of Object.entries(DOCS_URLS)) {
      expect(url.startsWith(`${DOCS_BASE_URL}/`), `${name} must be built from DOCS_BASE_URL`).toBe(true);
      expect(url.endsWith('/'), `${name} must keep its trailing slash`).toBe(true);
    }
  });
});

describe('docs links in src/', () => {
  const scan = scanSources();

  it('has no docs URL spelled out outside src/shared/docs-links.ts', () => {
    expect(
      scan.violations,
      'Build these from DOCS_URLS (src/shared/docs-links.ts), or mark the line '
        + '// docs-link-ok: <reason> when the host is incidental to what the code does.',
    ).toEqual([]);
  });

  it('carries exactly the opt-outs that were argued for', () => {
    expect(scan.markedFiles).toEqual(EXPECTED_MARKED_FILES);
  });

  it('actually scans the source tree', () => {
    // Without this the whole describe passes vacuously when a path or
    // extension typo makes collectSourceFiles return nothing, which is the
    // failure mode a scan like this has.
    expect(scan.filesScanned).toBeGreaterThan(100);
    expect(fs.existsSync(path.join(REPO_ROOT, DEFINITION_FILE))).toBe(true);
  });

  it('detects a docs URL when one is present', () => {
    // Drives the detector over known-bad source, so a pattern edit that stops
    // matching is caught rather than reading as a clean tree.
    expect(DOCS_URL_PATTERN.test("const url = 'https://www.kangentic.com/relay/';")).toBe(true);
    expect(DOCS_URL_PATTERN.test("const url = 'https://kangentic.com/mobile/';")).toBe(true);
    // And stays off the three legitimate non-link uses.
    expect(DOCS_URL_PATTERN.test("export const RELAY = 'wss://relay.kangentic.com';")).toBe(false);
    expect(DOCS_URL_PATTERN.test("const EMAIL = 'support@kangentic.com';")).toBe(false);
    expect(DOCS_URL_PATTERN.test(' * a bare "kangentic" does not match "kangentic.com"')).toBe(false);
  });

});

describe('announcements.json', () => {
  // Hand-authored data served from raw.githubusercontent, so it cannot import
  // DOCS_URLS. It is also the highest-stakes link surface in the repo: an edit
  // on `main` reaches every released client within about four hours, with no
  // release and nothing between it and real users but a normal PR. That is why
  // its links are constrained here rather than merely host-checked.
  const feedSource = fs.readFileSync(path.join(REPO_ROOT, 'announcements.json'), 'utf8');
  const docsLinks = feedSource.match(/https?:\/\/(?:www\.)?kangentic\.com[^"\s]*/g) ?? [];

  it('links the docs site on the apex host', () => {
    expect(docsLinks.length, 'no kangentic.com link found, so this assertion proves nothing').toBeGreaterThan(0);
    for (const link of docsLinks) {
      expect(link.startsWith(`${DOCS_BASE_URL}/`), `${link} must use the apex host`).toBe(true);
    }
  });

  it('links only pages the site treats as contracts', () => {
    // A dead path here is the `/docs/` bug with a live audience. The feed cannot
    // import DOCS_URLS, so matching against it at commit time is the substitute,
    // and it needs no network so it cannot flake. Linking a genuinely new page
    // means adding it to DOCS_URLS first, which is the conversation this forces:
    // the site then owes that URL the same stability as the other five.
    const contractUrls = new Set<string>([...Object.values(DOCS_URLS), `${DOCS_BASE_URL}/`]);
    for (const link of docsLinks) {
      expect(
        contractUrls.has(link),
        `${link} is not a contract URL. Add it to DOCS_URLS (and have the site commit to it) `
          + 'before shipping it to every installed client.',
      ).toBe(true);
    }
  });

  it('rejects a link the contract set does not name', () => {
    // Same construction as the test above, against a fixture link instead of the
    // feed: today's feed carries only contract URLs, so that test alone would
    // pass even if the membership check were swapped for a loose prefix match.
    // The comment above names /docs/ as exactly that bug, with a live audience.
    const contractUrls = new Set<string>([...Object.values(DOCS_URLS), `${DOCS_BASE_URL}/`]);
    expect(contractUrls.has('https://kangentic.com/docs/')).toBe(false);
  });
});

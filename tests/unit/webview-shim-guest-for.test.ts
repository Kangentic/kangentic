/**
 * `demo/webview-shim.js`'s `guestFor(url)` resolves what a `<webview>`'s iframe should load: the
 * exact key in `window.__demoGuestPages`, the same URL with its trailing slash normalized on, or
 * null. The `browser` scene (tests/captures/scenes.ts) exercises only the exact-key path today,
 * because the sample install's own `dev_url` (tests/captures/helpers/demo-dataset.ts) already
 * carries a trailing slash: the shim's iframe mounts (and its `ready` selector passes)
 * identically whether `guestFor` resolves the real guest page or falls through to about:blank, so
 * a demo-tier pass proves nothing about the normalization branch.
 *
 * `guestFor` has no DOM dependency (it only reads the `pages` closure variable), so it is
 * extracted straight out of the shim's own text and built with `new Function`, the way
 * demo-message-trail-replay.test.ts extracts functions out of the generated seed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEMO_PROJECTS, PROJECT_CONTOSO } from '../captures/helpers/demo-dataset';

const WEBVIEW_SHIM_PATH = path.resolve(__dirname, '..', '..', 'demo', 'webview-shim.js');
const WEBVIEW_SHIM_SOURCE = fs.readFileSync(WEBVIEW_SHIM_PATH, 'utf-8');

type GuestForFunction = (url: string) => string | null;

/**
 * The real source of `function guestFor(url) { ... }` inside demo/webview-shim.js, brace-balanced
 * from the first `{` after the marker. Throws rather than returning an empty string when the
 * marker is not found, so a rename cannot make every test below vacuously pass on an empty
 * function body (mirrors demo-message-trail-replay.test.ts's extractFunction).
 */
function extractGuestFor(): string {
  const marker = 'function guestFor(';
  const start = WEBVIEW_SHIM_SOURCE.indexOf(marker);
  if (start === -1) throw new Error(`no "${marker}" found in demo/webview-shim.js`);
  const open = WEBVIEW_SHIM_SOURCE.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < WEBVIEW_SHIM_SOURCE.length; index += 1) {
    if (WEBVIEW_SHIM_SOURCE[index] === '{') depth += 1;
    if (WEBVIEW_SHIM_SOURCE[index] === '}') {
      depth -= 1;
      if (depth === 0) return WEBVIEW_SHIM_SOURCE.slice(start, index + 1);
    }
  }
  throw new Error('unbalanced function guestFor in demo/webview-shim.js');
}

function buildGuestFor(pages: Record<string, string>): GuestForFunction {
  const factory = new Function('pages', `${extractGuestFor()}\nreturn guestFor;`) as (
    injectedPages: Record<string, string>,
  ) => GuestForFunction;
  return factory(pages);
}

describe('guestFor() extracted from demo/webview-shim.js', () => {
  // The real dev_url the sample install seeds, rather than a hand-typed literal: if it ever loses
  // its trailing slash, this test should start exercising the normalization branch from the exact
  // key path instead of silently testing nothing new.
  const contosoDevUrl = DEMO_PROJECTS.find((project) => project.id === PROJECT_CONTOSO)?.dev_url;
  if (!contosoDevUrl) {
    throw new Error('contoso-web has no dev_url in DEMO_PROJECTS; update this test to a project that has one');
  }

  it('returns null for a falsy url', () => {
    const guestFor = buildGuestFor({ [contosoDevUrl]: 'contoso-web.html' });
    expect(guestFor('')).toBeNull();
  });

  it('resolves an exact key hit', () => {
    const guestFor = buildGuestFor({ [contosoDevUrl]: 'contoso-web.html' });
    expect(guestFor(contosoDevUrl)).toBe('contoso-web.html');
  });

  it('resolves a url missing the trailing slash the seed key carries', () => {
    const guestFor = buildGuestFor({ [contosoDevUrl]: 'contoso-web.html' });
    const withoutTrailingSlash = contosoDevUrl.replace(/\/+$/, '');
    // Vacuity guard: the real dev_url does carry a trailing slash today, so this exercises the
    // normalization branch rather than the exact-key path above.
    expect(withoutTrailingSlash).not.toBe(contosoDevUrl);
    expect(guestFor(withoutTrailingSlash)).toBe('contoso-web.html');
  });

  it('returns null for a url no page map entry matches', () => {
    const guestFor = buildGuestFor({ [contosoDevUrl]: 'contoso-web.html' });
    expect(guestFor('http://localhost:9999/')).toBeNull();
  });
});

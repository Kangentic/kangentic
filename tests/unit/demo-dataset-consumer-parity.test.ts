/**
 * The sample install has TWO consumers, and a field wired into one of them reaches nobody else.
 *
 * `buildDemoPreConfig` seeds both the web demo (demo/vite.config.mts, deployed to Pages on every
 * release) and the marketing captures (tests/captures/helpers/marketing-fixture.ts, the PNGs the
 * site ships). They are built by different commands on different schedules, so a field added to one
 * call site and forgotten at the other produces two marketing artifacts that disagree, with nothing
 * failing anywhere. That nearly happened with `messageTrails`: the web demo had it first, and the
 * captures would have gone on showing task descriptions with no test to say so.
 *
 * So the two option sets are pinned against each other, and every deliberate difference is named.
 *
 * This is a STATIC scan of both call sites rather than a runtime comparison, because the web demo's
 * side lives inside a Vite config's local `buildSeedScript` and is not exported or callable here.
 * The vacuity guards below are what stop a regex that stopped matching from passing silently.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEMO_CONFIG = path.join(REPO_ROOT, 'demo', 'vite.config.mts');
const MARKETING_FIXTURE = path.join(REPO_ROOT, 'tests', 'captures', 'helpers', 'marketing-fixture.ts');
const DATASET = path.join(REPO_ROOT, 'tests', 'captures', 'helpers', 'demo-dataset.ts');

/**
 * Options the web demo passes and the captures deliberately do not.
 *
 * The rig has no recordings index, so no session clock ever runs and a peek timeline would be dead
 * weight in the seed. A capture also shoots one fixed moment, and a Monitor peek that moved on a
 * timer would make the PNGs differ every run. See the comment in marketing-fixture.ts.
 */
const DEMO_ONLY_OPTIONS = new Set(['peekTimelines']);

/** Options the captures pass and the web demo deliberately does not. None today. */
const MARKETING_ONLY_OPTIONS = new Set<string>([]);

/** The body of the first `buildDemoPreConfig({ ... })` call in `source`, brace-balanced. */
function callBody(source: string, where: string): string {
  const callIndex = source.indexOf('buildDemoPreConfig({');
  if (callIndex === -1) throw new Error(`no buildDemoPreConfig call found in ${where}`);
  const open = source.indexOf('{', callIndex);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, index);
    }
  }
  throw new Error(`unbalanced buildDemoPreConfig call in ${where}`);
}

/**
 * The top-level option names an object literal body passes, shorthand or `key: value`.
 *
 * Split on commas rather than matching delimiters in one pass: a pattern that CONSUMES the comma
 * before a key cannot then match the key after it, so `a, b, c` yields only every other one. That
 * bug is why this splits first and reads a leading identifier out of each segment.
 */
function optionKeys(body: string): Set<string> {
  const flat = body
    // Nested literals and call arguments first, so an inner key cannot read as an option and an
    // argument comma cannot split a segment.
    .replace(/\{[^{}]*\}/g, '{}')
    .replace(/\([^()]*\)/g, '()')
    .replace(/`[^`]*`/g, "''");
  const keys = new Set<string>();
  for (const segment of flat.split(',')) {
    const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*(?::|$)/.exec(segment);
    if (match) keys.add(match[1]);
  }
  return keys;
}

/** Every option `buildDemoPreConfig` declares, so a typo at a call site cannot hide as a difference. */
function declaredOptions(): Set<string> {
  const source = fs.readFileSync(DATASET, 'utf-8');
  const start = source.indexOf('export function buildDemoPreConfig(options: {');
  if (start === -1) throw new Error('buildDemoPreConfig signature not found');
  const open = source.indexOf('{', start);
  const end = source.indexOf('} = {}', open);
  if (end === -1) throw new Error('buildDemoPreConfig signature end not found');
  const names = new Set<string>();
  for (const match of source.slice(open + 1, end).matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:/gm)) {
    names.add(match[1]);
  }
  return names;
}

describe('both sample-install consumers are seeded from the same options', () => {
  const demoKeys = optionKeys(callBody(fs.readFileSync(DEMO_CONFIG, 'utf-8'), 'demo/vite.config.mts'));
  const marketingKeys = optionKeys(callBody(fs.readFileSync(MARKETING_FIXTURE, 'utf-8'), 'marketing-fixture.ts'));
  const declared = declaredOptions();

  it('parses a plausible option set from each call site', () => {
    // Without this a regex that stopped matching would make every assertion below vacuously true.
    expect(demoKeys.size).toBeGreaterThan(5);
    expect(marketingKeys.size).toBeGreaterThan(5);
    expect(declared.size).toBeGreaterThan(5);
  });

  it('passes only options buildDemoPreConfig declares', () => {
    const unknownInDemo = [...demoKeys].filter((key) => !declared.has(key));
    const unknownInMarketing = [...marketingKeys].filter((key) => !declared.has(key));
    expect(unknownInDemo, 'demo/vite.config.mts passes an option the dataset does not declare').toEqual([]);
    expect(unknownInMarketing, 'marketing-fixture.ts passes an option the dataset does not declare').toEqual([]);
  });

  it('gives the captures every option the web demo gets, minus the named exceptions', () => {
    const missingFromMarketing = [...demoKeys].filter((key) => !marketingKeys.has(key) && !DEMO_ONLY_OPTIONS.has(key));
    expect(
      missingFromMarketing,
      'the web demo seeds these and the marketing captures do not, so the site\'s embed and its '
      + 'screenshots would disagree. Add them to buildMarketingPreConfig, or to DEMO_ONLY_OPTIONS with the reason',
    ).toEqual([]);
  });

  it('gives the web demo every option the captures get, minus the named exceptions', () => {
    const missingFromDemo = [...marketingKeys].filter((key) => !demoKeys.has(key) && !MARKETING_ONLY_OPTIONS.has(key));
    expect(
      missingFromDemo,
      'the marketing captures seed these and the web demo does not. Add them to buildSeedScript in '
      + 'demo/vite.config.mts, or to MARKETING_ONLY_OPTIONS with the reason',
    ).toEqual([]);
  });

  it('keeps no stale exception', () => {
    const stale = [
      ...[...DEMO_ONLY_OPTIONS].filter((key) => !demoKeys.has(key) || marketingKeys.has(key)),
      ...[...MARKETING_ONLY_OPTIONS].filter((key) => !marketingKeys.has(key) || demoKeys.has(key)),
    ];
    expect(stale, 'these are no longer a real divergence; drop them from the exception sets').toEqual([]);
  });
});

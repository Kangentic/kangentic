import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * `scripts/measure-embedding-models.mjs` copies the search cutoff by hand
 * (`const SEARCH_CUTOFF = ...`, with a comment naming `SEMANTIC_RELEVANCE_CUTOFF` in
 * `src/main/retrieval/memory-search.ts`). The script is plain Node and cannot import
 * the app, so nothing but that comment kept the two equal. The noise floors the script
 * calibrates and prints are the share of unrelated text kept at that cutoff, so a
 * cutoff that drifted from the app's would leave a model's `noiseFloor` calibrated for
 * a filter the app does not run.
 *
 * This reads the script as text and holds its value to the app's.
 */

// memory-search.ts imports the project database and the agent registry. Importing the
// constant runs neither, so both are stubbed as in memory-search-relevance.test.ts.
vi.mock('../../src/main/db/database', () => ({
  getProjectDb: vi.fn(() => {
    throw new Error('getProjectDb should not be called');
  }),
}));

vi.mock('../../src/main/agent/agent-registry', () => ({
  agentRegistry: { getBySessionType: () => undefined },
}));

import { SEMANTIC_RELEVANCE_CUTOFF } from '../../src/main/retrieval/memory-search';

const REPO_ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SCRIPT_FILE = 'scripts/measure-embedding-models.mjs';

describe(`${SCRIPT_FILE} search cutoff`, () => {
  const source = fs.readFileSync(path.join(REPO_ROOT, SCRIPT_FILE), 'utf8');
  const match = /const\s+SEARCH_CUTOFF\s*=\s*([0-9]*\.?[0-9]+)\s*;/.exec(source);

  it('declares SEARCH_CUTOFF as a number literal this test can read', () => {
    // A renamed constant or a computed value matches nothing, and the comparison below
    // would otherwise pass against NaN or undefined.
    expect(match, `no "const SEARCH_CUTOFF = <number>;" in ${SCRIPT_FILE}`).not.toBeNull();
    expect(Number.isFinite(Number(match![1]))).toBe(true);
  });

  it('equals SEMANTIC_RELEVANCE_CUTOFF, the cutoff the app filters semantic hits at', () => {
    expect(Number(match?.[1])).toBe(SEMANTIC_RELEVANCE_CUTOFF);
  });
});

/**
 * Pins the hand-maintained parity between src/shared/types.ts's
 * MOBILE_CAPABILITY_VERBS and @kangentic/protocol's CAPABILITY_VERBS.
 *
 * src/shared/types.ts is deliberately import-free (a dependency-free leaf
 * module - see its own comment above MOBILE_CAPABILITY_VERBS), so it cannot
 * import CapabilityVerb from the protocol package and mirrors the union by
 * hand instead. That comment says "keep MOBILE_CAPABILITY_VERBS in sync ...
 * by hand" with zero mechanical enforcement before this test: a future verb
 * added to the protocol package (or renamed) would silently desync the
 * renderer's type from the wire protocol, and the mismatch would only
 * surface as a confusing runtime cast failure, not a build error.
 *
 * The third hand-maintained copy is `FULL_CAPABILITY_SET` in the UI tier's
 * mock bridge (tests/ui/mock-electron-api.js), which seeds every mock-paired
 * device's grant. The web demo runs on that mock, so a verb missing there is
 * a device the demo shows as narrower than a real pairing would be. The mock
 * is plain script with the array inside a closure, so it is read as text.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { MOBILE_CAPABILITY_VERBS } from '../../src/shared/types';
import { CAPABILITY_VERBS } from '../../packages/protocol/src/capabilities/verbs';

const MOCK_BRIDGE_PATH = path.join(__dirname, '..', 'ui', 'mock-electron-api.js');

function readMockFullCapabilitySet(): string[] {
  const source = fs.readFileSync(MOCK_BRIDGE_PATH, 'utf-8');
  const match = source.match(/FULL_CAPABILITY_SET\s*=\s*\[([\s\S]*?)\];/);
  if (!match) throw new Error(`FULL_CAPABILITY_SET literal not found in ${MOCK_BRIDGE_PATH}`);
  return Array.from(match[1].matchAll(/'([^']+)'/g), (entry) => entry[1]);
}

describe('MOBILE_CAPABILITY_VERBS <-> protocol CAPABILITY_VERBS parity', () => {
  it('has the exact same members, in the same order, as the protocol package', () => {
    expect(MOBILE_CAPABILITY_VERBS).toEqual(CAPABILITY_VERBS);
  });

  it('has no shell, file, or arbitrary-command verb (mirrors the protocol-side guarantee)', () => {
    const suspicious = MOBILE_CAPABILITY_VERBS.filter((verb) => /shell|file|exec|command|run/i.test(verb));
    expect(suspicious).toEqual([]);
  });

  it("the UI mock's FULL_CAPABILITY_SET grants exactly the protocol's verbs", () => {
    const mockSet = readMockFullCapabilitySet();
    // A guard against the regex matching an empty or truncated literal.
    expect(mockSet.length).toBeGreaterThan(0);
    expect(new Set(mockSet)).toEqual(new Set(CAPABILITY_VERBS));
    expect(mockSet).toHaveLength(CAPABILITY_VERBS.length);
  });
});

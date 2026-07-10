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
 */
import { describe, it, expect } from 'vitest';
import { MOBILE_CAPABILITY_VERBS } from '../../src/shared/types';
import { CAPABILITY_VERBS } from '../../packages/protocol/src/capabilities/verbs';

describe('MOBILE_CAPABILITY_VERBS <-> protocol CAPABILITY_VERBS parity', () => {
  it('has the exact same members, in the same order, as the protocol package', () => {
    expect(MOBILE_CAPABILITY_VERBS).toEqual(CAPABILITY_VERBS);
  });

  it('has no shell, file, or arbitrary-command verb (mirrors the protocol-side guarantee)', () => {
    const suspicious = MOBILE_CAPABILITY_VERBS.filter((verb) => /shell|file|exec|command|run/i.test(verb));
    expect(suspicious).toEqual([]);
  });
});

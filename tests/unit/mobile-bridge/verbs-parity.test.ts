/**
 * src/shared/types.ts is deliberately import-free, so MOBILE_CAPABILITY_VERBS
 * hand-mirrors @kangentic/protocol's CAPABILITY_VERBS rather than importing
 * it (see the comment on MOBILE_CAPABILITY_VERBS). This test is the
 * mechanical guard against that mirror drifting: a verb added to one tuple
 * without the other fails here instead of surfacing as a silent runtime gap
 * between what the desktop bridge can grant and what the renderer/IPC layer
 * can express.
 */
import { describe, it, expect } from 'vitest';
import { CAPABILITY_VERBS } from '@kangentic/protocol';
import { MOBILE_CAPABILITY_VERBS } from '../../../src/shared/types';

describe('mobile capability verb parity', () => {
  it('MOBILE_CAPABILITY_VERBS matches @kangentic/protocol CAPABILITY_VERBS exactly', () => {
    expect(new Set(MOBILE_CAPABILITY_VERBS)).toEqual(new Set(CAPABILITY_VERBS));
    expect(MOBILE_CAPABILITY_VERBS.length).toBe(CAPABILITY_VERBS.length);
  });
});

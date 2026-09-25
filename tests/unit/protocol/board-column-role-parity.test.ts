/**
 * @kangentic/protocol cannot import src/shared/types.ts (it is a
 * dependency-light leaf shared with the phone), so `BOARD_COLUMN_ROLES` is a
 * deliberate hand-mirror of the desktop's `SWIMLANE_ROLES` rather than an
 * import, the same shape as `MOBILE_CAPABILITY_VERBS` mirroring
 * `CAPABILITY_VERBS` (see verbs-parity.test.ts). This is the mechanical
 * guard against that mirror drifting: a role added to one list without the
 * other fails here instead of surfacing as a silent gap between what the
 * wire's `isTodoRole` / `isDoneRole` recognize and what the desktop actually
 * emits.
 */
import { describe, it, expect } from 'vitest';
import { BOARD_COLUMN_ROLES } from '@kangentic/protocol';
import { SWIMLANE_ROLES } from '../../../src/shared/types';

describe('board column role parity', () => {
  it('BOARD_COLUMN_ROLES matches src/shared/types.ts SWIMLANE_ROLES exactly', () => {
    expect(new Set(BOARD_COLUMN_ROLES)).toEqual(new Set(SWIMLANE_ROLES));
    expect(BOARD_COLUMN_ROLES.length).toBe(SWIMLANE_ROLES.length);
  });
});

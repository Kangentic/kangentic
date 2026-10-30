/**
 * Unit test for toActivityReasonWire's idle/permission mapping
 * (src/main/mobile-bridge/handlers/wire-mappers.ts).
 *
 * The idle/tool/subagent/turn-active kinds fall through to a bare
 * `return reason;` ('background-shell' needs an explicit spread to strip the
 * desktop's `readonly` array qualifier). That pass-through relies on
 * `ActivityReasonWire`'s `since` being OPTIONAL so the desktop's required
 * `since: number` is structurally assignable without a mapper change - this
 * pins that `since` really does ride along unchanged.
 *
 * `permission` is built field by field, because the desktop reason carries a
 * `waitKind` the wire does not define. A pass-through would hand it to the
 * phone, and `isActivityReasonWire` ignores extra keys, so nothing else fails.
 */
import { describe, it, expect } from 'vitest';
import { toActivityReasonWire } from '../../../src/main/mobile-bridge/handlers/wire-mappers';
import type { ActivityReason } from '../../../src/shared/types';

describe('toActivityReasonWire', () => {
  it('carries since through unchanged for idle', () => {
    const reason: ActivityReason = { kind: 'idle', since: 1700000000000 };
    expect(toActivityReasonWire(reason)).toEqual({ kind: 'idle', since: 1700000000000 });
  });

  it('carries since through unchanged for permission', () => {
    const reason: ActivityReason = { kind: 'permission', since: 1700000000000 };
    expect(toActivityReasonWire(reason)).toEqual({ kind: 'permission', since: 1700000000000 });
  });

  it('keeps the desktop-only waitKind off the wire', () => {
    const question: ActivityReason = { kind: 'permission', since: 1700000000000, waitKind: 'question' };
    const approval: ActivityReason = { kind: 'permission', since: 1700000000000, waitKind: 'approval' };
    expect(toActivityReasonWire(question)).toStrictEqual({ kind: 'permission', since: 1700000000000 });
    expect(toActivityReasonWire(approval)).toStrictEqual({ kind: 'permission', since: 1700000000000 });
  });
});

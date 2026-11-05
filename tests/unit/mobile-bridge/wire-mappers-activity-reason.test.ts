/**
 * Unit test for toActivityReasonWire's idle/permission mapping
 * (src/main/mobile-bridge/handlers/wire-mappers.ts).
 *
 * The tool/subagent/turn-active kinds fall through to a bare `return reason;`
 * ('background-shell' needs an explicit spread to strip the desktop's
 * `readonly` array qualifier). `idle` is built by hand, so its desktop-only
 * flags stay off the wire, and `since` rides along unchanged.
 *
 * `permission` is built field by field: the wire carries the wait's kind
 * (protocol 0.26.0) when the agent reported one, and no `waitKind` key at all
 * when it did not.
 */
import { describe, it, expect } from 'vitest';
import { toActivityReasonWire } from '../../../src/main/mobile-bridge/handlers/wire-mappers';
import type { ActivityReason } from '../../../src/shared/types';

describe('toActivityReasonWire', () => {
  it('carries since through unchanged for idle', () => {
    const reason: ActivityReason = { kind: 'idle', since: 1700000000000 };
    expect(toActivityReasonWire(reason)).toEqual({ kind: 'idle', since: 1700000000000 });
  });

  it('leaves the desktop\'s stopped flag off, since the protocol does not define it', () => {
    const reason: ActivityReason = { kind: 'idle', since: 1700000000000, stopped: true };
    expect(toActivityReasonWire(reason)).toStrictEqual({ kind: 'idle', since: 1700000000000 });
  });

  it('leaves the desktop\'s inOwnCall flag off too, since the protocol does not define it either', () => {
    const reason: ActivityReason = { kind: 'idle', since: 1700000000000, inOwnCall: true };
    expect(toActivityReasonWire(reason)).toStrictEqual({ kind: 'idle', since: 1700000000000 });
  });

  it('carries since through unchanged for permission, with no waitKind when the agent did not say', () => {
    const reason: ActivityReason = { kind: 'permission', since: 1700000000000 };
    expect(toActivityReasonWire(reason)).toStrictEqual({ kind: 'permission', since: 1700000000000 });
  });

  it('carries the wait kind to the phone', () => {
    const question: ActivityReason = { kind: 'permission', since: 1700000000000, waitKind: 'question' };
    const approval: ActivityReason = { kind: 'permission', since: 1700000000000, waitKind: 'approval' };
    expect(toActivityReasonWire(question)).toStrictEqual({ kind: 'permission', since: 1700000000000, waitKind: 'question' });
    expect(toActivityReasonWire(approval)).toStrictEqual({ kind: 'permission', since: 1700000000000, waitKind: 'approval' });
  });
});

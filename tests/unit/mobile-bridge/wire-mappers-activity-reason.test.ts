/**
 * Unit test for toActivityReasonWire's idle/permission pass-through
 * (src/main/mobile-bridge/handlers/wire-mappers.ts).
 *
 * The idle/permission/tool/subagent/turn-active kinds all fall through to a
 * bare `return reason;` (only 'background-shell' needs an explicit spread,
 * to strip the desktop's `readonly` array qualifier). That pass-through
 * relies on `ActivityReasonWire`'s `since` being OPTIONAL so the desktop's
 * required `since: number` is structurally assignable without a mapper
 * change - this pins that `since` really does ride along unchanged, so a
 * future "explicit per-kind mapping" refactor of the default branch cannot
 * silently drop it.
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
});

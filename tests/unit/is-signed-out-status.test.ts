import { describe, it, expect } from 'vitest';
import { isSignedOutStatus } from '../../src/shared/agent-accounts';

describe('isSignedOutStatus', () => {
  it('reads signed-out and replaced as signed out', () => {
    expect(isSignedOutStatus('signed-out')).toBe(true);
    expect(isSignedOutStatus('replaced')).toBe(true);
  });

  it('reads every other status as not signed out', () => {
    for (const status of ['ok', 'no-subscription', 'not-found', 'link-failed'] as const) {
      expect(isSignedOutStatus(status)).toBe(false);
    }
  });
});

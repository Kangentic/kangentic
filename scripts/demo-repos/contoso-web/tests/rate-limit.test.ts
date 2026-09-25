import { beforeEach, describe, expect, it } from 'vitest';
import { checkRateLimit, resetRateLimits } from '../server/rate-limit.ts';

describe('checkRateLimit', () => {
  beforeEach(() => resetRateLimits());

  it('allows up to the read limit inside one window', () => {
    for (let index = 0; index < 100; index++) expect(checkRateLimit('u_1', 'read', 1000)).toBe(true);
    expect(checkRateLimit('u_1', 'read', 1000)).toBe(false);
  });

  it('keeps read and write windows separate', () => {
    for (let index = 0; index < 20; index++) expect(checkRateLimit('u_1', 'write', 1000)).toBe(true);
    expect(checkRateLimit('u_1', 'write', 1000)).toBe(false);
    expect(checkRateLimit('u_1', 'read', 1000)).toBe(true);
  });
});

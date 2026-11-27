import { describe, expect, it } from 'vitest';
import { browserCrashKind } from '../../src/shared/browser-crash';

describe('browserCrashKind', () => {
  it('reads both memory reasons as out of memory', () => {
    expect(browserCrashKind('oom')).toBe('out-of-memory');
    expect(browserCrashKind('memory-eviction')).toBe('out-of-memory');
  });

  it('reads every other Electron reason as crashed', () => {
    for (const reason of ['crashed', 'abnormal-exit', 'launch-failed', 'integrity-failure', 'killed', 'clean-exit']) {
      expect(browserCrashKind(reason)).toBe('crashed');
    }
  });

  it('reads a reason it has never seen, or none, as crashed', () => {
    expect(browserCrashKind('some-future-reason')).toBe('crashed');
    expect(browserCrashKind(undefined)).toBe('crashed');
    expect(browserCrashKind(null)).toBe('crashed');
  });
});

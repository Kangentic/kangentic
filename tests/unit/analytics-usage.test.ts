import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({
  trackEvent: vi.fn(),
}));

vi.mock('../../src/main/analytics/analytics', () => ({
  trackEvent: mocks.trackEvent,
}));

import {
  ANALYTICS_FEATURES,
  ONBOARDING_MILESTONES,
  isKnownAnalyticsFeature,
  initUsageAnalytics,
  trackFeatureUsed,
  trackMilestone,
  trackUpdateOutcome,
  bucketTaskCount,
  resetUsageAnalyticsForTests,
} from '../../src/main/analytics/usage';

let tempDir: string;
let flagsPath: string;

beforeEach(() => {
  mocks.trackEvent.mockClear();
  resetUsageAnalyticsForTests();
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kng-usage-'));
  flagsPath = path.join(tempDir, 'analytics-usage.json');
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

interface UsageFlagsOnDisk {
  milestones?: unknown;
  featureFirstUse?: unknown;
  lastRunVersion?: unknown;
}

/**
 * persistUsageFlags is fire-and-forget (fs.promises), so any test that reads the file back has
 * to wait for the write to land.
 *
 * This used to be a bare `setTimeout(20)`, which is the OS-dependent timing assumption
 * cross-platform-parity.md bans, and it duly failed: on CI's unit shard 1 (290 files on one
 * loaded Linux runner) 20ms expired before the write completed, the restart below reloaded an
 * empty flags file, and `feature_first_use` fired a second time - green on a developer's
 * Windows machine, red on CI. A fixed sleep also cannot tell "not written yet" from "written,
 * and it is the PREVIOUS write I am looking at", which is the second flush in a test that
 * persists twice.
 *
 * So wait for the caller's actual post-condition instead of for a duration. Every call site
 * passes the specific on-disk state its assertions then depend on.
 */
async function flushWrites(isSettled: (flags: UsageFlagsOnDisk) => boolean): Promise<void> {
  const deadlineMs = Date.now() + 5000;
  for (;;) {
    let flags: UsageFlagsOnDisk = {};
    try {
      flags = JSON.parse(fs.readFileSync(flagsPath, 'utf-8')) as UsageFlagsOnDisk;
    } catch {
      // Not written yet, or caught mid-write: keep polling rather than failing here.
    }
    if (isSettled(flags)) return;
    if (Date.now() >= deadlineMs) {
      throw new Error(
        `flushWrites timed out after 5s waiting for the flags file to settle. On disk: ${JSON.stringify(flags)}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** True once the persisted featureFirstUse RECORD marks `feature`. An array (the wrong-shape
 *  fixture) is deliberately not a match: that is the pre-write state this must poll past. */
function featureFirstUseHas(feature: string): (flags: UsageFlagsOnDisk) => boolean {
  return (flags) => {
    const record = flags.featureFirstUse;
    if (typeof record !== 'object' || record === null || Array.isArray(record)) return false;
    return (record as Record<string, unknown>)[feature] === true;
  };
}

function milestonesHave(step: string): (flags: UsageFlagsOnDisk) => boolean {
  return (flags) => {
    const record = flags.milestones;
    if (typeof record !== 'object' || record === null || Array.isArray(record)) return false;
    return (record as Record<string, unknown>)[step] === true;
  };
}

function lastRunVersionIs(version: string): (flags: UsageFlagsOnDisk) => boolean {
  return (flags) => flags.lastRunVersion === version;
}

describe('isKnownAnalyticsFeature', () => {
  it('accepts every curated feature and rejects unknown vocabulary', () => {
    for (const feature of ANALYTICS_FEATURES) {
      expect(isKnownAnalyticsFeature(feature)).toBe(true);
    }
    expect(isKnownAnalyticsFeature('made_up_feature')).toBe(false);
    expect(isKnownAnalyticsFeature('')).toBe(false);
  });
});

describe('trackFeatureUsed', () => {
  it('emits feature_used once per feature per day, plus feature_first_use once per install', () => {
    initUsageAnalytics(flagsPath);
    trackFeatureUsed('quick_find');
    trackFeatureUsed('quick_find');
    trackFeatureUsed('settings');

    const eventNames = mocks.trackEvent.mock.calls.map((call) => call[0]);
    expect(eventNames.filter((name) => name === 'feature_used')).toHaveLength(2);
    expect(eventNames.filter((name) => name === 'feature_first_use')).toHaveLength(2);
    expect(mocks.trackEvent).toHaveBeenCalledWith('feature_used', { feature: 'quick_find' });
    expect(mocks.trackEvent).toHaveBeenCalledWith('feature_first_use', { feature: 'settings' });
  });

  it('remembers first-use across restarts via the flags file', async () => {
    initUsageAnalytics(flagsPath);
    trackFeatureUsed('browser_pane');
    await flushWrites(featureFirstUseHas('browser_pane'));

    // Simulate a restart: fresh module state, same flags file.
    resetUsageAnalyticsForTests();
    mocks.trackEvent.mockClear();
    initUsageAnalytics(flagsPath);
    trackFeatureUsed('browser_pane');

    const eventNames = mocks.trackEvent.mock.calls.map((call) => call[0]);
    // The daily dedup map is in-memory, so the restarted run sends one
    // feature_used again, but never a second feature_first_use.
    expect(eventNames).toContain('feature_used');
    expect(eventNames).not.toContain('feature_first_use');
  });

  it('skips lifetime-once events entirely when initUsageAnalytics never ran, but still sends the daily feature_used', () => {
    trackFeatureUsed('mcp_server');
    trackFeatureUsed('mcp_server');

    const eventNames = mocks.trackEvent.mock.calls.map((call) => call[0]);
    expect(eventNames).toEqual(['feature_used']);
  });
});

describe('trackMilestone', () => {
  it('fires each step at most once per install, persisted across restarts', async () => {
    initUsageAnalytics(flagsPath);
    trackMilestone('first_task');
    trackMilestone('first_task');
    trackMilestone('first_spawn');
    await flushWrites(milestonesHave('first_spawn'));

    resetUsageAnalyticsForTests();
    initUsageAnalytics(flagsPath);
    trackMilestone('first_task');

    const milestoneCalls = mocks.trackEvent.mock.calls.filter(
      (call) => call[0] === 'onboarding_milestone'
    );
    expect(milestoneCalls).toEqual([
      ['onboarding_milestone', { step: 'first_task' }],
      ['onboarding_milestone', { step: 'first_spawn' }],
    ]);
  });

  it('is a no-op before initUsageAnalytics (never fires unbounded)', () => {
    trackMilestone('first_project');
    expect(mocks.trackEvent).not.toHaveBeenCalled();
  });
});

describe('trackUpdateOutcome', () => {
  it('records a baseline on first run without emitting', async () => {
    initUsageAnalytics(flagsPath);
    trackUpdateOutcome('1.2.3');
    expect(mocks.trackEvent).not.toHaveBeenCalled();
    await flushWrites(lastRunVersionIs('1.2.3'));
    expect(JSON.parse(fs.readFileSync(flagsPath, 'utf-8')).lastRunVersion).toBe('1.2.3');
  });

  it('emits applied on an upgrade and rolled_back on a downgrade, once per version change', async () => {
    initUsageAnalytics(flagsPath);
    trackUpdateOutcome('1.2.3');
    await flushWrites(lastRunVersionIs('1.2.3'));

    resetUsageAnalyticsForTests();
    initUsageAnalytics(flagsPath);
    trackUpdateOutcome('1.3.0');
    expect(mocks.trackEvent).toHaveBeenCalledWith('update_outcome', {
      result: 'applied',
      fromVersion: '1.2.3',
      toVersion: '1.3.0',
    });
    trackUpdateOutcome('1.3.0');
    expect(mocks.trackEvent).toHaveBeenCalledTimes(1);
    await flushWrites(lastRunVersionIs('1.3.0'));

    resetUsageAnalyticsForTests();
    mocks.trackEvent.mockClear();
    initUsageAnalytics(flagsPath);
    trackUpdateOutcome('1.2.9');
    expect(mocks.trackEvent).toHaveBeenCalledWith('update_outcome', {
      result: 'rolled_back',
      fromVersion: '1.3.0',
      toVersion: '1.2.9',
    });
  });
});

describe('initUsageAnalytics survives a wrong-shaped flags file', () => {
  it('does not throw on field-level type mismatches, and downstream calls stay functional', () => {
    // Syntactically valid JSON, but every field has the wrong shape: a
    // string where a milestone record belongs, an array where a
    // feature-first-use record belongs, an object where the version string
    // belongs. asFlagRecord() must fall back to {} per-field rather than
    // letting an `as` cast carry the wrong runtime type into usageFlags.
    fs.writeFileSync(
      flagsPath,
      JSON.stringify({ milestones: 'x', featureFirstUse: [1], lastRunVersion: { a: 1 } })
    );

    expect(() => initUsageAnalytics(flagsPath)).not.toThrow();

    // Reverting asFlagRecord's validation (a plain `as` cast) would leave
    // usageFlags.milestones holding the string "x" at runtime. ES modules
    // are strict mode, so `usageFlags.milestones[step] = true` then throws
    // "Cannot create property ... on string" - this assertion is the red
    // signal for that regression.
    expect(() => trackMilestone('first_project')).not.toThrow();
    const milestoneCalls = mocks.trackEvent.mock.calls.filter(
      (call) => call[0] === 'onboarding_milestone'
    );
    expect(milestoneCalls).toEqual([['onboarding_milestone', { step: 'first_project' }]]);

    // lastRunVersion fell back to undefined (object is not a string), so
    // this is a first-run baseline: must not throw, and must not emit.
    expect(() => trackUpdateOutcome('1.0.0')).not.toThrow();
    expect(mocks.trackEvent).not.toHaveBeenCalledWith('update_outcome', expect.anything());
  });

  it('the featureFirstUse array guard actually holds: a wrong-shaped array does not silently swallow the first-use flag', async () => {
    // The `!Array.isArray(value)` half of asFlagRecord's guard is otherwise
    // untested by the assertion above (trackMilestone never touches
    // featureFirstUse). Assigning a named property to an array does not
    // throw - `([1] as any).quick_find = true` is legal JS - so a partial
    // revert dropping only Array.isArray would stay green against a
    // not-throw assertion. Prove the flag actually PERSISTS instead: if the
    // guard were dropped, the write would land on the throwaway array
    // instead of a real record, JSON.stringify would drop it, and the
    // restarted run below would re-fire feature_first_use.
    fs.writeFileSync(
      flagsPath,
      JSON.stringify({ milestones: 'x', featureFirstUse: [1], lastRunVersion: { a: 1 } })
    );
    initUsageAnalytics(flagsPath);
    trackFeatureUsed('quick_find');
    await flushWrites(featureFirstUseHas('quick_find'));

    resetUsageAnalyticsForTests();
    mocks.trackEvent.mockClear();
    initUsageAnalytics(flagsPath);
    trackFeatureUsed('quick_find');

    const eventNames = mocks.trackEvent.mock.calls.map((call) => call[0]);
    expect(eventNames).not.toContain('feature_first_use');
  });
});

describe('ONBOARDING_MILESTONES vocabulary parity', () => {
  it('every declared milestone actually fires onboarding_milestone, in declaration order, when tracked', () => {
    initUsageAnalytics(flagsPath);
    for (const step of ONBOARDING_MILESTONES) {
      trackMilestone(step);
    }

    const milestoneSteps = mocks.trackEvent.mock.calls
      .filter((call) => call[0] === 'onboarding_milestone')
      .map((call) => (call[1] as { step: string }).step);
    expect(milestoneSteps).toEqual([...ONBOARDING_MILESTONES]);
  });
});

describe('bucketTaskCount', () => {
  it('buckets counts without ever exposing an exact figure', () => {
    expect(bucketTaskCount(0)).toBe('0');
    expect(bucketTaskCount(1)).toBe('1-9');
    expect(bucketTaskCount(9)).toBe('1-9');
    expect(bucketTaskCount(10)).toBe('10-49');
    expect(bucketTaskCount(49)).toBe('10-49');
    expect(bucketTaskCount(50)).toBe('50-199');
    expect(bucketTaskCount(199)).toBe('50-199');
    expect(bucketTaskCount(200)).toBe('200+');
    expect(bucketTaskCount(5000)).toBe('200+');
  });
});

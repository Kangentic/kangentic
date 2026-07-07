/**
 * Unit tests for `defaultDeveloperFlag` (src/shared/developer-flag-defaults.ts).
 *
 * This is the decision logic behind `safeReadDeveloperFlag` in
 * src/main/index.ts, extracted specifically because that file cannot itself
 * be imported by a test: it is an Electron entry-point module with top-level
 * `electron` API calls (`app`, `BrowserWindow`, ...) that throw outside a
 * running Electron process, and vitest.config.ts pins `__KANGENTIC_DEV__` to
 * `false` globally, so even an importable module could never observe the
 * "true" branch of that build-time constant. Taking `isDevBuild` as a plain
 * parameter here sidesteps both problems and lets every branch be exercised.
 *
 * Each case is anchored to the PR intent documented in the two call sites'
 * comments (src/main/index.ts's safeReadDeveloperFlag and
 * src/renderer/.../DeveloperTab.tsx), not reverse-engineered from the
 * implementation:
 *   - previewInspectionServer / previewEvalEnabled: ON in dev builds only.
 *   - persistConsoleLogs: ON in ANY dev build (npm start AND /preview) -
 *     the write path is async-queued, so there is no dogfooding cost.
 *   - recordIpcTraffic: ON only for dev build AND ephemeral /preview - it has
 *     a real per-call disk-I/O cost, bounded only in /preview by its data dir
 *     being wiped on close.
 *   - activityDebugOverlay (and any other/future key): always OFF by default -
 *     it has a visible cost the user should opt into deliberately.
 */
import { describe, it, expect } from 'vitest';
import { defaultDeveloperFlag, type DeveloperFlagKey } from '../../src/shared/developer-flag-defaults';

describe('defaultDeveloperFlag - previewInspectionServer / previewEvalEnabled', () => {
  it.each(['previewInspectionServer', 'previewEvalEnabled'] as const)(
    '%s defaults ON in a dev build regardless of ephemeral state',
    (key) => {
      expect(defaultDeveloperFlag(key, true, false)).toBe(true);
      expect(defaultDeveloperFlag(key, true, true)).toBe(true);
    },
  );

  it.each(['previewInspectionServer', 'previewEvalEnabled'] as const)(
    '%s defaults OFF in a production build regardless of ephemeral state',
    (key) => {
      expect(defaultDeveloperFlag(key, false, false)).toBe(false);
      expect(defaultDeveloperFlag(key, false, true)).toBe(false);
    },
  );
});

describe('defaultDeveloperFlag - persistConsoleLogs', () => {
  it('defaults ON in a dev build for the regular (non-ephemeral) npm start session', () => {
    expect(defaultDeveloperFlag('persistConsoleLogs', true, false)).toBe(true);
  });

  it('defaults ON in a dev build for the ephemeral /preview session too', () => {
    expect(defaultDeveloperFlag('persistConsoleLogs', true, true)).toBe(true);
  });

  it('defaults OFF in a production build even if somehow marked ephemeral', () => {
    expect(defaultDeveloperFlag('persistConsoleLogs', false, false)).toBe(false);
    expect(defaultDeveloperFlag('persistConsoleLogs', false, true)).toBe(false);
  });
});

describe('defaultDeveloperFlag - recordIpcTraffic', () => {
  it('defaults ON only for a dev build AND ephemeral /preview', () => {
    expect(defaultDeveloperFlag('recordIpcTraffic', true, true)).toBe(true);
  });

  it('defaults OFF for a dev build that is NOT ephemeral (regular npm start dogfooding)', () => {
    // This is the key distinction from persistConsoleLogs: the IPC recorder's
    // real disk-I/O cost means the long-running dogfooding session must stay
    // opt-in, even though it is a dev build.
    expect(defaultDeveloperFlag('recordIpcTraffic', true, false)).toBe(false);
  });

  it('defaults OFF for a production build even if marked ephemeral', () => {
    expect(defaultDeveloperFlag('recordIpcTraffic', false, true)).toBe(false);
  });

  it('defaults OFF for a production, non-ephemeral build', () => {
    expect(defaultDeveloperFlag('recordIpcTraffic', false, false)).toBe(false);
  });
});

describe('defaultDeveloperFlag - activityDebugOverlay', () => {
  it('defaults OFF in every combination - it has a visible cost the user must opt into', () => {
    expect(defaultDeveloperFlag('activityDebugOverlay', true, true)).toBe(false);
    expect(defaultDeveloperFlag('activityDebugOverlay', true, false)).toBe(false);
    expect(defaultDeveloperFlag('activityDebugOverlay', false, true)).toBe(false);
    expect(defaultDeveloperFlag('activityDebugOverlay', false, false)).toBe(false);
  });
});

describe('defaultDeveloperFlag - full table (pins every key x isDevBuild x isEphemeralPreview combination)', () => {
  it('matches the documented default for every combination', () => {
    const keys: DeveloperFlagKey[] = [
      'activityDebugOverlay',
      'persistConsoleLogs',
      'recordIpcTraffic',
      'previewInspectionServer',
      'previewEvalEnabled',
    ];
    const booleans = [true, false];

    const expectedFor = (key: DeveloperFlagKey, isDevBuild: boolean, isEphemeralPreview: boolean): boolean => {
      if (key === 'previewInspectionServer' || key === 'previewEvalEnabled') return isDevBuild;
      if (key === 'persistConsoleLogs') return isDevBuild;
      if (key === 'recordIpcTraffic') return isDevBuild && isEphemeralPreview;
      return false; // activityDebugOverlay
    };

    for (const key of keys) {
      for (const isDevBuild of booleans) {
        for (const isEphemeralPreview of booleans) {
          expect(
            defaultDeveloperFlag(key, isDevBuild, isEphemeralPreview),
            `defaultDeveloperFlag('${key}', isDevBuild=${isDevBuild}, isEphemeralPreview=${isEphemeralPreview})`,
          ).toBe(expectedFor(key, isDevBuild, isEphemeralPreview));
        }
      }
    }
  });
});

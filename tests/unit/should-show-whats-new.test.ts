/**
 * Unit tests for the post-update "What's New" launch decision.
 *
 * shouldShowWhatsNew is pure - no React, no stores, no window - so it is
 * reachable from the node tier, the same way normalizeReleaseNotes is.
 *
 * The behaviour that matters most here is the 'wait' state. `appVersion` is null
 * until loadAppVersion() resolves and the config is still DEFAULT_CONFIG (marker
 * '') until loading flips false. Deciding before both settle would compare
 * against a placeholder, and the caller would then persist the running version
 * over the user's real marker - eating the notes on the one boot they were meant
 * to appear.
 */

import { describe, it, expect } from 'vitest';
import { shouldShowWhatsNew } from '../../src/renderer/lib/should-show-whats-new';

const NOTES = '## What\'s New\n\n- Something changed';

describe('shouldShowWhatsNew', () => {
  it('waits while the config is still loading', () => {
    expect(shouldShowWhatsNew({
      appVersion: '0.33.0',
      configLoading: true,
      lastWhatsNewShownVersion: '0.32.0',
      notes: NOTES,
    })).toBe('wait');
  });

  it('waits while the app version has not resolved', () => {
    expect(shouldShowWhatsNew({
      appVersion: null,
      configLoading: false,
      lastWhatsNewShownVersion: '0.32.0',
      notes: NOTES,
    })).toBe('wait');
  });

  it('opens when the running version differs from the recorded one', () => {
    expect(shouldShowWhatsNew({
      appVersion: '0.33.0',
      configLoading: false,
      lastWhatsNewShownVersion: '0.32.0',
      notes: NOTES,
    })).toBe('open');
  });

  it('opens on the first upgrade into this feature, when nothing is recorded yet', () => {
    // The primary case: an existing install upgrading to the release that adds
    // this key has no marker, so the deep merge supplies DEFAULT_CONFIG's ''.
    // Treating '' as "stay silent" would make the feature dead for a whole
    // release cycle, which is exactly why the notes are not persisted at
    // download time either. Fresh installs are excluded in main instead, by
    // seeding the marker when no config.json existed at launch.
    expect(shouldShowWhatsNew({
      appVersion: '0.33.0',
      configLoading: false,
      lastWhatsNewShownVersion: '',
      notes: NOTES,
    })).toBe('open');
  });

  it('records without opening when the version is already recorded', () => {
    expect(shouldShowWhatsNew({
      appVersion: '0.33.0',
      configLoading: false,
      lastWhatsNewShownVersion: '0.33.0',
      notes: NOTES,
    })).toBe('record');
  });

  it('records without opening when the build has no notes', () => {
    // No toast fallback here, unlike the pre-restart flow: after a restart there
    // is no pending action to offer. Recording anyway stops it retrying forever.
    expect(shouldShowWhatsNew({
      appVersion: '0.33.0',
      configLoading: false,
      lastWhatsNewShownVersion: '0.32.0',
      notes: '',
    })).toBe('record');
  });

  it('waits rather than records when both the version is unresolved and notes are empty', () => {
    expect(shouldShowWhatsNew({
      appVersion: null,
      configLoading: true,
      lastWhatsNewShownVersion: '',
      notes: '',
    })).toBe('wait');
  });
});

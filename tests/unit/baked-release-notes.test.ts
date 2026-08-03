/**
 * Guards the invariant that lib/baked-release-notes.ts actually inlines
 * something for the version this build ships.
 *
 * shouldShowWhatsNew's empty-notes branch (tests/unit/should-show-whats-new.test.ts)
 * and WhatsNewDialog's `!bakedReleaseNotes` early return (tests/ui/whats-new-dialog.spec.ts)
 * are both exercised with a hand-supplied fixture string, never the real shipped
 * RELEASE_NOTES.md. If a future `/release` cut ever ships that file empty or
 * whitespace-only, `bakedReleaseNotes` becomes '', WhatsNewDialog never renders,
 * and StatusBar's version pill silently degrades to a non-interactive `<span>`
 * (the `bakedReleaseNotes ? onClick : undefined` branch in StatusBar.tsx) - a
 * regression with no other test able to catch it. UI tier cannot cover this
 * branch either: there is no injection point for the build-time baked notes
 * (see the header comment in whats-new-dialog.spec.ts), so this one assertion
 * on the real module is the only place this invariant can be pinned.
 */
import { describe, it, expect } from 'vitest';
import { bakedReleaseNotes } from '../../src/renderer/lib/baked-release-notes';

describe('bakedReleaseNotes (shipped RELEASE_NOTES.md)', () => {
  it('is non-empty for the version this build actually ships', () => {
    expect(bakedReleaseNotes.length).toBeGreaterThan(0);
  });
});

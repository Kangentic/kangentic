/**
 * Wiring pins for the guest mouse back/forward forwarding in
 * `src/main/index.ts` (decision 25 in docs/embedded-browser.md).
 *
 * The forwarding logic lives as a closure inside the app-wide
 * `web-contents-created` handler rather than an extracted, importable
 * module, so its held-button Set / release paths cannot be driven directly
 * from a unit test the way `window-open-policy.ts` can (see that module's
 * own wiring-scan precedent in `tests/unit/window-open-policy.test.ts`, which
 * this file mirrors). What follows is a static scan, not a behavior test: it
 * pins that the two release paths are STILL PRESENT in the source, so a
 * future edit that silently drops one fails a test instead of shipping
 * unnoticed.
 *
 * Both release paths matter for the same concrete reason: `useDictation` is
 * mounted once app-wide, and a missing release UP leaves `activeRef` true and
 * the microphone conceptually "held", so the per-session paste guard and the
 * push-to-talk re-entrancy guard both wedge for that session until dictation
 * is toggled off and on again by hand.
 *
 * The renderer half of this feature (hold vs tap timing, an unmatched
 * release) is covered via `emitGuestMouseButton` in
 * `tests/ui/dictation-note-input.spec.ts`; this file covers only that MAIN
 * actually sends the release in the first place.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const source = fs.readFileSync(path.join(REPO_ROOT, 'src/main/index.ts'), 'utf-8');

describe('guest mouse back/forward forwarding is wired into src/main/index.ts', () => {
  it('tracks held buttons in a Set, added on mouseDown and removed on mouseUp', () => {
    expect(
      source,
      'a held-button Set that is never populated or drained makes both release paths below no-ops',
    ).toMatch(/heldGuestButtons\s*=\s*new Set/);
    expect(source).toMatch(/heldGuestButtons\.add\(/);
    expect(source).toMatch(/heldGuestButtons\.delete\(/);
  });

  it('releases every held button on mouseLeave', () => {
    // Regression this guards: a press whose pointer leaves the webview before
    // release reports a DOWN and never an UP over input-event, which would
    // otherwise strand dictation recording with the microphone conceptually
    // held open.
    expect(
      source,
      "src/main/index.ts must synthesize an 'up' for every held button on 'mouseLeave', or a press that leaves the webview before releasing strands dictation recording with the mic open",
    ).toMatch(/mouseLeave[\s\S]{0,200}heldGuestButtons\)\s*sendGuestMouseButton\([^,]+,\s*'up'\)/);
    expect(
      source,
      "the mouseLeave branch must clear heldGuestButtons after releasing, or the next real mouseUp double-releases a button nothing is still holding",
    ).toMatch(/mouseLeave[\s\S]{0,260}heldGuestButtons\.clear\(\)/);
  });

  it('releases every held button when the guest is destroyed mid-hold', () => {
    // Regression this guards: closing the pane while a button is held takes
    // the only thing that could report the release with it - `input-event`
    // fires on `contents`, which is gone by the time `destroyed` runs.
    expect(
      source,
      "src/main/index.ts must send a release for every held button from the guest's 'destroyed' handler, or closing the pane mid-hold strands the button held forever",
    ).toMatch(/'destroyed'[\s\S]{0,600}heldGuestButtons[\s\S]{0,400}phase:\s*'up'/);
  });

  it('the destroyed handler remembers a host it can still send to', () => {
    // `contents.hostWebContents` is unreachable once `destroyed` has fired,
    // so the release on that path needs a host captured earlier.
    expect(
      source,
      'the destroyed-guest release must use a remembered host (contents.hostWebContents is gone by the time destroyed fires)',
    ).toMatch(/releaseHost\s*=\s*host/);
    expect(source).toMatch(/releaseHost[\s\S]{0,200}\.send\(\s*IPC\.BROWSER_GUEST_MOUSE_BUTTON/);
  });

  it('both release paths use the real BROWSER_GUEST_MOUSE_BUTTON channel', () => {
    const matches = source.match(/IPC\.BROWSER_GUEST_MOUSE_BUTTON/g) ?? [];
    // sendGuestMouseButton's own send, plus the destroyed-handler's direct
    // send - two call sites minimum.
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });
});

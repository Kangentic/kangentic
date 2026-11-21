/**
 * Wiring of a Browser pane tool shortcut (Select element, Draw) typed into the
 * page, in src/main/index.ts.
 *
 * A key the <webview> guest holds never reaches the app's document, so main
 * matches it in the guest's `before-input-event` and pushes it to the host
 * window. src/main/index.ts makes top-level electron calls and cannot be
 * imported by a unit test (the same constraint and approach as
 * before-quit-drain-wiring.test.ts), so this reads the handler's source and
 * checks positions inside that one handler. The matcher itself
 * (guestShortcutFor) is covered by browser-pane-guest-shortcuts.test.ts, and
 * the pane's reaction by tests/ui/browser-pane-shortcuts.spec.ts.
 *
 * What a user loses if this goes: after a click in the page, Ctrl+Shift+C and
 * Ctrl+Shift+D stop answering, or answer while an agent is driving and send
 * the user's keystroke to the pane instead of their terminal.
 *
 * Tier: Unit.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const INDEX_SOURCE = fs.readFileSync(path.join(REPO_ROOT, 'src/main/index.ts'), 'utf-8');

const WEBVIEW_ONLY_RETURN = "if (contents.getType() !== 'webview') {";
const GUEST_HANDLER_START = "contents.on('before-input-event', (inputEvent, input) => {";

/** The guest's before-input-event handler: from its registration to the next top-level statement. */
function guestHandlerSource(): string {
  const start = INDEX_SOURCE.indexOf(GUEST_HANDLER_START);
  expect(start, 'the guest before-input-event handler is registered').toBeGreaterThan(-1);
  const end = INDEX_SOURCE.indexOf('\n  });\n', start);
  expect(end, 'the guest handler has a closing line').toBeGreaterThan(start);
  return INDEX_SOURCE.slice(start, end);
}

describe('Browser pane tool shortcut wiring in main', () => {
  it('registers the guest handler only for webview contents', () => {
    const webviewOnlyReturn = INDEX_SOURCE.indexOf(WEBVIEW_ONLY_RETURN);
    expect(webviewOnlyReturn).toBeGreaterThan(-1);
    expect(INDEX_SOURCE.indexOf(GUEST_HANDLER_START)).toBeGreaterThan(webviewOnlyReturn);
    expect(INDEX_SOURCE.slice(webviewOnlyReturn, INDEX_SOURCE.indexOf(GUEST_HANDLER_START)))
      .toMatch(/return;\s*\}/);
  });

  it('matches the shortcut after the agent-driving branch, so a user key during a drive still goes to the terminal', () => {
    const handler = guestHandlerSource();
    const drivingBranch = handler.indexOf('if (isAgentDriving(contents.id)) {');
    const matchCall = handler.indexOf('guestShortcutFor(input, process.platform)');
    expect(drivingBranch).toBeGreaterThan(-1);
    expect(matchCall).toBeGreaterThan(-1);
    expect(matchCall).toBeGreaterThan(drivingBranch);

    // The driving branch returns before the match: no fall-through into it.
    const drivingBody = handler.slice(drivingBranch, matchCall);
    expect(drivingBody).toContain('return;');
  });

  it('swallows the key and pushes the action with the guest id to the host window', () => {
    const handler = guestHandlerSource();
    const matchCall = handler.indexOf('guestShortcutFor(input, process.platform)');
    const afterMatch = handler.slice(matchCall);
    const matchBlockEnd = afterMatch.indexOf('return;');
    expect(matchBlockEnd).toBeGreaterThan(-1);
    const matchBlock = afterMatch.slice(0, matchBlockEnd);

    expect(matchBlock).toMatch(/if \(\w+\) \{/);
    expect(matchBlock).toContain('inputEvent.preventDefault()');
    expect(matchBlock).toContain('BrowserWindow.fromWebContents(contents.hostWebContents ?? contents)');
    expect(matchBlock).toMatch(/\.webContents\.send\(IPC\.BROWSER_PANE_SHORTCUT, contents\.id, \w+\)/);
    // The push runs before the block's own return, and before the F5 / Ctrl+R handling that follows.
    expect(matchBlock.indexOf('inputEvent.preventDefault()'))
      .toBeLessThan(matchBlock.indexOf('IPC.BROWSER_PANE_SHORTCUT'));
    expect(handler.indexOf("const isF5 = input.key === 'F5'")).toBeGreaterThan(matchCall + matchBlockEnd);
  });
});

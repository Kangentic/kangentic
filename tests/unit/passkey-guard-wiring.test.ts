/**
 * The passkey guard's two hooks in `src/main/index.ts`, which no test can
 * import: the arm at a guest's construction and the release on the person's
 * press.
 *
 * What a user loses if they go (decision 47 in the embedded-browser decision
 * log): without the arm, a pane `open_pane` mounts loads a sign-in page before
 * any tool call arms it, and Windows draws "Choose a passkey" on an unattended
 * run. Without the release, the person's own passkey sign-in in a pane an agent
 * drove never reaches Windows Hello or their phone. The guard's behavior runs
 * for real in `browser-passkey-guard.test.ts`; this pins only that index.ts
 * calls it, in the right handlers, in the right order.
 *
 * Tier: Unit. Reads source text because index.ts cannot be imported.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const INDEX_SOURCE = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'main', 'index.ts'), 'utf8');

/** The `web-contents-created` handler's body, from its registration to the next top-level `app.on(`. */
function webContentsCreatedBody(): string {
  const start = INDEX_SOURCE.indexOf("app.on('web-contents-created'");
  expect(start, 'the web-contents-created handler is gone').toBeGreaterThan(-1);
  const end = INDEX_SOURCE.indexOf('\napp.on(', start + 1);
  return INDEX_SOURCE.slice(start, end === -1 ? undefined : end);
}

/** The text of one `contents.on('<event>', ...)` registration, up to the next one. */
function handlerBody(body: string, event: string): string {
  const start = body.indexOf(`contents.on('${event}'`);
  expect(start, `no contents.on('${event}') in the webview branch`).toBeGreaterThan(-1);
  const next = body.indexOf('contents.on(', start + 1);
  return body.slice(start, next === -1 ? undefined : next);
}

/** Where a pattern first matches in `text`, or -1. */
function positionOf(text: string, pattern: RegExp): number {
  return text.search(pattern);
}

describe('passkey guard wiring in index.ts', () => {
  it('arms a guest whose owner an agent controls, in the webview branch, before any handler is attached', () => {
    const body = webContentsCreatedBody();
    const webviewBranch = positionOf(body, /contents\.getType\(\)\s*!==\s*'webview'/);
    const arm = positionOf(body, /isUnderAgentControl\(\s*contents\.session\s*\)[\s\S]{0,40}?armGuest\(\s*contents\s*,\s*'created'\s*\)/);
    const firstGuestHandler = positionOf(body, /contents\.on\('input-event'/);
    expect(webviewBranch, 'the non-webview early return is gone, so the order below proves nothing').toBeGreaterThan(-1);
    expect(firstGuestHandler, 'the guest input-event handler is gone, so the order below proves nothing').toBeGreaterThan(-1);
    expect(arm, 'the arm at construction is gone').toBeGreaterThan(-1);
    expect(arm, 'the arm must run for webview guests only').toBeGreaterThan(webviewBranch);
    expect(arm, 'the arm must run at construction, ahead of the guest handlers').toBeLessThan(firstGuestHandler);
  });

  it('releases on the person\'s mouse press', () => {
    const inputEvent = handlerBody(webContentsCreatedBody(), 'input-event');
    expect(inputEvent).toMatch(/type\s*===\s*'mouseDown'\)\s*releaseAgentControl\(\s*contents\s*\)/);
  });

  it('releases on the person\'s key, after the drive branch has returned', () => {
    const beforeInput = handlerBody(webContentsCreatedBody(), 'before-input-event');
    const driveBranch = positionOf(beforeInput, /if\s*\(\s*isAgentDriving\(\s*contents\.id\s*\)\s*\)\s*\{/);
    const release = positionOf(beforeInput, /releaseAgentControl\(\s*contents\s*\)/);
    expect(driveBranch).toBeGreaterThan(-1);
    expect(release, 'a key during a drive is the agent\'s burst, never a release').toBeGreaterThan(driveBranch);
  });
});

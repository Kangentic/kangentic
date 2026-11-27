/**
 * The crash tracker's hook in `src/main/index.ts`, which no test can import.
 *
 * What a user loses if it goes (task #1226): a pane's guest is never tracked, so a page that
 * stops in a pane never turns the Browser pill and card globes red, and a drive on it is
 * refused with "crashed" for words instead of the memory reason. The tracker's behavior runs
 * for real in `guest-crash-state.test.ts`; this pins only that index.ts calls it, for webview
 * guests only.
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

describe('guest crash tracking wiring in index.ts', () => {
  it('tracks every webview guest, after the non-webview early return', () => {
    const body = webContentsCreatedBody();
    const webviewBranch = body.search(/contents\.getType\(\)\s*!==\s*'webview'/);
    const track = body.search(/trackGuestCrash\(\s*contents\s*\)/);
    expect(webviewBranch, 'the non-webview early return is gone, so the order below proves nothing').toBeGreaterThan(-1);
    expect(track, 'trackGuestCrash is no longer called in web-contents-created').toBeGreaterThan(-1);
    expect(track, 'tracking must run for webview guests only, past the early return').toBeGreaterThan(webviewBranch);
  });
});

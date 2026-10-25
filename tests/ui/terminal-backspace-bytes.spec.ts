/**
 * The bytes Backspace sends into the PTY. Plain Backspace is DEL (0x7f), a
 * single-character delete. Ctrl+Backspace is Ctrl+H (0x08), which Claude Code's
 * TUI reads as delete-previous-word. Both come from xterm's own key encoding:
 * the custom key handler in terminal-clipboard.ts leaves Backspace alone, which
 * tests/unit/terminal-clipboard-backspace.test.ts pins. This spec runs the real
 * browser bundle so an xterm upgrade that changes either encoding fails here.
 *
 * The spec first seeds a stale `terminal.backspaceSendsCtrlH: true` into the
 * renderer's config store, the value an older config file carried before the
 * "Word delete on Backspace" setting was removed. Main strips that key on
 * load, but the renderer must also ignore it if one ever reaches it, so plain
 * Backspace stays DEL. With the setting still wired in, the seeded true would
 * make plain Backspace write 0x08 and the first assertion would fail.
 */
import { test, expect, type Page } from '@playwright/test';
import {
  launchWithTransientTerminal,
  openTransientCommandTerminal,
  writtenToSession,
} from './helpers';

const TRANSIENT_SESSION_ID = 'sess-backspace-bytes-1';

/** The slice of the config store this spec touches. The removed key is no longer
 *  part of `AppConfig`, so the terminal object is typed as an open record. */
interface ConfigStoreHandle {
  getState: () => { config: Record<string, unknown> & { terminal: Record<string, unknown> } };
  setState: (partial: { config: Record<string, unknown> }) => void;
}

/** Write a retired `terminal.backspaceSendsCtrlH: true` into the config store,
 *  keeping every other terminal key as it was. */
async function seedStaleBackspaceSetting(page: Page): Promise<void> {
  await page.evaluate(() => {
    const configStore = (window as unknown as { __zustandStores: { config: ConfigStoreHandle } })
      .__zustandStores.config;
    const currentConfig = configStore.getState().config;
    configStore.setState({
      config: {
        ...currentConfig,
        terminal: { ...currentConfig.terminal, backspaceSendsCtrlH: true },
      },
    });
  });
}

/** Whether the config store still holds the stale value. Read just before the
 *  key presses, so a refetch that cleared the seed fails the spec loudly
 *  instead of letting plain Backspace pass for the wrong reason. */
async function staleBackspaceSettingIsSeeded(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const configStore = (window as unknown as { __zustandStores: { config: ConfigStoreHandle } })
      .__zustandStores.config;
    return configStore.getState().config.terminal.backspaceSendsCtrlH === true;
  });
}

test('plain Backspace sends DEL and Ctrl+Backspace sends Ctrl+H', async () => {
  const { browser, page } = await launchWithTransientTerminal({
    projectId: 'proj-backspace-bytes',
    projectName: 'Backspace Bytes Project',
    sessionId: TRANSIENT_SESSION_ID,
  });
  try {
    await seedStaleBackspaceSetting(page);

    const commandWindow = await openTransientCommandTerminal(page, TRANSIENT_SESSION_ID);
    await commandWindow.locator('.xterm-helper-textarea').first().focus();
    await page.evaluate(() => {
      (window as unknown as { electronAPI: { sessions: { __writeCalls: unknown[] } } })
        .electronAPI.sessions.__writeCalls.length = 0;
    });
    await expect.poll(() => staleBackspaceSettingIsSeeded(page), { timeout: 3000 }).toBe(true);

    await page.keyboard.press('Backspace');
    await expect.poll(() => writtenToSession(page, TRANSIENT_SESSION_ID), { timeout: 3000 }).toBe('\x7f');

    await page.keyboard.press('Control+Backspace');
    await expect.poll(() => writtenToSession(page, TRANSIENT_SESSION_ID), { timeout: 3000 }).toBe('\x7f\x08');
  } finally {
    await browser.close();
  }
});

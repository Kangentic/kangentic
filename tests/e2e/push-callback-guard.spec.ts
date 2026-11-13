/**
 * A renderer callback that throws when the preload calls it on a push.
 *
 * The throw is an error of the preload's isolated world. Measured before the
 * guard: the renderer's main-world `error` and `unhandledrejection` listeners,
 * which are what the Sentry SDK hooks, heard nothing, and the preload's own
 * `error` listener recorded only "Script error." with no stack. The guard
 * (src/preload/push-callback-guard.ts) catches it at the call and sends main a
 * crash record carrying the method and the real stack, and the other
 * listeners on the channel still run.
 *
 * Real wiring: contextBridge, the isolated world, and an `ipcRenderer.on`
 * push, which the UI tier's mock bridge has none of.
 */
import { test, expect } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { launchApp, closeApp, getTestDataDir } from './helpers';

interface StoredCrashRecord {
  source: string;
  stack: string | null;
  context: { pushCallback?: string; errorName?: string } | null;
}

function crashRecordsUnder(directory: string): StoredCrashRecord[] {
  const found: StoredCrashRecord[] = [];
  if (!fs.existsSync(directory)) return found;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...crashRecordsUnder(full));
    else if (full.includes(`${path.sep}crashes${path.sep}`) && entry.name.endsWith('.json')) {
      found.push(JSON.parse(fs.readFileSync(full, 'utf8')) as StoredCrashRecord);
    }
  }
  return found;
}

test('a throwing push callback is caught with its stack, and the next listener still runs', async () => {
  const dataDir = getTestDataDir('push-callback-guard');
  const { app, page } = await launchApp({ dataDir });
  try {
    const later = await page.evaluate(async () => {
      let laterListenerRan = false;
      const first = window.electronAPI.config.onChanged(() => { throw new TypeError('push callback probe'); });
      const second = window.electronAPI.config.onChanged(() => { laterListenerRan = true; });
      await window.electronAPI.config.set({ animationsEnabled: true } as never);
      await new Promise((resolve) => setTimeout(resolve, 500));
      first();
      second();
      return laterListenerRan;
    });
    expect(later).toBe(true);

    await expect.poll(() => crashRecordsUnder(dataDir).filter((record) => record.context?.pushCallback)).toHaveLength(1);
    const [record] = crashRecordsUnder(dataDir).filter((stored) => stored.context?.pushCallback);
    expect(record.source).toBe('preload');
    // The context bridge rethrows the renderer's TypeError as a plain Error in
    // the preload's world: the class is gone, which is why main groups these
    // by method (push-callback-report.ts). A change here changes that grouping.
    expect(record.context).toMatchObject({ pushCallback: 'config.onChanged', errorName: 'Error' });
    expect(record.stack).toContain('push callback probe');
  } finally {
    await closeApp(app);
  }
});

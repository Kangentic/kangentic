import type { Page } from '@playwright/test';
import type { DictationModelProgress } from '../../../src/shared/types';

/**
 * Resolves once the always-mounted dictation hook has subscribed to model
 * download progress, which it does as soon as dictation is on. An event pushed
 * before that reaches no listener, and the mock's emitter drops it silently, so
 * a spec that emits right after turning dictation on has to wait here first.
 *
 * The listeners are the mock's own bookkeeping
 * (`window.__mockDictationModelProgressListeners` in `mock-electron-api.js`),
 * the same array `emitModelProgress` fans out to.
 */
export async function waitForProgressListener(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const listeners = (window as unknown as { __mockDictationModelProgressListeners?: unknown[] })
      .__mockDictationModelProgressListeners;
    return (listeners?.length ?? 0) > 0;
  }, undefined, { timeout: 5000 });
}

/**
 * Push one model-progress event through the mock's `onModelProgress` fan-out,
 * the way main's download progress arrives. Call `waitForProgressListener`
 * first, or the event has nobody to reach.
 */
export async function emitModelProgress(page: Page, progress: DictationModelProgress): Promise<void> {
  await page.evaluate((payload) => {
    (window as unknown as { __emitDictationModelProgress?: (event: unknown) => void })
      .__emitDictationModelProgress?.(payload);
  }, progress);
}

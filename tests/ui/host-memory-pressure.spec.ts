/**
 * UI coverage for the host memory pressure push (Sentry DESKTOP-16): proves
 * App.tsx's `window.electronAPI.hostMemory?.onPressure(...)` and
 * `onRecovery(...)` registrations actually reach
 * `useHostMemoryStore.getState().receivePressureEvent` /
 * `receiveRecovery`, which is what puts a persistent warning toast on
 * screen and clears it again.
 *
 * The store's own formatting (headroom in GB, singular/plural agent count,
 * "unknown" on a platform with no commit reading) and dismiss/replace logic
 * are already pinned at the unit tier in tests/unit/host-memory-store.test.ts
 * against `receivePressureEvent` / `receiveRecovery` directly. Re-deriving
 * every one of those cases here through a real page would duplicate that
 * coverage at UI-tier cost for no extra confidence. This file's only job is
 * the wiring the unit tier cannot see: that App.tsx's optional-chained
 * subscriptions are actually registered and actually forward to the store.
 * One assertion on a stable substring plus the computed headroom is enough
 * to prove both the subscription fired and the store's formatter ran; it
 * does not re-pin the whole sentence.
 */
import { test, expect } from '@playwright/test';
import { launchPage } from './helpers';
import type { HostMemoryPressureEvent } from '../../src/shared/types';

test.describe.configure({ mode: 'parallel' });

test.describe('Host memory pressure toast (Sentry DESKTOP-16)', () => {
  test('a pressure push from main renders a persistent warning toast', async () => {
    const { browser, page } = await launchPage();
    try {
      // Guard the fire: `__mockFireHostMemoryPressure` iterates the listener
      // array and silently no-ops when it is empty. Asserting a live
      // subscriber BEFORE firing means a deleted App.tsx registration fails
      // here with a clear message, instead of surfacing as a mystery "toast
      // never appeared" a screen away.
      const listenerCount = await page.evaluate(
        () => window.__mockHostMemoryPressureListeners?.length ?? 0,
      );
      expect(listenerCount).toBeGreaterThan(0);

      const event: HostMemoryPressureEvent = {
        sample: {
          ts: '2026-09-16T14:24:24.000Z',
          platform: 'win32',
          commitLimitBytes: 96_432_717_824,
          // 1.5 GB remaining, a round number so the formatted string is exact.
          commitRemainingBytes: 1.5 * 1024 * 1024 * 1024,
          physicalTotalBytes: 34_060_931_072,
          physicalFreeBytes: 5_005_045_760,
        },
        activeAgentCount: 2,
      };

      await page.evaluate((payload) => {
        if (!window.__mockFireHostMemoryPressure) {
          throw new Error('window.__mockFireHostMemoryPressure is not installed by the mock');
        }
        window.__mockFireHostMemoryPressure(payload);
      }, event);

      const toast = page.getByTestId('toast');
      await expect(toast).toBeVisible();
      await expect(toast).toContainText('memory reservations');
      await expect(toast).toContainText('1.5 GB');
      await expect(toast).toContainText('2 agents');
    } finally {
      await browser.close();
    }
  });

  test('a recovery push from main dismisses the persistent warning toast', async () => {
    const { browser, page } = await launchPage();
    try {
      const pressureListenerCount = await page.evaluate(
        () => window.__mockHostMemoryPressureListeners?.length ?? 0,
      );
      expect(pressureListenerCount).toBeGreaterThan(0);

      const event: HostMemoryPressureEvent = {
        sample: {
          ts: '2026-09-16T14:24:24.000Z',
          platform: 'win32',
          commitLimitBytes: 96_432_717_824,
          commitRemainingBytes: 1.5 * 1024 * 1024 * 1024,
          physicalTotalBytes: 34_060_931_072,
          physicalFreeBytes: 5_005_045_760,
        },
        activeAgentCount: 2,
      };

      await page.evaluate((payload) => {
        window.__mockFireHostMemoryPressure?.(payload);
      }, event);

      const toast = page.getByTestId('toast');
      await expect(toast).toBeVisible();

      // Guard the fire the same way the pressure test does: a deleted
      // App.tsx `onRecovery` registration must fail here with a clear
      // message, instead of surfacing as a mystery "toast never left".
      const recoveryListenerCount = await page.evaluate(
        () => window.__mockHostMemoryRecoveryListeners?.length ?? 0,
      );
      expect(recoveryListenerCount).toBeGreaterThan(0);

      await page.evaluate((sample) => {
        if (!window.__mockFireHostMemoryRecovery) {
          throw new Error('window.__mockFireHostMemoryRecovery is not installed by the mock');
        }
        window.__mockFireHostMemoryRecovery({ sample });
      }, event.sample);

      await expect(toast).toBeHidden();
    } finally {
      await browser.close();
    }
  });
});

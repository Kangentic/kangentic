import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import type { CrashNotice } from '../../shared/types';
import { formatClockTime } from '../lib/datetime';
import { useToastStore, type TimedToastInput } from '../stores/toast-store';

function isSameLocalDay(value: string, now: Date): boolean {
  const date = new Date(value);
  return !Number.isNaN(date.getTime())
    && date.getFullYear() === now.getFullYear()
    && date.getMonth() === now.getMonth()
    && date.getDate() === now.getDate();
}

/**
 * The toast for the one notice after a crash whose report Sentry accepted
 * (`src/main/analytics/crash-notice.ts`). Main records the fact; this titles it.
 * Info, timed, opens nothing, and always carries the reported line, since only a
 * sent report earns the notice.
 */
export function crashNoticeToast(notice: CrashNotice, now: Date = new Date()): TimedToastInput {
  if (notice.kind === 'window') {
    return {
      title: i18n._(msg`The window crashed and reloaded`),
      message: i18n._(msg`Your agents kept running.`),
      variant: 'info',
      reported: true,
    };
  }
  // A time of day only when the crash was today: "at 15:42" reads right, "at
  // yesterday 18:20" does not, and an older dump says no time at all.
  const crashedAt = notice.crashedAt && isSameLocalDay(notice.crashedAt, now) ? formatClockTime(notice.crashedAt, now) : '';
  return {
    title: i18n._(msg`Kangentic crashed`),
    message: crashedAt
      ? i18n._(msg`The last run ended in a crash at ${{ crashedAt }}.`)
      : i18n._(msg`The last run ended in a crash.`),
    variant: 'info',
    reported: true,
  };
}

/**
 * Take the waiting notice, if any, and show it. The take clears it in main, so a
 * reload never shows it twice, and a pop-out's take answers null.
 */
export async function showWaitingCrashNotice(): Promise<void> {
  let notice: CrashNotice | null;
  try {
    // Optional like App.tsx's subscription: a dev session whose preload predates
    // the channel has no bridge for it, and that is no failure.
    notice = (await window.electronAPI.crashNotice?.take()) ?? null;
  } catch (error) {
    // report-ok: a missing notice costs the user one info toast, and a renderer report of this read would ride every launch if the channel broke
    console.warn('[CRASH-NOTICE] Could not read the crash notice:', error);
    return;
  }
  if (notice) useToastStore.getState().addToast(crashNoticeToast(notice));
}

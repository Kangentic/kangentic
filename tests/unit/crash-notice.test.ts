/**
 * The one notice after a crash (#1188) is earned by a crash report Sentry
 * accepted, never by the previous run's exit alone: an abrupt exit is also a
 * kill, an OS shutdown or a power loss, and the toast would then claim a crash
 * and a report that never happened. A user who sees the window die and the app
 * reopen gets one notice; one whose laptop lost power gets none.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ErrorEvent } from '@sentry/electron/main';
import {
  createCrashNoticeHolder,
  crashNoticeFromSentEvent,
  WINDOW_RELOAD_ARM_MS,
  type SentEventLike,
} from '../../src/main/analytics/crash-notice';
import { correctNativeCrashEvent, restoreOwnRendererProcessTag, type NativeCrashContext } from '../../src/main/analytics/native-crash-event';
import { crashNoticeToast, showWaitingCrashNotice } from '../../src/renderer/utils/crash-notice';
import { useToastStore } from '../../src/renderer/stores/toast-store';

const accepted = { statusCode: 200 };
const crashTime = '2026-11-23T15:42:00.000Z';

function startupDump(previousRunExit: string | undefined, level = 'fatal'): SentEventLike {
  return {
    level,
    contexts: { native_crash: { crash_time: crashTime, found_at_startup: true, ...(previousRunExit ? { previous_run_exit: previousRunExit } : {}) } },
    tags: { 'event.environment': 'native', 'event.process': 'browser' },
  };
}

function liveRendererCrash(level = 'fatal'): SentEventLike {
  return {
    level,
    contexts: { native_crash: { crash_time: crashTime, found_at_startup: false } },
    tags: { 'event.environment': 'native', 'event.process': 'renderer' },
  };
}

describe('crashNoticeFromSentEvent', () => {
  it('names the app crash for a dump found at startup from a run that ended abruptly', () => {
    expect(crashNoticeFromSentEvent(startupDump('abrupt'), accepted, { windowReloadPending: false }))
      .toEqual({ kind: 'app', crashedAt: crashTime });
  });

  it('shows nothing for a startup dump from a run that quit cleanly (a GPU or helper crash nobody saw)', () => {
    expect(crashNoticeFromSentEvent(startupDump('clean'), accepted, { windowReloadPending: false })).toBeNull();
    expect(crashNoticeFromSentEvent(startupDump(undefined), accepted, { windowReloadPending: false })).toBeNull();
  });

  it('names the window crash only while the reload gate armed it', () => {
    expect(crashNoticeFromSentEvent(liveRendererCrash(), accepted, { windowReloadPending: true }))
      .toEqual({ kind: 'window', crashedAt: crashTime });
    expect(crashNoticeFromSentEvent(liveRendererCrash(), accepted, { windowReloadPending: false })).toBeNull();
  });

  it('shows nothing for a foreign dump (demoted to a warning), a refused send, or an event with no dump', () => {
    expect(crashNoticeFromSentEvent(startupDump('abrupt', 'warning'), accepted, { windowReloadPending: false })).toBeNull();
    expect(crashNoticeFromSentEvent(startupDump('abrupt'), { statusCode: 429 }, { windowReloadPending: false })).toBeNull();
    expect(crashNoticeFromSentEvent(startupDump('abrupt'), {}, { windowReloadPending: false })).toBeNull();
    expect(crashNoticeFromSentEvent(startupDump('abrupt'), undefined, { windowReloadPending: false })).toBeNull();
    expect(crashNoticeFromSentEvent({ level: 'fatal', contexts: {} }, accepted, { windowReloadPending: true })).toBeNull();
  });
});

describe('crashNoticeToast', () => {
  it('titles each kind, names the crash time only for a crash today, and always draws the reported line', () => {
    const now = new Date(2026, 10, 23, 16, 0);
    const today = new Date(2026, 10, 23, 15, 42).toISOString();
    const yesterday = new Date(2026, 10, 22, 18, 20).toISOString();

    const appToday = crashNoticeToast({ kind: 'app', crashedAt: today }, now);
    expect(appToday).toMatchObject({ title: 'Kangentic crashed', variant: 'info', reported: true });
    expect(appToday.message).toMatch(/^The last run ended in a crash at .+\.$/);

    expect(crashNoticeToast({ kind: 'app', crashedAt: yesterday }, now).message).toBe('The last run ended in a crash.');
    expect(crashNoticeToast({ kind: 'app', crashedAt: null }, now).message).toBe('The last run ended in a crash.');
    expect(crashNoticeToast({ kind: 'window', crashedAt: today }, now)).toEqual({
      title: 'The window crashed and reloaded',
      message: 'Your agents kept running.',
      variant: 'info',
      reported: true,
    });
  });
});

describe('createCrashNoticeHolder', () => {
  it('keeps the notice until the main window takes it, pings once, and never earns a second', () => {
    const holder = createCrashNoticeHolder();
    let pings = 0;
    holder.setOnWaiting(() => { pings += 1; });

    holder.onSentEvent(startupDump('abrupt'), accepted);
    holder.onSentEvent(startupDump('abrupt'), accepted);
    expect(pings).toBe(1);
    expect(holder.take()).toEqual({ kind: 'app', crashedAt: crashTime });
    expect(holder.take()).toBeNull();

    holder.armWindowReload();
    holder.onSentEvent(liveRendererCrash(), accepted);
    expect(holder.take()).toBeNull();
    expect(pings).toBe(1);
  });

  it('earns the window notice for a renderer crash sent inside the arm window, and none after it', () => {
    let clock = 1_000_000;
    const withinHolder = createCrashNoticeHolder(() => clock);
    withinHolder.armWindowReload();
    clock += WINDOW_RELOAD_ARM_MS;
    withinHolder.onSentEvent(liveRendererCrash(), accepted);
    expect(withinHolder.take()).toEqual({ kind: 'window', crashedAt: crashTime });

    clock = 1_000_000;
    const lateHolder = createCrashNoticeHolder(() => clock);
    let pings = 0;
    lateHolder.setOnWaiting(() => { pings += 1; });
    lateHolder.armWindowReload();
    clock += WINDOW_RELOAD_ARM_MS + 1;
    lateHolder.onSentEvent(liveRendererCrash(), accepted);
    expect(lateHolder.take()).toBeNull();
    expect(pings).toBe(0);
  });

  it('turns an armed reload into the window notice once, then disarms', () => {
    const holder = createCrashNoticeHolder();
    holder.onSentEvent(liveRendererCrash(), accepted);
    expect(holder.take()).toBeNull();

    holder.armWindowReload();
    holder.onSentEvent(liveRendererCrash(), accepted);
    expect(holder.take()).toEqual({ kind: 'window', crashedAt: crashTime });
  });
});

/**
 * The dispatch reads keys another module writes. These events are built by the
 * production writers in native-crash-event.ts, so renaming `found_at_startup`,
 * `previous_run_exit` or `crash_time` there fails here instead of silently
 * ending the notice.
 */
describe('crashNoticeFromSentEvent over events the production writers build', () => {
  const crashedAt = new Date('2026-11-23T15:42:00.000Z');
  const context: NativeCrashContext = {
    installRoot: '/opt/Kangentic',
    appExecutableName: 'kangentic',
    appVersion: '0.60.0',
    caseInsensitivePaths: false,
    previousRun: { exit: 'abrupt', uptimeSeconds: 600, lastAliveAt: '2026-11-23T15:41:50.000Z' },
    shuttingDown: false,
  };
  // No module list means nothing says the dump is foreign, so the event is kept.
  const identity = { ok: true as const, moduleNames: [], mainModule: undefined, annotations: {}, crashTime: crashedAt };

  function built(event: ErrorEvent, nativeContext: NativeCrashContext = context): SentEventLike {
    const decision = correctNativeCrashEvent(event, identity, nativeContext);
    expect(decision.action).toBe('keep');
    return decision.event;
  }

  it('names the app crash for a startup dump whose previous run ended abruptly', () => {
    const event = built({ level: 'fatal', platform: 'native', tags: { 'event.environment': 'native', 'event.process': 'browser' } });
    expect(crashNoticeFromSentEvent(event, accepted, { windowReloadPending: false }))
      .toEqual({ kind: 'app', crashedAt: crashedAt.toISOString() });
  });

  it('shows nothing for a startup dump whose previous run quit cleanly', () => {
    const event = built(
      { level: 'fatal', platform: 'native' },
      { ...context, previousRun: { exit: 'clean', uptimeSeconds: 600, lastAliveAt: '2026-11-23T15:41:50.000Z' } },
    );
    expect(crashNoticeFromSentEvent(event, accepted, { windowReloadPending: false })).toBeNull();
  });

  it('names the window crash for a live renderer crash, tagged renderer again after the SDK said unknown', () => {
    const live: ErrorEvent = {
      level: 'fatal',
      platform: 'native',
      tags: { 'event.environment': 'native', 'event.process': 'unknown', 'exit.reason': 'crashed' },
      contexts: { electron: { 'crashpad.process_type': 'renderer' } },
    };
    restoreOwnRendererProcessTag(live);
    const event = built(live);
    expect(crashNoticeFromSentEvent(event, accepted, { windowReloadPending: true }))
      .toEqual({ kind: 'window', crashedAt: crashedAt.toISOString() });
    expect(crashNoticeFromSentEvent(event, accepted, { windowReloadPending: false })).toBeNull();
  });
});

describe('showWaitingCrashNotice', () => {
  const originalWindow = (globalThis as { window?: unknown }).window;

  function stubTake(take: () => Promise<unknown>): void {
    (globalThis as { window?: unknown }).window = { electronAPI: { crashNotice: { take } } };
  }

  afterEach(() => {
    (globalThis as { window?: unknown }).window = originalWindow;
    vi.restoreAllMocks();
  });

  it('adds no toast and does not throw when the take rejects or finds nothing', async () => {
    const addToast = vi.spyOn(useToastStore.getState(), 'addToast');
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    stubTake(() => Promise.reject(new Error('channel gone')));
    await expect(showWaitingCrashNotice()).resolves.toBeUndefined();

    stubTake(() => Promise.resolve(null));
    await expect(showWaitingCrashNotice()).resolves.toBeUndefined();

    expect(addToast).not.toHaveBeenCalled();
  });

  it('adds exactly one reported toast for a waiting notice', async () => {
    const addToast = vi.spyOn(useToastStore.getState(), 'addToast').mockReturnValue('toast-id');
    stubTake(() => Promise.resolve({ kind: 'window', crashedAt: null }));

    await showWaitingCrashNotice();

    expect(addToast).toHaveBeenCalledTimes(1);
    expect(addToast).toHaveBeenCalledWith(expect.objectContaining({ reported: true }));
  });
});

/** index.ts cannot be imported, so its crash notice wiring is pinned in its source text. */
describe('the crash notice wiring in main index.ts', () => {
  const indexSource = fs.readFileSync(path.join(__dirname, '../../src/main/index.ts'), 'utf8');

  it('arms the window notice only inside the branch that reloads the window', () => {
    const gate = indexSource.indexOf('if (rendererReloadGate.tryReload()) {');
    const arm = indexSource.indexOf('crashNoticeHolder.armWindowReload()');
    expect(gate).toBeGreaterThan(-1);
    expect(arm).toBeGreaterThan(gate);
    // No block closes between the gate's opening brace and the call.
    expect(indexSource.slice(gate, arm)).not.toContain('}');
    expect(indexSource.indexOf('crashNoticeHolder.armWindowReload()', arm + 1)).toBe(-1);
  });

  it('answers the take only for the main window and gives a pop-out null', () => {
    const handler = indexSource.indexOf('ipcMain.handle(IPC.CRASH_NOTICE_TAKE');
    expect(handler).toBeGreaterThan(-1);
    const body = indexSource.slice(handler, indexSource.indexOf('));', handler));
    expect(body).toMatch(/event\.sender === mainWindow\?\.webContents\s*\?\s*crashNoticeHolder\.take\(\)\s*:\s*null/);
  });

  it('pings the main window while it is still loading, since the mount take may have run already', () => {
    const start = indexSource.indexOf('crashNoticeHolder.setOnWaiting(');
    expect(start).toBeGreaterThan(-1);
    const callback = indexSource.slice(start, indexSource.indexOf('\n});', start));
    expect(callback).toContain('IPC.CRASH_NOTICE_READY');
    expect(callback).not.toContain('isLoading');
  });
});

/**
 * `showConversationExpiredNotices` (src/renderer/lib/conversation-expired-toast.ts)
 * takes a project's queued expired-conversation notices from main and toasts
 * each as its own one-sentence info toast.
 *
 * Behaviors pinned:
 *   - A preload without `tasks.takeConversationExpired` is a quiet no-op: it
 *     resolves, toasts nothing, and does not even warn (a missing method is not a
 *     failure to report).
 *   - A rejected take is swallowed with a `console.warn` and toasts nothing: the
 *     toast is advisory, so it must never surface as an unhandled rejection.
 *   - Each notice for the project that is still current becomes its own toast:
 *     variant 'info', 12000 ms, message from `describeConversationExpired`.
 *   - Notices taken while the user moved to another project (or to none) are
 *     dropped, since they name tasks of a board no longer on screen.
 *   - An empty take adds nothing.
 *
 * The stub follows project-store-load-degradation.test.ts: contextBridge freezes
 * `window.electronAPI`, so the rejecting and absent shapes are unreachable from a
 * running app. The toast store and the project store are the REAL ones, so the
 * assertions read what a user would see, not what a mock recorded.
 *
 * Red-green: drop the `!takeConversationExpired` guard and the absent-method case
 * fails (the call throws inside the try, and the warn it logs is asserted
 * against); drop the try/catch and the rejection case fails; drop the
 * `notices.length === 0` return and the empty case still passes (the loop adds
 * nothing for an empty list), so that guard is only an early exit; drop the
 * current-project check and the switched-away cases fail; change the variant or
 * duration and the toast cases fail; toast only `notices[0]` and the
 * several-notices case fails.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/renderer/stores/session-lifecycle-hooks', () => ({
  killTransientSessionForProject: vi.fn(),
  markIdleSessionsSeen: vi.fn(),
}));
// The toast store reads the configured duration and cap when it adds a toast;
// project-store only reaches for `loadConfig`.
vi.mock('../../src/renderer/stores/config-store', () => ({
  useConfigStore: {
    getState: () => ({
      loadConfig: vi.fn(),
      config: { notifications: { toasts: { durationSeconds: 4, maxCount: 5 } } },
    }),
  },
}));
vi.mock('../../src/renderer/stores/project-cache', () => ({
  dropProject: vi.fn(),
}));

import { showConversationExpiredNotices } from '../../src/renderer/lib/conversation-expired-toast';
import { describeConversationExpired } from '../../src/renderer/lib/conversation-expired';
import { useProjectStore } from '../../src/renderer/stores/project-store';
import { useToastStore } from '../../src/renderer/stores/toast-store';
import type { ConversationExpiredNotice, Project } from '../../src/shared/types';

const PROJECT_ID = 'project-1';
const OTHER_PROJECT_ID = 'project-2';

const NOTICE: ConversationExpiredNotice = {
  projectId: PROJECT_ID,
  taskId: 'task-1',
  taskTitle: 'Resume me',
  lastActiveAt: null,
};

function makeProject(id: string): Project {
  return {
    id,
    name: `Project ${id}`,
    path: `/home/dev/${id}`,
    github_url: null,
    default_agent: 'claude',
    default_model: null,
    default_effort: null,
    group_id: null,
    position: 0,
    last_opened: '2026-01-01T00:00:00.000Z',
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

function stubTake(take: ((projectId: string) => Promise<ConversationExpiredNotice[]>) | undefined): void {
  vi.stubGlobal('window', { electronAPI: { tasks: take ? { takeConversationExpired: take } : {} } });
}

function createDeferred<Value>(): { promise: Promise<Value>; resolve: (value: Value) => void } {
  let resolve!: (value: Value) => void;
  const promise = new Promise<Value>((resolveFn) => { resolve = resolveFn; });
  return { promise, resolve };
}

let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  useToastStore.setState({ toasts: [] });
  useProjectStore.setState({ currentProject: makeProject(PROJECT_ID) });
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  vi.unstubAllGlobals();
});

describe('showConversationExpiredNotices', () => {
  it('resolves quietly when the preload has no takeConversationExpired method', async () => {
    stubTake(undefined);

    await expect(showConversationExpiredNotices(PROJECT_ID)).resolves.toBeUndefined();

    expect(useToastStore.getState().toasts).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('resolves quietly when the preload has no tasks namespace at all', async () => {
    vi.stubGlobal('window', { electronAPI: {} });

    await expect(showConversationExpiredNotices(PROJECT_ID)).resolves.toBeUndefined();

    expect(useToastStore.getState().toasts).toEqual([]);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('swallows a rejected take with a warning and adds no toast', async () => {
    const take = vi.fn(async () => { throw new Error('ipc closed'); });
    stubTake(take);

    await expect(showConversationExpiredNotices(PROJECT_ID)).resolves.toBeUndefined();

    expect(take).toHaveBeenCalledWith(PROJECT_ID);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('toasts one notice for the current project as an info toast that stays 12 seconds', async () => {
    const take = vi.fn(async () => [NOTICE]);
    stubTake(take);

    await showConversationExpiredNotices(PROJECT_ID);

    expect(take).toHaveBeenCalledWith(PROJECT_ID);
    const toasts = useToastStore.getState().toasts;
    expect(toasts).toHaveLength(1);
    expect(toasts[0].variant).toBe('info');
    expect(toasts[0].duration).toBe(12000);
    expect(toasts[0].message).toBe(describeConversationExpired(NOTICE));
    expect(toasts[0].message).toBe('"Resume me" started a new conversation because its previous one expired.');
  });

  it('toasts each of several notices on its own, one sentence each', async () => {
    const notices = [
      NOTICE,
      { ...NOTICE, taskId: 'task-2', taskTitle: 'Another', lastActiveAt: '2026-08-16T14:00:00.000Z' },
    ];
    stubTake(vi.fn(async () => notices));

    await showConversationExpiredNotices(PROJECT_ID);

    const toasts = useToastStore.getState().toasts;
    expect(toasts.map((toast) => toast.message)).toEqual(notices.map((notice) => describeConversationExpired(notice)));
    // No summary: every message names its own task.
    expect(toasts[0].message).toContain('"Resume me"');
    expect(toasts[1].message).toContain('"Another"');
    expect(toasts.every((toast) => toast.variant === 'info' && toast.duration === 12000)).toBe(true);
  });

  it('adds no toast when the take comes back empty', async () => {
    stubTake(vi.fn(async () => []));

    await showConversationExpiredNotices(PROJECT_ID);

    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('drops notices taken after the user switched to another project', async () => {
    const taking = createDeferred<ConversationExpiredNotice[]>();
    stubTake(vi.fn(() => taking.promise));

    const shown = showConversationExpiredNotices(PROJECT_ID);
    useProjectStore.setState({ currentProject: makeProject(OTHER_PROJECT_ID) });
    taking.resolve([NOTICE]);
    await shown;

    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('drops notices taken after the project was closed', async () => {
    const taking = createDeferred<ConversationExpiredNotice[]>();
    stubTake(vi.fn(() => taking.promise));

    const shown = showConversationExpiredNotices(PROJECT_ID);
    useProjectStore.setState({ currentProject: null });
    taking.resolve([NOTICE]);
    await shown;

    expect(useToastStore.getState().toasts).toEqual([]);
  });

  it('still toasts when the project stays current across the wait', async () => {
    const taking = createDeferred<ConversationExpiredNotice[]>();
    stubTake(vi.fn(() => taking.promise));

    const shown = showConversationExpiredNotices(PROJECT_ID);
    taking.resolve([NOTICE]);
    await shown;

    expect(useToastStore.getState().toasts).toHaveLength(1);
  });
});

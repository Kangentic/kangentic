/**
 * When a launch counts as settled. Background work that starts processes (the
 * agent inventory refresh, the account usage pass) waits for it, so a wrong
 * answer either lands that work on the agents' own start-up or holds it back
 * for good.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  BOOT_SETTLE_CAP_MS,
  BOOT_SETTLE_FLOOR_MS,
  BOOT_SETTLE_QUIET_MS,
  beginBoot,
  disposeBootSettle,
  isBootSettled,
  noteAgentStarting,
  noteWindowLoaded,
  resetBootSettleForTests,
  trackBootWork,
  whenBootSettled,
} from '../../src/main/boot-settle';

/** Resolves `settled` to true once `whenBootSettled` has, without waiting on it. */
function watch(): { settled: boolean } {
  const watcher = { settled: false };
  void whenBootSettled().then(() => {
    watcher.settled = true;
  });
  return watcher;
}

async function advance(milliseconds: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(milliseconds);
}

describe('boot settle', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    resetBootSettleForTests();
  });

  afterEach(() => {
    resetBootSettleForTests();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('reads settled where no launch was ever tracked', async () => {
    expect(isBootSettled()).toBe(true);
    const watcher = watch();
    await advance(0);
    expect(watcher.settled).toBe(true);
  });

  it('settles a quiet launch at the floor after the window loads, not before', async () => {
    beginBoot();
    const watcher = watch();
    expect(isBootSettled()).toBe(false);

    // Time before the window loads does not count toward the floor.
    await advance(5_000);
    noteWindowLoaded();
    await advance(BOOT_SETTLE_FLOOR_MS - 1);
    expect(watcher.settled).toBe(false);

    await advance(1);
    expect(watcher.settled).toBe(true);
    expect(isBootSettled()).toBe(true);
  });

  it('waits for tracked work to return, however it ends', async () => {
    beginBoot();
    const watcher = watch();
    let failRecovery: (error: Error) => void = () => undefined;
    trackBootWork(new Promise<void>((_resolve, reject) => {
      failRecovery = reject;
    }));
    noteWindowLoaded();

    await advance(BOOT_SETTLE_FLOOR_MS + 5_000);
    expect(watcher.settled).toBe(false);

    failRecovery(new Error('recovery failed'));
    await advance(0);
    expect(watcher.settled).toBe(true);
  });

  it('starts the quiet period over each time an agent starts', async () => {
    beginBoot();
    const watcher = watch();
    noteWindowLoaded();

    await advance(BOOT_SETTLE_FLOOR_MS - 1_000);
    noteAgentStarting();
    await advance(BOOT_SETTLE_QUIET_MS - 1_000);
    noteAgentStarting();
    await advance(BOOT_SETTLE_QUIET_MS - 1);
    expect(watcher.settled).toBe(false);

    await advance(1);
    expect(watcher.settled).toBe(true);
  });

  it('settles at the cap when the window never loads or the work never returns', async () => {
    beginBoot();
    const watcher = watch();
    trackBootWork(new Promise<void>(() => undefined));

    await advance(BOOT_SETTLE_CAP_MS - 1);
    expect(watcher.settled).toBe(false);

    await advance(1);
    expect(watcher.settled).toBe(true);
  });

  it('keeps one launch: a second begin and a rebuilt window change nothing', async () => {
    beginBoot();
    noteWindowLoaded();
    await advance(BOOT_SETTLE_FLOOR_MS);
    expect(isBootSettled()).toBe(true);

    beginBoot();
    noteWindowLoaded();
    noteAgentStarting();

    expect(isBootSettled()).toBe(true);
  });

  it('starts nothing during a quit: a disposed launch never resolves its waiters', async () => {
    beginBoot();
    const watcher = watch();
    noteWindowLoaded();

    disposeBootSettle();
    await advance(BOOT_SETTLE_CAP_MS * 2);

    expect(watcher.settled).toBe(false);
  });

  it('arms no timer and never settles when an agent starts, the window loads, or tracked work ends after a dispose', async () => {
    beginBoot();
    let finishRecovery: () => void = () => undefined;
    trackBootWork(new Promise<void>((resolve) => {
      finishRecovery = resolve;
    }));

    disposeBootSettle();
    // A waiter asked for after the dispose is never kept either.
    const lateWatcher = watch();

    noteAgentStarting();
    noteWindowLoaded();
    finishRecovery();
    await advance(0);
    expect(vi.getTimerCount()).toBe(0);

    await advance(BOOT_SETTLE_CAP_MS * 2);

    expect(isBootSettled()).toBe(false);
    expect(lateWatcher.settled).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
});

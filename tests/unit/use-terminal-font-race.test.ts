/**
 * The font-load race guard in useTerminal's live-apply effect, run through the
 * real helpers the effect calls (utils/terminal-font-apply.ts). Rapid typing in
 * Settings > Font Family starts a font load per keystroke, and the loads can
 * settle out of order: a stale load must never apply over a newer font.
 *
 * What stays outside this file, because the unit tier has neither jsdom nor
 * xterm: the effect's wiring (its dependency array, the `!xtermRef.current`
 * bail, the conformed-size read, the atlas notify call). The helpers here are
 * what the effect passes its decisions through.
 */
import { describe, it, expect, vi } from 'vitest';
import { scheduleFontApply, terminalFontMoved } from '../../src/renderer/utils/terminal-font-apply';

/** A promise plus its external resolve/reject, so a test controls exactly when
 *  a simulated document.fonts.load() settles. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Let every already-settled promise reaction run. */
async function flushMicrotasks(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('terminalFontMoved', () => {
  it('counts a terminal that has applied nothing as moved', () => {
    expect(terminalFontMoved(null, 'Fira Code', 14)).toBe(true);
  });

  it('is false for the same family and size', () => {
    expect(terminalFontMoved({ family: 'Fira Code', size: 14 }, 'Fira Code', 14)).toBe(false);
  });

  it('is true when only the family changed', () => {
    expect(terminalFontMoved({ family: 'Fira Code', size: 14 }, 'JetBrains Mono', 14)).toBe(true);
  });

  it('is true when only the size changed', () => {
    expect(terminalFontMoved({ family: 'Fira Code', size: 14 }, 'Fira Code', 13)).toBe(true);
  });
});

describe('scheduleFontApply', () => {
  it('a font change waits for the load before applying', async () => {
    const load = deferred<void>();
    const loadFont = vi.fn(() => load.promise);
    const apply = vi.fn();

    scheduleFontApply(true, loadFont, apply);

    expect(loadFont).toHaveBeenCalledTimes(1);
    expect(apply).not.toHaveBeenCalled();

    load.resolve();
    await flushMicrotasks();

    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('a re-run with no font change applies synchronously and never loads', () => {
    const loadFont = vi.fn(() => Promise.resolve());
    const apply = vi.fn();

    scheduleFontApply(false, loadFont, apply);

    expect(loadFont).not.toHaveBeenCalled();
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('drops a stale in-flight font change when a newer one supersedes it before the load settles', async () => {
    // Rapid typing: font A's load is still in flight when font B's effect run
    // starts. React calls A's cleanup (the returned cancel) BEFORE B's body.
    const loadA = deferred<void>();
    const loadB = deferred<void>();
    const applied: string[] = [];

    const cancelA = scheduleFontApply(true, () => loadA.promise, () => applied.push('A'));
    cancelA();
    scheduleFontApply(true, () => loadB.promise, () => applied.push('B'));

    // A settles LATE, after being superseded: dropped.
    loadA.resolve();
    await flushMicrotasks();
    expect(applied).toEqual([]);

    loadB.resolve();
    await flushMicrotasks();
    expect(applied).toEqual(['B']);
  });

  it('applies even when the load rejects (an unresolvable font)', async () => {
    const load = deferred<void>();
    const apply = vi.fn();

    scheduleFontApply(true, () => load.promise, apply);
    load.reject(new Error('font failed to resolve'));
    await flushMicrotasks();

    expect(apply).toHaveBeenCalledTimes(1);
  });

  it('drops a load that settles after unmount (cancelled, no newer effect)', async () => {
    const load = deferred<void>();
    const apply = vi.fn();

    const cancel = scheduleFontApply(true, () => load.promise, apply);
    cancel();
    load.resolve();
    await flushMicrotasks();

    expect(apply).not.toHaveBeenCalled();
  });

  it('drops a rejected load that settles after unmount too', async () => {
    const load = deferred<void>();
    const apply = vi.fn();

    const cancel = scheduleFontApply(true, () => load.promise, apply);
    cancel();
    load.reject(new Error('font failed to resolve'));
    await flushMicrotasks();

    expect(apply).not.toHaveBeenCalled();
  });

  it('a cancel after a synchronous apply changes nothing', () => {
    const apply = vi.fn();
    const cancel = scheduleFontApply(false, () => Promise.resolve(), apply);
    cancel();
    expect(apply).toHaveBeenCalledTimes(1);
  });
});

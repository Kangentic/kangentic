/**
 * Unit coverage for the font-load race guard in useTerminal.ts's live-apply
 * effect (useTerminal.ts:596-659, "Live-apply display settings to an already-
 * mounted terminal").
 *
 * IMPORTANT CAVEAT: this file mirrors the effect's control flow as a plain,
 * NOT-exported function; it does not import from or mount useTerminal.ts
 * itself, so it cannot catch a real wiring regression there (a dependency-
 * array bug, a stale ref, a wrong notifyFontChanged call site). It locks the
 * intended algorithm, red-green verified against that mirror.
 *
 * useTerminal is a React hook that constructs a real xterm.js Terminal and
 * calls window.electronAPI.sessions.* - both require jsdom + testing-library
 * to mount at the hook level, and this project deliberately has neither (see
 * use-browser-url-logic.test.ts, use-task-split-resize.test.ts). A UI-tier
 * (tests/ui/) mount was considered instead: TerminalTab.tsx does feed
 * config.terminal.fontFamily into useTerminal live, and headless Chromium
 * ships SwiftShader so WebGL actually attaches by default (see
 * window-park-reveal.spec.ts) - so the fix's notifyFontChanged/
 * clearTextureAtlas path is NOT a no-op there. But nothing exposes the
 * xterm instance's applied `options.fontFamily` (or the WebGL renderer
 * report) to `window` for a test to read, and WebGL output renders to a
 * canvas (no assertable DOM text), so there is no observable signal to
 * poll for "did font X actually get applied" without adding new
 * test-only instrumentation. And the specific behavior under test here -
 * two overlapping document.fonts.load() calls resolving OUT OF ORDER -
 * cannot be driven deterministically against the REAL document.fonts API
 * even if it were observable: its resolution timing is not controllable
 * from a test, which would make a UI-tier version of this race assertion
 * an unpollable-timing flake.
 *
 * So this test mirrors the effect's exact control flow as a plain function
 * (fontChanged check -> cancelled flag -> load-then-apply vs apply-now) and
 * drives it with manually-resolved deferred promises, which lets us force
 * the precise interleaving that matters: a SECOND font change effect
 * cleaning up (and thus cancelling) the FIRST one's in-flight load, then the
 * first load resolving late and being dropped.
 *
 * If useTerminal ever needs full hook-level mounting, add @testing-library/react
 * + jsdom to vitest.config.ts and move these tests to exercise the real
 * effect directly, per the note in use-browser-url-logic.test.ts.
 */
import { describe, it, expect, vi } from 'vitest';

/**
 * Mirrors the useEffect body at useTerminal.ts:596-659.
 *
 * Real code:
 *   const fontChanged = !lastAppliedFontRef.current || ...;
 *   let cancelled = false;
 *   const applyOptions = () => {
 *     if (cancelled || !xtermRef.current) return;
 *     xtermRef.current.options = { fontFamily, fontSize, ... };
 *     fit();
 *     if (fontChanged) {
 *       lastAppliedFontRef.current = { family: fontFamily, size: fontSize };
 *       if (rendererKeyRef.current) notifyFontChanged(rendererKeyRef.current);
 *     }
 *   };
 *   if (fontChanged) {
 *     document.fonts.load(`${fontSize}px ${fontFamily}`).then(applyOptions, applyOptions);
 *   } else {
 *     applyOptions();
 *   }
 *   return () => { cancelled = true; };
 */
function runFontEffect(
  fontFamily: string,
  fontSize: number,
  lastApplied: { family: string; size: number } | null,
  loadFont: (fontFamily: string, fontSize: number) => Promise<void>,
  onApply: (fontFamily: string, fontSize: number, fontChanged: boolean) => void,
): () => void {
  const fontChanged =
    !lastApplied || lastApplied.family !== fontFamily || lastApplied.size !== fontSize;
  let cancelled = false;

  const applyOptions = () => {
    if (cancelled) return;
    onApply(fontFamily, fontSize, fontChanged);
  };

  if (fontChanged) {
    loadFont(fontFamily, fontSize).then(applyOptions, applyOptions);
  } else {
    applyOptions();
  }

  return () => {
    cancelled = true;
  };
}

/** A promise plus its external resolve/reject, so a test can control exactly
 *  when a simulated document.fonts.load() settles. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason?: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useTerminal font-change race guard', () => {
  it('an actual font change waits for loadFont before applying, and reports fontChanged=true', async () => {
    const applied: Array<{ family: string; size: number; fontChanged: boolean }> = [];
    const load = deferred<void>();
    const loadFont = vi.fn(() => load.promise);

    runFontEffect('Fira Code', 14, null, loadFont, (family, size, fontChanged) => {
      applied.push({ family, size, fontChanged });
    });

    expect(loadFont).toHaveBeenCalledWith('Fira Code', 14);
    // Not applied yet - still waiting on the font load.
    expect(applied).toHaveLength(0);

    load.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(applied).toEqual([{ family: 'Fira Code', size: 14, fontChanged: true }]);
  });

  it('a cursor/scrollback/color-only re-run (no font change) applies synchronously with no load call', () => {
    const applied: Array<{ family: string; size: number; fontChanged: boolean }> = [];
    const loadFont = vi.fn(() => Promise.resolve());

    runFontEffect('Fira Code', 14, { family: 'Fira Code', size: 14 }, loadFont, (family, size, fontChanged) => {
      applied.push({ family, size, fontChanged });
    });

    expect(loadFont).not.toHaveBeenCalled();
    expect(applied).toEqual([{ family: 'Fira Code', size: 14, fontChanged: false }]);
  });

  it('a stale in-flight font change is dropped when a newer one supersedes it before the load resolves', async () => {
    // Reproduces rapid Font Family combobox typing: font A's load is still in
    // flight when font B's effect run starts. React calls A's cleanup (the
    // returned `cancelled = true` closure) BEFORE running B's effect body.
    const applied: Array<{ family: string; size: number; fontChanged: boolean }> = [];
    const loadA = deferred<void>();
    const loadB = deferred<void>();
    const loadFont = vi.fn((fontFamily: string) => (fontFamily === 'Font A' ? loadA.promise : loadB.promise));

    const cleanupA = runFontEffect('Font A', 14, null, loadFont, (family, size, fontChanged) => {
      applied.push({ family, size, fontChanged });
    });

    // A newer font change supersedes A: React's cleanup-then-effect ordering.
    cleanupA();
    runFontEffect('Font B', 14, null, loadFont, (family, size, fontChanged) => {
      applied.push({ family, size, fontChanged });
    });

    // A's load resolves LATE (after being superseded) - must be dropped.
    loadA.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(applied).toHaveLength(0);

    // B's load resolves and is applied - exactly once, with B's values.
    loadB.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(applied).toEqual([{ family: 'Font B', size: 14, fontChanged: true }]);
  });

  it('applies even when loadFont rejects (document.fonts.load can reject for an unresolvable font)', async () => {
    const applied: Array<{ family: string; size: number; fontChanged: boolean }> = [];
    const load = deferred<void>();
    const loadFont = vi.fn(() => load.promise);

    runFontEffect('Nonexistent Font', 14, null, loadFont, (family, size, fontChanged) => {
      applied.push({ family, size, fontChanged });
    });

    load.reject(new Error('font failed to resolve'));
    await Promise.resolve().catch(() => undefined);
    await Promise.resolve().catch(() => undefined);

    expect(applied).toEqual([{ family: 'Nonexistent Font', size: 14, fontChanged: true }]);
  });

  it('a late-resolving load after unmount (cleanup fired, no newer effect) is dropped, not applied', async () => {
    const applied: Array<{ family: string; size: number; fontChanged: boolean }> = [];
    const load = deferred<void>();
    const loadFont = vi.fn(() => load.promise);

    const cleanup = runFontEffect('Fira Code', 14, null, loadFont, (family, size, fontChanged) => {
      applied.push({ family, size, fontChanged });
    });

    cleanup(); // simulates component unmount
    load.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(applied).toHaveLength(0);
  });
});

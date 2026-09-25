import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Enforces that useOverlayPhase's EXIT_FALLBACK_MS timer stays above every overlay
// exit animation duration declared in index.css's ":root" motion-token block, so
// raising an exit duration past the deadline cannot silently start cutting the
// fade short: the fallback would then fire mid-animation and unmount the overlay
// before its real exit finished playing. See useOverlayPhase.ts's own
// EXIT_FALLBACK_MS comment for the full rationale.
//
// Also pins that WindowFrame.tsx no longer carries a private exit-fallback
// setTimeout of its own - useOverlayPhase's fallback is now the ONE mechanism,
// and a reintroduced private timer would silently race it.

const REPO_ROOT = path.resolve(__dirname, '../..');
const HOOK_FILE = path.join(REPO_ROOT, 'src/renderer/hooks/useOverlayPhase.ts');
const CSS_FILE = path.join(REPO_ROOT, 'src/renderer/index.css');
const WINDOW_FRAME_FILE = path.join(REPO_ROOT, 'src/renderer/window-manager/components/WindowFrame.tsx');

const EXIT_DURATION_PROPERTIES = [
  '--overlay-exit-duration',
  '--popover-exit-duration',
  '--panel-exit-duration',
  '--command-bar-exit-duration',
] as const;

function readExitFallbackMs(hookSource: string): number {
  const match = hookSource.match(/const\s+EXIT_FALLBACK_MS\s*=\s*(\d+)\s*;/);
  if (!match) {
    throw new Error(
      'Could not find `const EXIT_FALLBACK_MS = <number>;` in useOverlayPhase.ts. If the ' +
        'constant was renamed or restructured, update this test\'s pattern rather than deleting ' +
        'the assertion - it exists to keep the fallback deadline above every overlay exit ' +
        'animation duration.',
    );
  }
  return Number(match[1]);
}

/** The single ":root { ... }" block that declares the overlay motion tokens
 *  (index.css's "Overlay motion tokens (single source of truth)" section).
 *  Scoped deliberately: `:root, .theme-dark { ... }` earlier in the file does
 *  not match (a comma follows `:root` there, not `{`), so a duration redeclared
 *  under a different selector is not silently counted as the real one. */
function readOverlayMotionRootBlock(cssSource: string): string {
  const match = cssSource.match(/:root\s*\{([\s\S]*?)\n\}/);
  if (!match) {
    throw new Error(
      'Could not find a `:root { ... }` block in index.css. The overlay exit durations are ' +
        'expected to live in the "Overlay motion tokens (single source of truth)" :root block - ' +
        'if it moved, update this test rather than deleting the assertion.',
    );
  }
  return match[1];
}

function readExitDurationsMs(rootBlock: string): Array<{ property: string; ms: number }> {
  const durations: Array<{ property: string; ms: number }> = [];
  for (const property of EXIT_DURATION_PROPERTIES) {
    const pattern = new RegExp(`${property}:\\s*(\\d+)ms`);
    const match = rootBlock.match(pattern);
    if (!match) {
      throw new Error(
        `Could not find "${property}: <number>ms" inside index.css's :root block. If this custom ` +
          'property was renamed or removed, update EXIT_DURATION_PROPERTIES above rather than ' +
          'deleting the assertion - every overlay exit duration must stay covered by this deadline check.',
      );
    }
    durations.push({ property, ms: Number(match[1]) });
  }
  return durations;
}

describe('useOverlayPhase EXIT_FALLBACK_MS stays above every overlay exit duration', () => {
  const hookSource = fs.readFileSync(HOOK_FILE, 'utf-8');
  const cssSource = fs.readFileSync(CSS_FILE, 'utf-8');
  const rootBlock = readOverlayMotionRootBlock(cssSource);

  it('finds a real EXIT_FALLBACK_MS constant (never passes vacuously)', () => {
    const exitFallbackMs = readExitFallbackMs(hookSource);
    expect(exitFallbackMs).toBeGreaterThan(0);
  });

  it('finds every named overlay exit duration in the :root block (never passes vacuously)', () => {
    const durations = readExitDurationsMs(rootBlock);
    expect(durations.length).toBe(EXIT_DURATION_PROPERTIES.length);
    for (const { ms } of durations) expect(ms).toBeGreaterThan(0);
  });

  it('EXIT_FALLBACK_MS is greater than every overlay-*-exit-duration custom property', () => {
    const exitFallbackMs = readExitFallbackMs(hookSource);
    const durations = readExitDurationsMs(rootBlock);

    const offenders = durations.filter(({ ms }) => ms >= exitFallbackMs);

    expect(
      offenders,
      `EXIT_FALLBACK_MS (${exitFallbackMs}ms) must be greater than every overlay exit duration in ` +
        'index.css\'s :root block, or the fallback timer can fire before the real exit animation ' +
        `finishes and cut the fade short. Offending propert${offenders.length === 1 ? 'y' : 'ies'}:\n` +
        offenders.map(({ property, ms }) => `  ${property}: ${ms}ms`).join('\n'),
    ).toEqual([]);
  });
});

describe('WindowFrame carries no private exit-fallback timer', () => {
  it('has no setTimeout call in WindowFrame.tsx (the hook fallback is the one mechanism)', () => {
    const windowFrameSource = fs.readFileSync(WINDOW_FRAME_FILE, 'utf-8');
    expect(windowFrameSource).not.toMatch(/setTimeout\s*\(/);
  });
});

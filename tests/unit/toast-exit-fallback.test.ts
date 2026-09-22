/**
 * Guard for the drift hazard between ToastItem.tsx's `EXIT_FALLBACK_MS` backstop
 * and index.css's `--toast-duration`.
 *
 * `EXIT_FALLBACK_MS` removes a toast whose CSS exit transition never fires (a
 * hidden or occluded window never produces a `transitionend`), so it must
 * always fire comfortably AFTER the transition would have finished. Nothing
 * ties the two values together at compile time or at runtime, so raising
 * `--toast-duration` past `EXIT_FALLBACK_MS` would silently reintroduce the
 * bug the fallback exists to prevent, with no signal anywhere.
 *
 * This test parses both source files as text rather than importing the
 * constant, following the source-parsing parity pattern in
 * board-config-parity.test.ts. `EXIT_FALLBACK_MS` stays a private module
 * constant in ToastItem.tsx on purpose; it is not exported just to make this
 * test easier to write.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const TOAST_ITEM_PATH = path.join(REPO_ROOT, 'src', 'renderer', 'components', 'layout', 'ToastItem.tsx');
const INDEX_CSS_PATH = path.join(REPO_ROOT, 'src', 'renderer', 'index.css');

/** The fallback must stay at least this many times the CSS duration, so a
 *  transition that runs to completion always beats the fallback timer. */
const MINIMUM_SAFETY_MULTIPLE = 2;

function readExitFallbackMs(): number {
  const source = fs.readFileSync(TOAST_ITEM_PATH, 'utf-8');
  const match = source.match(/const EXIT_FALLBACK_MS\s*=\s*(\d+)\s*;/);
  if (!match) {
    throw new Error(
      `Could not find "const EXIT_FALLBACK_MS = <number>;" in ${TOAST_ITEM_PATH}. `
      + "Update this test's regex if the declaration changed shape.",
    );
  }
  return Number(match[1]);
}

function readToastDurationMs(): number {
  const source = fs.readFileSync(INDEX_CSS_PATH, 'utf-8');
  const match = source.match(/--toast-duration:\s*(\d+)ms\s*;/);
  if (!match) {
    throw new Error(
      `Could not find "--toast-duration: <number>ms;" in ${INDEX_CSS_PATH}. `
      + "Update this test's regex if the declaration changed shape.",
    );
  }
  return Number(match[1]);
}

describe('toast exit fallback stays clear of the CSS transition duration', () => {
  it('keeps EXIT_FALLBACK_MS at least 2x --toast-duration', () => {
    const exitFallbackMs = readExitFallbackMs();
    const toastDurationMs = readToastDurationMs();

    expect(
      exitFallbackMs,
      `EXIT_FALLBACK_MS (${exitFallbackMs}ms, ToastItem.tsx) must stay at least `
      + `${MINIMUM_SAFETY_MULTIPLE}x --toast-duration (${toastDurationMs}ms, index.css). Below `
      + 'that, the fallback timer can fire before the CSS exit transition finishes and silently '
      + 'reintroduce the bug the fallback exists to prevent. Raise EXIT_FALLBACK_MS, or lower '
      + '--toast-duration, whichever one moved.',
    ).toBeGreaterThanOrEqual(toastDurationMs * MINIMUM_SAFETY_MULTIPLE);
  });
});

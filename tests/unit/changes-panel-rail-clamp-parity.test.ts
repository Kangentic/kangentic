/**
 * Rail-width clamp parity guard.
 *
 * `ChangesPanel.tsx` declares `RAIL_DEFAULT_WIDTH_CLAMP` as the default width of
 * the Changes panel's file-tree rail. `TaskDetailBody.tsx`'s `ChangesPanelSkeleton`
 * (the Suspense fallback shown before the lazy `ChangesPanel` chunk loads) repeats
 * the exact same CSS clamp() string as a hand-typed literal, deliberately NOT
 * importing `ChangesPanel` (that would pull the lazy chunk, including Monaco,
 * into the skeleton that exists to avoid paying for it). The only thing keeping
 * the two in sync today is a comment asking a human to notice drift; if they
 * diverge, the skeleton visibly jumps to a different rail width the instant the
 * real panel's chunk finishes loading.
 *
 * This test (pure source-text regex extraction, no import - matches the shape
 * of external-scripts-parity.test.ts and board-config-parity.test.ts) makes
 * that drift unmergeable: it extracts both literals from source text and
 * asserts they are byte-identical.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const CHANGES_PANEL_PATH = path.join(REPO_ROOT, 'src/renderer/components/dialogs/task-detail/changes/ChangesPanel.tsx');
const TASK_DETAIL_BODY_PATH = path.join(REPO_ROOT, 'src/renderer/components/dialogs/task-detail/TaskDetailBody.tsx');

/** Extract `const RAIL_DEFAULT_WIDTH_CLAMP = '<value>';` from ChangesPanel.tsx. */
function extractRailDefaultWidthClamp(source: string): string | null {
  const match = source.match(/const RAIL_DEFAULT_WIDTH_CLAMP\s*=\s*'([^']*)'/);
  return match ? match[1] : null;
}

/**
 * Extract the ChangesPanelSkeleton function body, then the single
 * `width: '<value>'` literal within it. Scoping to the function body first
 * (rather than searching the whole file) means a future unrelated
 * `width: 'clamp(...)'` elsewhere in TaskDetailBody.tsx cannot be silently
 * picked up by a first-match-wins regex.
 */
function extractSkeletonRailWidth(source: string): string | null {
  const functionStart = source.indexOf('function ChangesPanelSkeleton()');
  if (functionStart === -1) return null;
  // The skeleton is a small, single-purpose function; the next top-level
  // function declaration (or the eof) bounds its body for this scan.
  const nextFunctionStart = source.indexOf('\nfunction ', functionStart + 1);
  const functionBody = nextFunctionStart === -1 ? source.slice(functionStart) : source.slice(functionStart, nextFunctionStart);

  const matches = [...functionBody.matchAll(/width:\s*'([^']*)'/g)];
  if (matches.length !== 1) return null; // 0 or >1: ambiguous, treat as extraction failure
  return matches[0][1];
}

describe('Changes panel rail-width clamp parity', () => {
  const changesPanelSource = fs.readFileSync(CHANGES_PANEL_PATH, 'utf-8');
  const taskDetailBodySource = fs.readFileSync(TASK_DETAIL_BODY_PATH, 'utf-8');

  it('extracts RAIL_DEFAULT_WIDTH_CLAMP from ChangesPanel.tsx', () => {
    const value = extractRailDefaultWidthClamp(changesPanelSource);
    expect(
      value,
      'Could not find `const RAIL_DEFAULT_WIDTH_CLAMP = \'...\'` in '
        + 'src/renderer/components/dialogs/task-detail/changes/ChangesPanel.tsx. '
        + 'If it was renamed or restructured, update this test AND the skeleton '
        + "literal in TaskDetailBody.tsx's ChangesPanelSkeleton.",
    ).not.toBeNull();
  });

  it("extracts the single rail width literal from TaskDetailBody.tsx's ChangesPanelSkeleton", () => {
    const value = extractSkeletonRailWidth(taskDetailBodySource);
    expect(
      value,
      "Could not find exactly one `width: '...'` literal inside ChangesPanelSkeleton() in "
        + 'src/renderer/components/dialogs/task-detail/TaskDetailBody.tsx. If the skeleton\'s '
        + 'markup changed, update this test AND keep the literal in sync with '
        + "ChangesPanel.tsx's RAIL_DEFAULT_WIDTH_CLAMP.",
    ).not.toBeNull();
  });

  it("TaskDetailBody.tsx's ChangesPanelSkeleton rail width matches ChangesPanel.tsx's RAIL_DEFAULT_WIDTH_CLAMP", () => {
    const railDefaultWidthClamp = extractRailDefaultWidthClamp(changesPanelSource);
    const skeletonRailWidth = extractSkeletonRailWidth(taskDetailBodySource);

    expect(
      skeletonRailWidth,
      'src/renderer/components/dialogs/task-detail/TaskDetailBody.tsx\'s ChangesPanelSkeleton hand-types '
        + `'${String(skeletonRailWidth)}' for the rail width, but `
        + 'src/renderer/components/dialogs/task-detail/changes/ChangesPanel.tsx\'s '
        + `RAIL_DEFAULT_WIDTH_CLAMP is '${String(railDefaultWidthClamp)}'. Update the skeleton's `
        + 'literal in TaskDetailBody.tsx to match - the mismatch means the skeleton will visibly '
        + 'snap to a different rail width the instant the real ChangesPanel chunk finishes loading.',
    ).toBe(railDefaultWidthClamp);
  });
});

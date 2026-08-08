import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

/**
 * Light dismiss is a DENYLIST: a clean click on dead space anywhere in the app shell closes
 * the focused task-detail window, unless the target is excluded
 * (`useClickOutsideToClose.ts`). The catch-all exclusion is the computed cursor: an element
 * showing `pointer` is treated as an action and never dismisses.
 *
 * That leaves one recurring blind spot. An element with a DIFFERENT action cursor
 * (`cursor-grab` on a drag handle, `cursor-col-resize` on a splitter) is plainly interactive
 * to the user - it usually lights up on hover too - but its cursor is not `pointer`, so the
 * heuristic classifies it as dead space and the click closes a window instead of acting. The
 * hover state then promises an action the click does not deliver, which is exactly the UX lie
 * this project decided not to ship.
 *
 * `cursor-grab` overriding an inherited `cursor-pointer` makes it worse: a clickable row's
 * exemption does NOT reach its own drag handle, so the handle needs its own marker even
 * though its parent is safe.
 *
 * This shape has now been found three times (`Swimlane`'s column-header handle,
 * `DataTable`'s row handle, `PrioritiesPopover`'s reorder handle), which is why it is
 * mechanised rather than left to review.
 *
 * Deliberately NOT mechanised (stated so the gap is explicit rather than assumed covered):
 *  - "every overlay mounts outside the marked shell subtree" - the fail-safe that keeps the
 *    settings panel, palettes, and dialogs inert. Not expressible statically; guarded by the
 *    UI specs in `tests/ui/window-click-outside-close.spec.ts`.
 *  - "no hover class promises what the click will not do" - requires knowing whether an
 *    element is interactive, which needs the runtime tree. Review-caught.
 */

const REPO_ROOT = path.resolve(__dirname, '../..');
const RENDERER = path.join(REPO_ROOT, 'src/renderer');

/** Cursors that read as "this element does something" but are not `pointer`, so the
 *  cursor heuristic in `useClickOutsideToClose.ts` cannot exclude them. */
const ACTION_CURSOR_PATTERN =
  /cursor-(grab|grabbing|col-resize|row-resize|ns-resize|ew-resize|move)\b/;

/** Subtrees whose elements can never be light-dismiss targets, because every window frame
 *  and popover under them is excluded wholesale by an ancestor marker:
 *   - `window-manager/` renders into a body-level host stamped `data-window-layer-root`
 *   - `dialogs/task-detail/` and `command-bar/` render inside those window frames (the board
 *     and command-terminal layer hosts respectively)
 *   - `pop-out/` is a separate BrowserWindow document with no light-dismiss hook at all */
const PORTAL_PROTECTED_DIRECTORIES = [
  'src/renderer/window-manager/',
  'src/renderer/components/dialogs/task-detail/',
  'src/renderer/components/command-bar/',
  'src/renderer/pop-out/',
];

/** Ancestor markers that exclude a whole subtree from dismissal, any of which makes an action
 *  cursor inside the file safe. `data-task-id` is the task card's own exclusion; a card is a
 *  `cursor-grab` drag source and is excluded by that marker rather than by `data-no-dismiss`. */
const DENYLIST_MARKERS = ['data-no-dismiss', 'data-task-id', 'data-dismissable-layer'];

/** An opt-out for a site that genuinely cannot dismiss for a reason the scan cannot see. */
const OPT_OUT_MARKER = 'light-dismiss-ok:';

interface Offender {
  file: string;
  line: number;
  source: string;
}

function collectFiles(directory: string, accumulator: string[] = []): string[] {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) { collectFiles(entryPath, accumulator); continue; }
    if (/\.tsx?$/.test(entry.name)) accumulator.push(entryPath);
  }
  return accumulator;
}

function toPosixRelative(absolutePath: string): string {
  return path.relative(REPO_ROOT, absolutePath).replace(/\\/g, '/');
}

describe('light dismiss: an action cursor must be excluded from dismissal', () => {
  // Title states the FILE-level guarantee deliberately. The check below skips a whole file
  // once any marker appears in it, so it cannot promise "every site": a second, unmarked
  // handle added to a file that already has a marked one passes. See the granularity note
  // at the skip itself.
  it('every file with an action cursor is denylisted, portal-protected, or explicitly opted out', () => {
    const offenders: Offender[] = [];

    for (const filePath of collectFiles(RENDERER)) {
      const relativePath = toPosixRelative(filePath);
      if (PORTAL_PROTECTED_DIRECTORIES.some((directory) => relativePath.startsWith(directory))) continue;

      const contents = fs.readFileSync(filePath, 'utf-8');
      if (!ACTION_CURSOR_PATTERN.test(contents)) continue;

      // File-level granularity, matching the repo's other convention scans: a marker on an
      // ANCESTOR covers its whole subtree via `closest()` (that is how Swimlane's header
      // protects its handle), so per-element static ancestry checking is not possible.
      if (DENYLIST_MARKERS.some((marker) => contents.includes(marker))) continue;
      if (contents.includes(OPT_OUT_MARKER)) continue;

      contents.split('\n').forEach((line, index) => {
        if (!ACTION_CURSOR_PATTERN.test(line)) return;
        offenders.push({ file: relativePath, line: index + 1, source: line.trim() });
      });
    }

    expect(
      offenders.map((offender) => `${offender.file}:${offender.line}: ${offender.source}`),
      'An element showing an action cursor (grab / resize / move) reads as interactive but is '
      + 'NOT `pointer`, so light dismiss classifies it as dead space and a click closes a task '
      + 'window instead of acting - and its hover state becomes a promise the click does not '
      + 'keep. Add `data-no-dismiss` to it or an ancestor, or annotate the site with a '
      + `\`// ${OPT_OUT_MARKER} <reason>\` comment. Offenders:\n`
      + offenders.map((offender) => `  ${offender.file}:${offender.line}: ${offender.source}`).join('\n'),
    ).toEqual([]);
  });

  it('the cursor heuristic is still the catch-all the scan assumes', () => {
    // The scan only has to cover NON-pointer action cursors because `pointer` is excluded
    // by the heuristic. If that read is ever removed, every clickable <div> in the app
    // (project rows, group headers, pills) starts dismissing and this scan is far too
    // narrow to catch it.
    const hook = fs.readFileSync(
      path.join(RENDERER, 'window-manager/bridge/useClickOutsideToClose.ts'),
      'utf-8',
    );
    expect(
      hook,
      'useClickOutsideToClose must still exclude pointer-cursor targets; the action-cursor '
      + 'scan above is scoped on the assumption that it does.',
    ).toMatch(/getComputedStyle\(target\)\.cursor\s*!==\s*'pointer'/);
  });

  it('the live terminal is excluded structurally, not via a wrapper marker alone', () => {
    // xterm's own CSS sets `cursor: text` on `.xterm` and `default` on `.xterm-viewport`, so
    // NEITHER candidate hit target resolves to `pointer`. Without `.xterm` in the excluded
    // selector, clicking into a running agent's terminal to type would close the window.
    const hook = fs.readFileSync(
      path.join(RENDERER, 'window-manager/bridge/useClickOutsideToClose.ts'),
      'utf-8',
    );
    const selector = /const EXCLUDED_CONTROL_SELECTOR\s*=\s*([\s\S]*?);/.exec(hook)?.[1] ?? '';
    expect(
      selector,
      'The excluded-control selector must list `.xterm` so clicking a running terminal never '
      + 'light-dismisses, in every xterm host (bottom panel, task detail, command terminal).',
    ).toContain('.xterm');
  });
});

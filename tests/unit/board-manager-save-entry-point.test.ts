/**
 * Guard for the "handleSave has exactly one caller" invariant that requestSave's
 * own JSDoc asserts in prose but nothing enforces:
 *
 *   "The only way handleSave is invoked, so a throw escaping it cannot strand
 *   `saving === true`."
 *
 * handleSave is `async`, so it returns a promise that can reject. Every failure
 * INSIDE handleSave already returns normally through its own firstError branch
 * (see swimlane-slice.test.ts and toast-click-through.spec.ts for that path), so a
 * rejection can only happen if a throw escapes those guards - and when that
 * happens, `saving` stays stuck `true`, which deadens Cancel, Escape, the header
 * X, and the backdrop as well as Save (handleSave's own re-entrancy guard rules
 * out Ctrl+S as an escape hatch too, and the dialog would need a reload to
 * close). requestSave (`handleSave().catch(...)`) is the one call site that
 * recovers from that.
 *
 * Nothing renders BoardManagerDialog at any test tier - this project's vitest
 * config has no jsdom environment and no @testing-library/react (see the
 * established rationale in panel-error-boundary.test.ts) - so requestSave's
 * catch BODY cannot be driven directly here. What this test pins instead is the
 * invariant the JSDoc claims: a future fourth save trigger cannot copy the
 * `void handleSave()` pattern still visible a few lines up in this file's git
 * history, which would silently reintroduce the exact unhandled-rejection bug
 * requestSave was added to fix, with no test catching the regression.
 *
 * Source-parsing, following the pattern in toast-exit-fallback.test.ts and
 * terminal-arrival-focus-sites.test.ts.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const BOARD_MANAGER_DIALOG_PATH = path.join(
  REPO_ROOT, 'src', 'renderer', 'components', 'dialogs', 'BoardManagerDialog.tsx',
);

/** Matches a CALL of handleSave (`handleSave(`), not its
 *  `const handleSave = useCallback(...)` definition (` = useCallback` sits
 *  between the name and the paren there) and not a dependency-array reference
 *  (`[handleSave]`, no paren at all). */
const HANDLE_SAVE_CALL_PATTERN = /handleSave\s*\(/g;

/** Strips comment-only lines and trailing `//` comments, so a JSDoc line that
 *  quotes `handleSave()` as prose (as requestSave's own doc comment does, a
 *  few lines above its real call) is not mistaken for a real call site.
 *  Mirrors codeOnly() in terminal-arrival-focus-sites.test.ts. */
function codeOnly(line: string): string {
  const trimmed = line.trim();
  if (trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('//')) return '';
  const commentIndex = line.indexOf('//');
  return commentIndex >= 0 ? line.slice(0, commentIndex) : line;
}

describe('BoardManagerDialog: handleSave has exactly one caller (requestSave)', () => {
  it("is only ever invoked through requestSave's handleSave().catch(...)", () => {
    const source = fs.readFileSync(BOARD_MANAGER_DIALOG_PATH, 'utf-8');
    const codeLines = source.split('\n').map(codeOnly);
    const callSites: string[] = [];
    codeLines.forEach((line, index) => {
      HANDLE_SAVE_CALL_PATTERN.lastIndex = 0;
      if (HANDLE_SAVE_CALL_PATTERN.test(line)) {
        callSites.push(`line ${index + 1}: ${line.trim()}`);
      }
    });

    expect(
      callSites.length,
      'Expected exactly one call to handleSave(...) in BoardManagerDialog.tsx, found ' +
      `${callSites.length}:\n${callSites.join('\n')}\n` +
      "requestSave's handleSave().catch(...) is what keeps a rejection from stranding " +
      '`saving === true` (see the JSDoc above requestSave). A second direct call - e.g. a new ' +
      'Save trigger written as `void handleSave()` - bypasses that recovery and reintroduces ' +
      'the bug requestSave exists to fix.',
    ).toBe(1);

    expect(
      callSites[0],
      "The one handleSave(...) call must be requestSave's `handleSave().catch(...)`, not a " +
      'differently-shaped invocation (e.g. `handleSave();` with the .catch dropped).',
    ).toContain('handleSave().catch(');
  });
});

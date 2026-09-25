import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { hasOptOutMarker } from './helpers/opt-out-marker';

// A "no toast appeared" assertion written as `expect(toastLocator).toHaveCount(0)`
// passes against code that raises a toast. `toastCountRightNow` in
// tests/ui/helpers.ts is the fix, and its docblock is the one place the mechanism,
// the rediscovery history, and the fake-clock caveat are written out. This file is
// the mechanical half: it fails any new instance of the shape.
//
// Known limit of the scan: it is LINE-SCOPED. Input is `.split('\n')` and the
// pattern spans no newline, so a wrapped chain
//   await expect(page.getByTestId('toast'))
//     .toHaveCount(0);
// slips through silently. There is no such site in tests/ui today (the suite's one
// wrapped `.toHaveCount(0)` targets a swimlane locator), and widening the pattern
// across lines costs more than it buys: without a `;` boundary a stray "toast" in a
// comment reaches the next statement's assertion and false-positives. Left narrow
// on purpose - if a wrapped toast assertion ever appears, join continuation lines
// (a line whose first non-space character is `.`) before matching rather than
// letting the regex cross statements.

const REPO_ROOT = path.resolve(__dirname, '../..');
const UI_TEST_DIR = path.join(REPO_ROOT, 'tests/ui');

/**
 * A `toHaveCount(0)` whose locator mentions a toast, on one line. Deliberately
 * narrow: it matches the toast test id or a `toast`-named locator variable, not
 * every zero-count assertion in the suite (there are ~200, and nearly all of them
 * are about elements that never self-dismiss).
 */
// The identifier arm is substring-based, not word-boundary-based: a locator is
// as likely to be called `stallToast` as `toast`, and `\b` does not fire inside
// camelCase.
const TOAST_ZERO_COUNT =
  /(?:getByTestId\(\s*['"]toast['"]\s*\)|\[data-testid=["']toast["']\]|[A-Za-z_$]*[Tt]oast[A-Za-z_$]*)[^\n]*\.toHaveCount\(\s*0\s*\)/;

/**
 * Per-line opt-out for a site that has a reason not to use the helper, read
 * through the shared reader (`helpers/opt-out-marker.ts`). That replaced a
 * private "this line or the one above" rule, which could not see a reason that
 * wrapped onto a second line and accepted a bare `toast-count-ok:` with none.
 */
const OPT_OUT = 'toast-count-ok';

function uiTestFiles(): string[] {
  return fs
    .readdirSync(UI_TEST_DIR)
    .filter((name) => name.endsWith('.spec.ts'))
    .map((name) => path.join(UI_TEST_DIR, name));
}

describe('toast negative assertions do not use a retrying matcher', () => {
  it('finds no `toHaveCount(0)` against a toast locator in tests/ui', () => {
    const offenders: string[] = [];

    for (const file of uiTestFiles()) {
      const lines = fs.readFileSync(file, 'utf-8').split('\n');
      lines.forEach((line, index) => {
        if (!TOAST_ZERO_COUNT.test(line)) return;
        if (hasOptOutMarker(lines, index, OPT_OUT)) return;
        offenders.push(`${path.relative(REPO_ROOT, file)}:${index + 1}: ${line.trim()}`);
      });
    }

    expect(
      offenders,
      'A toast auto-dismisses inside the expect-retry window, so toHaveCount(0) passes\n'
        + 'against code that raised one. Use `toastCountRightNow` from tests/ui/helpers.ts:\n'
        + '  expect(await toastCountRightNow(page)).toBe(0);\n'
        + `Opt out on the line, or in the comment block directly above it, with\n`
        + `\`// ${OPT_OUT}: <reason>\` - the reason is required.\n\n`
        + `Offending sites:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  // Without this the scan passes vacuously the moment the pattern stops matching
  // (a renamed test id, a regex edit), which is the failure mode that makes a
  // static guard worse than no guard.
  it('detects the shape it bans', () => {
    const knownBad = [
      `await expect(page.getByTestId('toast')).toHaveCount(0);`,
      `await expect(page.locator('[data-testid="toast"]')).toHaveCount(0);`,
      `await expect(toast).toHaveCount(0);`,
      `await expect(stallToast).toHaveCount(0);`,
    ];
    for (const line of knownBad) {
      expect(TOAST_ZERO_COUNT.test(line), `should have matched: ${line}`).toBe(true);
    }
  });

  it('leaves unrelated zero-count assertions alone', () => {
    const knownGood = [
      `await expect(page.getByTestId('monitor-card')).toHaveCount(0);`,
      `await expect(banner).toHaveCount(0);`,
      `expect(await toastCountRightNow(page)).toBe(0);`,
      `await expect(page.getByTestId('toast')).toHaveCount(1);`,
    ];
    for (const line of knownGood) {
      expect(TOAST_ZERO_COUNT.test(line), `should NOT have matched: ${line}`).toBe(false);
    }
  });

  it('honors the opt-out marker, and only with a reason', () => {
    const offence = `await expect(page.getByTestId('toast')).toHaveCount(0);`;
    expect(TOAST_ZERO_COUNT.test(offence)).toBe(true);
    expect(hasOptOutMarker([`${offence} // ${OPT_OUT}: fake clock frozen`], 0, OPT_OUT)).toBe(true);
    // A bare marker used to waive the line; now it marks nothing.
    expect(hasOptOutMarker([`${offence} // ${OPT_OUT}:`], 0, OPT_OUT)).toBe(false);
    // And a reason that wraps is seen, which the old line-above rule missed.
    expect(hasOptOutMarker([
      `// ${OPT_OUT}: the clock is frozen for this spec, so the toast cannot`,
      '// dismiss inside the retry window.',
      offence,
    ], 2, OPT_OUT)).toBe(true);
  });

  it('scans a non-empty set of spec files', () => {
    expect(uiTestFiles().length).toBeGreaterThan(50);
  });
});

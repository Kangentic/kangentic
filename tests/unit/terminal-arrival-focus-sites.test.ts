import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Enforces .claude/rules/terminal-arrival-focus.md. Every programmatic focus on an ARRIVING
// terminal (deferred init, mount replay, a reload the caller did not opt out of) must be
// arbitrated, or two terminals mounting together race and whichever replay settles last takes the
// user's keystrokes. Genuinely user-initiated focus stays unconditional and opts out with a
// `// arrival-focus-ok: <reason>` marker on the call line or the line above.
//
// Scope is the terminal HOSTS: files that call `useTerminal(` or reach for an xterm textarea
// directly. A focus call anywhere else in the renderer (form fields, dialogs, menus) is unrelated
// to this rule and is not scanned.
//
// The pattern deliberately matches a BARE `focus()` as well as `.focus()`. Three real sites call a
// destructured `focus` with no receiver (`TerminalTab`'s active effect, `CommandTerminalPane`'s
// onInit, `useTerminalFileDrop`'s `focusTerminal()`), so a `\.focus\(\)`-only scan would pass
// vacuously over exactly the sites this rule exists to protect.

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCAN_DIR = 'src/renderer';
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);
const OK_MARKER = /arrival-focus-ok/;
const ARBITER_GUARD = /mayTakeArrivalFocus|mayFocusOnArrival/;

/** The arbiter itself, and the hook option's own plumbing, are not call sites. */
const EXEMPT_FILES = new Set([
  'src/renderer/utils/terminal-arrival-focus.ts',
]);

/** A file is a terminal host if it constructs a terminal, reaches for its textarea, or is handed
 *  a terminal's focus function to call. */
function isTerminalHost(source: string): boolean {
  return source.includes('useTerminal(')
    || source.includes('.xterm-helper-textarea')
    || source.includes('focusTerminal');
}

/** `focus()` / `focusTerminal()` / `something.focus()`, but not `onFocus(` or `focusWindow(`. */
const FOCUS_CALL = /\b(?:focus|focusTerminal)\s*\(\s*\)/g;

/** Prose mentioning `focus()` is not a call site. Strips line comments and skips block-comment
 *  bodies, so only real code is matched. The `arrival-focus-ok` marker is still read from the
 *  ORIGINAL line, since it lives in exactly the comment this removes. */
function codeOnly(line: string): string {
  const trimmed = line.trim();
  if (trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('//')) return '';
  const commentIndex = line.indexOf('//');
  return commentIndex >= 0 ? line.slice(0, commentIndex) : line;
}

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function toPosix(relativePath: string): string {
  return relativePath.replace(/\\/g, '/');
}

describe('every arrival focus in a terminal host is arbitrated', () => {
  it('no unguarded, unmarked focus call in a terminal-host file', () => {
    const offenders: string[] = [];

    for (const filePath of collectSourceFiles(path.join(REPO_ROOT, SCAN_DIR))) {
      const relative = toPosix(path.relative(REPO_ROOT, filePath));
      if (EXEMPT_FILES.has(relative)) continue;

      const source = fs.readFileSync(filePath, 'utf8');
      if (!isTerminalHost(source)) continue;

      const lines = source.split('\n');
      lines.forEach((line, index) => {
        FOCUS_CALL.lastIndex = 0;
        if (!FOCUS_CALL.test(codeOnly(line))) return;

        // The guard may sit on the same line (`if (initialized.current && mayFocusOnArrival())`)
        // or on the line just above (the ref check inside a requestAnimationFrame body). An
        // opt-out marker may sit anywhere in the contiguous comment block directly above, since a
        // one-line reason is rarely enough to say WHY a focus is user-initiated.
        const context = [line];
        for (let above = index - 1; above >= 0; above--) {
          const trimmed = lines[above].trim();
          const isComment = trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
          if (!isComment && context.length > 1) break;
          context.unshift(lines[above]);
          if (!isComment) break;
        }
        const block = context.join('\n');
        if (ARBITER_GUARD.test(block)) return;
        if (OK_MARKER.test(block)) return;

        offenders.push(`${relative}:${index + 1}  ${line.trim()}`);
      });
    }

    expect(
      offenders,
      'Arrival focus must route through mayTakeArrivalFocus (see .claude/rules/terminal-arrival-focus.md).\n'
        + 'If this focus follows a real user gesture, mark it `// arrival-focus-ok: <reason>`.\n'
        + `Unguarded:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('every useTerminal host passes the arrival-focus policy', () => {
    // The focus-call scan above cannot see this gap. `useTerminal` owns two arrival
    // frames of its own (the mount replay and the reload), and both read the option
    // as `mayTakeArrivalFocusRef.current?.() === false` - so an ABSENT option is
    // `undefined === false`, i.e. allow. A new host that mounts useTerminal and never
    // calls the returned `focus` itself would therefore contain no focus call to
    // flag, pass the scan vacuously, and still take arrival focus unconditionally.
    const offenders: string[] = [];

    for (const filePath of collectSourceFiles(path.join(REPO_ROOT, SCAN_DIR))) {
      const relative = toPosix(path.relative(REPO_ROOT, filePath));
      // The hook itself declares the option; it does not pass one.
      if (relative === 'src/renderer/hooks/useTerminal.ts') continue;

      const source = fs.readFileSync(filePath, 'utf8');
      if (!source.includes('useTerminal(')) continue;
      if (source.includes('mayTakeArrivalFocus')) continue;

      offenders.push(relative);
    }

    expect(
      offenders,
      'A useTerminal() host must pass the `mayTakeArrivalFocus` option (see '
      + '.claude/rules/terminal-arrival-focus.md). Omitting it silently restores the '
      + `unconditional arrival focus this rule exists to prevent.\nMissing:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });

  it('every path that ends a replay discharges the arrival obligation', () => {
    // An arrival is an obligation a replay takes on, discharged exactly once by
    // `focusOnArrival`. A path that ENDS a replay without discharging cancels the
    // decision permanently: the terminal is never asked again and can never take
    // focus. That is not hypothetical - the watchdog did exactly this, and it
    // shipped as an intermittently retried CI test whose arbiter trace was empty,
    // because the arbiter had never been consulted at all.
    //
    // `useTerminal` has no unit tier (it needs a real DOM and a live xterm), so
    // this is a static pin rather than a behavioural test. The behavioural guard
    // is `tests/ui/terminal-arrival-focus.spec.ts`'s watchdog case; this exists so
    // that DELETING the discharge fails here too, loudly and instantly, instead of
    // only in a 6-second UI spec someone might not run.
    const source = fs.readFileSync(
      path.join(REPO_ROOT, 'src/renderer/hooks/useTerminal.ts'),
      'utf8',
    );

    // Sliced into the three regions that own a replay, and checked region by
    // region. A whole-file `includes` cannot do this job: two of the five
    // discharge calls are BOTH spelled `focusOnArrival('replay-error')` (the
    // mount catch and the reload catch), so one occurrence satisfies a global
    // search and either site could be deleted with the pin still green.
    //
    // The boundaries are the three callback declarations, in file order. Pin them
    // first: a renamed or reordered declaration would otherwise slice the source
    // into garbage and every check below would pass vacuously, which is the same
    // failure the sibling host-scan test guards against.
    const regionAnchors = [
      ['the watchdog', 'const armScrollbackWatchdog = useCallback('],
      ['the mount replay', 'const initTerminal = useCallback('],
      ['the reload replay', 'const reloadScrollback = useCallback('],
    ] as const;
    const anchorIndexes = regionAnchors.map(([, declaration]) => source.indexOf(declaration));
    const missingAnchors = regionAnchors
      .filter((_, position) => anchorIndexes[position] === -1)
      .map(([label, declaration]) => `${label} (expected ${declaration})`);
    expect(
      missingAnchors,
      'This scan slices useTerminal.ts by callback declaration, and one is no '
      + 'longer spelled the way it was. Re-anchor it, or every check below '
      + `silently stops testing anything.\nMissing:\n${missingAnchors.join('\n')}`,
    ).toEqual([]);
    expect(
      anchorIndexes,
      'The three replay-owning callbacks are no longer in watchdog -> mount -> '
      + 'reload file order, so the slices below overlap or invert.',
    ).toEqual([...anchorIndexes].sort((first, second) => first - second));

    const [watchdogRegion, mountRegion, reloadRegion] = [
      source.slice(anchorIndexes[0], anchorIndexes[1]),
      source.slice(anchorIndexes[1], anchorIndexes[2]),
      source.slice(anchorIndexes[2]),
    ];

    // Each entry: the region, the path inside it, and the call that must appear.
    const requiredDischarges = [
      [watchdogRegion, "the watchdog's force-clear", "focusOnArrival('replay-watchdog')"],
      [mountRegion, 'the mount replay completing', "focusOnArrival('mount-replay')"],
      [mountRegion, "the mount replay's IPC rejection", "focusOnArrival('replay-error')"],
      [reloadRegion, 'the reload replay completing', "focusOnArrival('reload')"],
      [reloadRegion, "the reload replay's IPC rejection", "focusOnArrival('replay-error')"],
    ] as const;

    const missing = requiredDischarges
      .filter(([region, , call]) => !region.includes(call))
      .map(([, label, call]) => `${label} (expected ${call})`);

    expect(
      missing,
      'A replay path in useTerminal.ts no longer discharges the arrival-focus '
      + 'obligation, so a terminal arriving down that path can never take focus '
      + `(see .claude/rules/terminal-arrival-focus.md).\nMissing:\n${missing.join('\n')}`,
    ).toEqual([]);

    // The obligation has to be ARMED where a replay STARTS, not where it
    // completes: a replay that never completes is the whole point, so arming in
    // `afterWrite` would leave the pre-emption paths with nothing to discharge.
    //
    // Checked positionally rather than by counting occurrences. A count pin reads
    // as precision it does not have - it would fail on an `armArrival()` helper
    // extraction, which reintroduces nothing - and a pin that fires on safe
    // refactors gets deleted rather than understood.
    //
    // Both replays are checked, each against its OWN `afterWrite`. Checking the
    // whole file instead would only ever see the mount's arm and the mount's
    // `afterWrite`, since `indexOf` stops at the first of each - and the reload is
    // the path the behaviour spec had to be built on, because a mount-based
    // version of it passes with the fix reverted.
    const armingRegions = [
      ['the mount replay', mountRegion],
      ['the reload replay', reloadRegion],
    ] as const;
    for (const [label, region] of armingRegions) {
      const armIndex = region.indexOf('arrivalFocusOwedRef.current = true');
      const afterWriteIndex = region.indexOf('const afterWrite =');
      expect(armIndex, `${label} never arms the arrival obligation at all.`).toBeGreaterThan(-1);
      expect(afterWriteIndex, `${label} has no \`afterWrite\` to arm ahead of.`).toBeGreaterThan(-1);
      expect(
        armIndex,
        `${label} arms the arrival obligation at or after its own \`afterWrite\`, `
        + 'i.e. at replay COMPLETION. It must be armed where the replay STARTS, or '
        + 'a replay that is pre-empted before completing leaves nothing to '
        + 'discharge - which is the original bug.',
      ).toBeLessThan(afterWriteIndex);
    }
  });

  it('the reload path only arms and discharges the arrival obligation when the caller did not pass skipFocus', () => {
    // A `skipFocus` reload is a REPAIR (a park/reveal catch-up, a width-drift heal),
    // not an arrival, so it must neither promise an obligation nor pay one off. Two
    // independent gates hold that, one at arm time and one at discharge time (see
    // the obligation bullet in .claude/rules/terminal-arrival-focus.md):
    //
    //   if (!skipFocus) arrivalFocusOwedRef.current = true;   // arm
    //   ...
    //   if (!skipFocus) focusOnArrival('reload');              // discharge
    //
    // Deleting the ARM gate alone still looks harmless in isolation - the repair's
    // own discharge stays gated off - but it leaves an obligation standing that the
    // watchdog (which discharges UNCONDITIONALLY on force-recovery) can later spend,
    // focusing the terminal on the very park/reveal edge the discharge gate exists to
    // refuse. Deleting the DISCHARGE gate alone widens the already-documented
    // "stranded obligation" gap from watchdog-only to every skipFocus completion. A
    // single assertion covering only one gate would leave the other free to regress,
    // exactly the trap the sibling test's own comment names for the two identically
    // spelled `focusOnArrival('replay-error')` calls.
    const source = fs.readFileSync(
      path.join(REPO_ROOT, 'src/renderer/hooks/useTerminal.ts'),
      'utf8',
    );
    const reloadDeclarationIndex = source.indexOf('const reloadScrollback = useCallback(');
    expect(
      reloadDeclarationIndex,
      'reloadScrollback moved or was renamed; re-anchor this scan.',
    ).toBeGreaterThan(-1);
    const reloadRegion = source.slice(reloadDeclarationIndex);

    // Tolerant of whitespace and an optional brace body, not a literal single-line
    // substring: a harmless reformat (wrapping the guarded statement, or adding
    // braces to the `if`) must not break this pin.
    const armGate = /if\s*\(\s*!skipFocus\s*\)\s*\{?\s*arrivalFocusOwedRef\.current\s*=\s*true/;
    const dischargeGate = /if\s*\(\s*!skipFocus\s*\)\s*\{?\s*focusOnArrival\(\s*'reload'\s*\)/;

    expect(
      armGate.test(reloadRegion),
      'reloadScrollback must only ARM the arrival obligation when the caller did not '
      + 'pass skipFocus. Without the `if (!skipFocus)` gate, a repair reload (park/reveal '
      + "catch-up, width-drift heal) arms an obligation its own completion won't pay, "
      + 'leaving it standing for the watchdog to discharge unconditionally later - '
      + 'focusing the terminal on a park/reveal edge that is not an arrival at all.',
    ).toBe(true);

    expect(
      dischargeGate.test(reloadRegion),
      'reloadScrollback must only DISCHARGE the arrival obligation on completion when the '
      + 'caller did not pass skipFocus. Without the `if (!skipFocus)` gate, every repair '
      + 'reload focuses on completion, not just the ones that outlive the watchdog - '
      + 'widening the documented "stranded obligation" gap (terminal-arrival-focus.md) '
      + 'from a rare edge to the common case.',
    ).toBe(true);
  });

  it('focusOnArrival clears the obligation before, not inside, its focus frame', () => {
    // "Discharged exactly once" (the fix's headline property) depends on WHEN the ref
    // is cleared, not just that it is cleared. Clearing before the requestAnimationFrame
    // means a second path that discharges the same replay (there cannot be one - each
    // arm is per-replay - but a future call site addition could get this wrong) finds
    // the obligation already gone. Clearing inside the frame, after the
    // `if (!terminal) return` bail in particular, would let two discharges for the same
    // arming both pass the outer `if (!arrivalFocusOwedRef.current) return` guard before
    // either clears it, consulting the arbiter twice for one arrival - the exact race
    // the comment above `focusOnArrival` in useTerminal.ts says this ordering prevents.
    const source = fs.readFileSync(
      path.join(REPO_ROOT, 'src/renderer/hooks/useTerminal.ts'),
      'utf8',
    );
    const declarationIndex = source.indexOf(
      'const focusOnArrival = useCallback((site: ArrivalFocusSite) => {',
    );
    const nextDeclarationIndex = source.indexOf('const traceReplay = useCallback(');
    expect(
      declarationIndex,
      'focusOnArrival moved or was renamed; re-anchor this scan.',
    ).toBeGreaterThan(-1);
    expect(
      nextDeclarationIndex,
      'traceReplay moved or was renamed; re-anchor this scan.',
    ).toBeGreaterThan(declarationIndex);

    const focusOnArrivalRegion = source.slice(declarationIndex, nextDeclarationIndex);
    const clearIndex = focusOnArrivalRegion.indexOf('arrivalFocusOwedRef.current = false');
    const rafIndex = focusOnArrivalRegion.indexOf('requestAnimationFrame(');

    expect(clearIndex, 'focusOnArrival no longer clears the obligation at all.').toBeGreaterThan(-1);
    expect(rafIndex, 'focusOnArrival no longer schedules its focus frame via requestAnimationFrame.').toBeGreaterThan(-1);
    expect(
      clearIndex,
      'The obligation must clear BEFORE requestAnimationFrame is scheduled, not inside its '
      + 'callback. Clearing inside the frame would let a second discharge for the same '
      + 'arming reach the arbiter before the first one clears the ref, consulting it twice '
      + 'for one arrival.',
    ).toBeLessThan(rafIndex);
  });

  it('scans the terminal hosts it is meant to cover', () => {
    // The scan is a no-op if `isTerminalHost` stops matching (a renamed hook, a moved file), and a
    // no-op scan passes silently. Pin the hosts so that failure is loud.
    const expectedHosts = [
      'src/renderer/hooks/useTerminal.ts',
      'src/renderer/hooks/useTerminalFileDrop.ts',
      'src/renderer/components/terminal/TerminalTab.tsx',
      'src/renderer/components/command-bar/CommandTerminalPane.tsx',
      'src/renderer/window-manager/components/WindowFrame.tsx',
      'src/renderer/window-manager/components/TaskDetailWindow.tsx',
      'src/renderer/window-manager/bridge/useWindowFocusReconcile.ts',
    ];

    const scanned = new Set(
      collectSourceFiles(path.join(REPO_ROOT, SCAN_DIR))
        .filter((filePath) => isTerminalHost(fs.readFileSync(filePath, 'utf8')))
        .map((filePath) => toPosix(path.relative(REPO_ROOT, filePath))),
    );

    const missing = expectedHosts.filter((host) => !scanned.has(host));
    expect(missing, `These terminal hosts are no longer being scanned: ${missing.join(', ')}`).toEqual([]);
  });
});

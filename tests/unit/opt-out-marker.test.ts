/**
 * Covers the shared opt-out marker reader (`helpers/opt-out-marker.ts`), which
 * a dozen convention scans now depend on. A bug here does not fail loudly: it
 * makes every one of those scans quietly stop enforcing, or quietly start
 * rejecting markers that are really there. So the four association rules and
 * the reason requirement are pinned directly rather than only through their
 * consumers.
 *
 * The last block is the adoption guard, which replaced the hand-kept census of
 * consumers that used to sit in the helper's docblock.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  hasOptOutMarker,
  hasJsxOptOutMarker,
  hasLineOnlyOptOutMarker,
  hasFileScopedOptOut,
} from './helpers/opt-out-marker';

const MARKER = 'example-ok';

describe('hasOptOutMarker', () => {
  it('finds a marker on the line itself', () => {
    const lines = ['  writeFileSync(path, value); // example-ok: the caller reports.'];
    expect(hasOptOutMarker(lines, 0, MARKER)).toBe(true);
  });

  it('finds a marker on the line directly above', () => {
    const lines = ['  // example-ok: the caller reports.', '  writeFileSync(path, value);'];
    expect(hasOptOutMarker(lines, 1, MARKER)).toBe(true);
  });

  it('finds a marker higher in a wrapped comment block', () => {
    // The regression this helper exists for. Under the old line-above rule the
    // nearest line was the tail of the reason, so the marker never applied and
    // the scan demanded a marker that was already written.
    const lines = [
      '  // example-ok: the host is incidental to what this exercises, so a',
      '  // contract path would misrepresent it.',
      '  writeFileSync(path, value);',
    ];
    expect(hasOptOutMarker(lines, 2, MARKER)).toBe(true);
  });

  it('does not reach past a blank line', () => {
    const lines = ['  // example-ok: stale.', '', '  writeFileSync(path, value);'];
    expect(hasOptOutMarker(lines, 2, MARKER)).toBe(false);
  });

  it('does not reach past a line of code', () => {
    const lines = ['  // example-ok: stale.', '  const other = 1;', '  writeFileSync(path, value);'];
    expect(hasOptOutMarker(lines, 2, MARKER)).toBe(false);
  });

  it('ignores an unrelated comment block', () => {
    const lines = ['  // just explaining something.', '  writeFileSync(path, value);'];
    expect(hasOptOutMarker(lines, 1, MARKER)).toBe(false);
  });
});

describe('the reason requirement', () => {
  it('rejects a bare marker with nothing after the colon', () => {
    const lines = ['  // example-ok:', '  writeFileSync(path, value);'];
    expect(hasOptOutMarker(lines, 1, MARKER)).toBe(false);
  });

  it('rejects a marker whose reason is only on the next line', () => {
    // A reason has to start on the marker's own line. Otherwise `// example-ok:`
    // followed by an unrelated comment reads as justified.
    const lines = ['  // example-ok:', '  // something else entirely', '  writeFileSync(path, value);'];
    expect(hasOptOutMarker(lines, 2, MARKER)).toBe(false);
  });

  it('rejects prose that names the marker without using it', () => {
    const lines = [
      '  // deliberately not an example-ok opt-out, because the reset is wanted.',
      '  writeFileSync(path, value);',
    ];
    expect(hasOptOutMarker(lines, 1, MARKER)).toBe(false);
  });

  it('rejects prose that quotes the marker before a closing backtick', () => {
    // The literal line from src/renderer/hooks/useWhatsNewOnLaunch.ts:8. The
    // backtick that closes the quote satisfied the old pattern's colon-plus-reason
    // check, so a sentence denying the opt-out read as the opt-out itself.
    const lines = [
      '  // deliberately not a `// hmr-safe:` opt-out): the team dogfoods from `npm start`,',
      '  let whatsNewEvaluated: boolean = false;',
    ];
    expect(hasOptOutMarker(lines, 1, 'hmr-safe')).toBe(false);
  });

  it('still accepts every documented opener form', () => {
    // The other side of the anchor tightening: a plain line comment, a trailing
    // comment, a JSDoc continuation line, a one-line JSDoc opener, and a
    // brace-wrapped JSX comment must all keep matching.
    expect(hasOptOutMarker(['// hmr-safe: the guard must survive Fast Refresh.'], 0, 'hmr-safe')).toBe(true);
    expect(
      hasOptOutMarker(
        ['  fs.writeFileSync(target, data); // sync-write-ok: config load is fatal anyway.'],
        0,
        'sync-write-ok',
      ),
    ).toBe(true);
    expect(
      hasOptOutMarker([' * value-pulse-ok: never re-points across a context boundary.'], 0, 'value-pulse-ok'),
    ).toBe(true);
    expect(hasOptOutMarker(['/** docs-link-ok: the host is incidental here. */'], 0, 'docs-link-ok')).toBe(true);
    expect(
      hasJsxOptOutMarker(
        ['{/* select-none-ok: the drag handle needs selectable text. */}'],
        0,
        'select-none-ok',
      ),
    ).toBe(true);
  });
});

describe('MARKER_WALK_CAP', () => {
  const FILLER = '// filler comment, nothing to see here.';

  function commentBlockLines(markerLine: string, fillerCount: number, targetLine: string): string[] {
    return [markerLine, ...Array.from({ length: fillerCount }, () => FILLER), targetLine];
  }

  it('does not reach a marker more than 60 lines above the target, in an unbroken comment block', () => {
    // 64 filler comment lines keep the block unbroken between the marker (index
    // 0) and the target (the last line), so only the cap can stop either walk.
    const lines = commentBlockLines('// example-ok: too far to count.', 64, '  writeFileSync(path, value);');
    expect(hasOptOutMarker(lines, lines.length - 1, MARKER)).toBe(false);
    expect(hasJsxOptOutMarker(lines, lines.length - 1, MARKER)).toBe(false);
  });

  it('still finds a marker comfortably inside the cap', () => {
    const lines = commentBlockLines('// example-ok: well within range.', 10, '  writeFileSync(path, value);');
    expect(hasOptOutMarker(lines, lines.length - 1, MARKER)).toBe(true);
    expect(hasJsxOptOutMarker(lines, lines.length - 1, MARKER)).toBe(true);
  });
});

describe('hasJsxOptOutMarker', () => {
  it('finds a marker above a multi-line opening tag', () => {
    const lines = [
      '  {/* example-ok: the handle draws a grip icon and no text. */}',
      '  <div',
      '    className="cursor-grab"',
      '    onPointerDown={handlePointerDown}',
      '  >',
    ];
    expect(hasJsxOptOutMarker(lines, 2, MARKER)).toBe(true);
  });

  it('stops at a sibling closing tag', () => {
    const lines = [
      '  {/* example-ok: applies to the element above, not below. */}',
      '  <span>label</span>',
      '  </div>',
      '  <div className="cursor-grab" />',
    ];
    expect(hasJsxOptOutMarker(lines, 3, MARKER)).toBe(false);
  });

  it('does not carry a marker past a single-line self-closing sibling', () => {
    const lines = [
      '  {/* example-ok: meant for the first one. */}',
      '  <div className="cursor-grab" />',
      '  <div className="cursor-move" />',
    ];
    expect(hasJsxOptOutMarker(lines, 2, MARKER)).toBe(false);
  });

  it('still leaks past a MULTI-line self-closing sibling, which is the known hole', () => {
    // Pinned so the limitation is visible rather than discovered. The sibling's
    // `/>` tail reads like our own attribute list, and telling them apart needs
    // real bracket matching. If this ever starts returning false, the walk grew
    // a parser and this test should become the assertion that it works.
    const lines = [
      '  {/* example-ok: meant for the first one. */}',
      '  <div',
      '    className="cursor-grab"',
      '  />',
      '  <div className="cursor-move" />',
    ];
    expect(hasJsxOptOutMarker(lines, 4, MARKER)).toBe(true);
  });

  it('is more permissive than the plain rule, which is why it is opt-in', () => {
    // The attribute-list walk is exactly what the plain rule must not do: in
    // ordinary TypeScript those intervening lines are unrelated statements.
    const lines = ['  {/* example-ok: reason. */}', '  <div', '    className="cursor-grab"', '  >'];
    expect(hasJsxOptOutMarker(lines, 3, MARKER)).toBe(true);
    expect(hasOptOutMarker(lines, 3, MARKER)).toBe(false);
  });

  it('keeps climbing through a blank line between the marker and a multi-line opening tag, unlike the plain rule', () => {
    // hasOptOutMarker stops at a blank line by design. This walker does not,
    // because the marker and the opening tag are routinely separated by a blank
    // line in real JSX, and that gap is the point of this fixture, not incidental.
    const lines = [
      '  {/* example-ok: the handle draws a grip icon and no text. */}',
      '',
      '  <div',
      '    className="cursor-grab"',
      '    onPointerDown={handlePointerDown}',
      '  >',
    ];
    expect(hasJsxOptOutMarker(lines, 3, MARKER)).toBe(true);
  });

  it('stops at a plain statement above a passed opening tag', () => {
    // Exercises the passedOpeningTag return path directly: the walk has already
    // climbed past one opening tag, and the next line up is ordinary code, not a
    // comment or another tag. A marker sitting further up must not reach through.
    const lines = [
      '  // example-ok: too far up to apply here.',
      '  const items = getItems();',
      '  <div',
      '    className="cursor-grab"',
      '  >',
    ];
    expect(hasJsxOptOutMarker(lines, 3, MARKER)).toBe(false);
  });
});

describe('hasFileScopedOptOut', () => {
  it('matches a marker anywhere in the file', () => {
    const contents = 'const a = 1;\n// example-ok: an ancestor carries the real exemption.\nconst b = 2;\n';
    expect(hasFileScopedOptOut(contents, MARKER)).toBe(true);
  });

  it('still requires a reason', () => {
    expect(hasFileScopedOptOut('// example-ok:\n', MARKER)).toBe(false);
  });

  it('requires the reason on the marker\'s OWN line', () => {
    // This rule matches whole file text, so a `\s*` before the reason character
    // crossed the line break and let the NEXT line stand in as the reason. A
    // bare marker was then honoured in every file that had anything after it,
    // which is every real file; the one-line fixture above was the only shape
    // that still failed. Measured before fixing.
    expect(hasFileScopedOptOut('// example-ok:\nconst b = 2;\n', MARKER)).toBe(false);
    expect(hasFileScopedOptOut('// example-ok:\n// unrelated prose\n', MARKER)).toBe(false);
    expect(hasFileScopedOptOut('// example-ok:\n\nconst b = 2;\n', MARKER)).toBe(false);
    // The real shape every live file-scoped site uses still passes.
    expect(hasFileScopedOptOut('const a = 1;\n// example-ok: an ancestor carries it.\n', MARKER)).toBe(true);
  });

  it('does not match a file with no marker', () => {
    expect(hasFileScopedOptOut('const a = 1;\n', MARKER)).toBe(false);
  });
});

describe('hasLineOnlyOptOutMarker', () => {
  it('matches a marker on the line itself', () => {
    const lines = ['  const width = ref.getBoundingClientRect().width; // example-ok: sizes a sibling.'];
    expect(hasLineOnlyOptOutMarker(lines, 0, MARKER)).toBe(true);
  });

  it('does NOT reach the comment block above, which is the whole point', () => {
    // The difference from hasOptOutMarker, pinned directly. A line here can
    // carry several violations, so a marker above cannot say which it waives.
    const lines = ['  // example-ok: sizes a sibling.', '  const width = ref.getBoundingClientRect().width;'];
    expect(hasLineOnlyOptOutMarker(lines, 1, MARKER)).toBe(false);
    expect(hasOptOutMarker(lines, 1, MARKER)).toBe(true);
  });

  it('still requires a reason and still rejects quoted prose', () => {
    expect(hasLineOnlyOptOutMarker(['  const w = r.width; // example-ok:'], 0, MARKER)).toBe(false);
    expect(hasLineOnlyOptOutMarker(['  const w = r.width; // not an `example-ok:` site'], 0, MARKER)).toBe(false);
  });

  it('tolerates an out-of-range index', () => {
    expect(hasLineOnlyOptOutMarker([], 0, MARKER)).toBe(false);
  });
});

describe('every tests/unit scan reads its marker through this module', () => {
  /**
   * The adoption guard, which replaced a census paragraph in the helper's
   * docblock. That paragraph was hand-kept, and it drifted within one merge: it
   * claimed four markers were unmigrated and had already missed a fifth
   * (`toast-count-ok`). A list nobody can forget to update is a scan.
   *
   * A real marker is `<name>-ok:` WITH the colon. Test-fixture ids like
   * `task-ok` or `sess-ok` carry none, so they do not trip this.
   */
  const UNIT_DIR = __dirname;

  /**
   * Markers are named `<thing>-ok` by convention, and that convention is what
   * lets this pattern find a NEW one with no list to maintain. `hmr-safe`
   * predates it and is the one name the pattern cannot derive, so it is spelled
   * out. Prefer ending a new marker in `-ok` over extending this: every name
   * added here is a name someone has to remember to add.
   */
  const LEGACY_MARKER_NAMES = ['hmr-safe'];
  const MARKER_LITERAL = new RegExp(
    `\\b(?:[a-z][a-z0-9]*(?:-[a-z0-9]+)*-ok|${LEGACY_MARKER_NAMES.join('|')}):`,
  );
  const HELPER_IMPORT = './helpers/opt-out-marker';

  /**
   * Files that name a marker without reading one. Each needs a reason, because
   * the cheap way to pass this guard is to add an entry instead of an import.
   *
   * Empty today, and legitimately so: every file that names a marker reads one.
   * The helper's own suite names `example-ok` all over and would qualify, but it
   * imports the module it tests, so it passes the same way every consumer does.
   */
  const NOT_MARKER_READERS = new Map<string, string>();

  type ScannedFile = { name: string; contents: string };

  /**
   * The scan itself, pure, so the allowlist branch can be exercised. Reading it
   * straight off the live directory left that branch dead: with no entry to
   * skip, deleting the lookup altogether changed no result.
   */
  function handRolledMarkerReaders(
    files: ScannedFile[],
    allowlist: ReadonlySet<string>,
  ): string[] {
    return files
      .filter(({ name, contents }) =>
        !allowlist.has(name)
        && MARKER_LITERAL.test(contents)
        && !contents.includes(HELPER_IMPORT))
      .map(({ name }) => name);
  }

  /**
   * Recursive, because `tests/unit` has subdirectories (`mobile-bridge/`,
   * `protocol/`) holding 60-odd suites. None is a convention scan today, so a
   * flat read gave the right ANSWER while being blind to a whole tree - which
   * is the shape of silent gap this guard exists to close. Names are posix
   * paths relative to `tests/unit`, so a top-level file is still its bare name.
   */
  function unitTestFiles(directory: string = UNIT_DIR): string[] {
    const found: string[] = [];
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) found.push(...unitTestFiles(full));
      else if (entry.name.endsWith('.test.ts')) found.push(full);
    }
    return directory === UNIT_DIR
      ? found.map((absolute) => path.relative(UNIT_DIR, absolute).split(path.sep).join('/'))
      : found;
  }

  function scannedFiles(): ScannedFile[] {
    return unitTestFiles().map((name) => ({
      name,
      contents: fs.readFileSync(path.join(UNIT_DIR, name), 'utf-8'),
    }));
  }

  it('fails any scan that names a marker but hand-rolls its reader', () => {
    const offenders = handRolledMarkerReaders(scannedFiles(), new Set(NOT_MARKER_READERS.keys()));

    expect(
      offenders,
      'These scans name a `<name>-ok:` marker but do not import helpers/opt-out-marker.\n'
      + 'A private reader drifts from the shared one: five different association rules were in\n'
      + 'the tree at once, and the hand-rolled ones let a bare marker with no reason waive a\n'
      + 'site while prose quoting a marker read as taking it.\n\n'
      + 'Import the rule that matches the code shape (hasOptOutMarker, hasJsxOptOutMarker,\n'
      + 'hasLineOnlyOptOutMarker, hasFileScopedOptOut), or add an entry with a reason to\n'
      + 'NOT_MARKER_READERS here:\n'
      + offenders.join('\n'),
    ).toEqual([]);
  });

  it('reports a hand-rolled reader, and the allowlist actually waives one', () => {
    // The mechanism against fixtures, because the live tree has nothing to
    // report and nothing to waive, so it exercises neither branch.
    const files: ScannedFile[] = [
      { name: 'hand-rolled.test.ts', contents: "const OPT_OUT = 'cookie-copy-ok:';" },
      { name: 'migrated.test.ts', contents: `import { hasOptOutMarker } from '${HELPER_IMPORT}';\n// sync-write-ok: x` },
      { name: 'unrelated.test.ts', contents: "const taskId = 'task-ok';" },
    ];
    expect(handRolledMarkerReaders(files, new Set())).toEqual(['hand-rolled.test.ts']);
    expect(handRolledMarkerReaders(files, new Set(['hand-rolled.test.ts']))).toEqual([]);
  });

  it('every allowlist entry names a file that exists and carries a reason', () => {
    // A stale entry is how an allowlist becomes the census it replaced. Vacuous
    // while the map is empty, and load-bearing the moment anyone adds to it.
    const present = new Set(unitTestFiles());
    for (const [name, reason] of NOT_MARKER_READERS) {
      expect(present.has(name), `${name} is allowlisted but no longer exists`).toBe(true);
      expect(reason.length, `${name} needs a reason`).toBeGreaterThan(10);
    }
  });

  it('scans a real, non-empty set of files and sees known consumers', () => {
    // Anti-vacuity. A renamed directory or a broken read would otherwise empty
    // the scan, and an empty scan passes.
    const files = unitTestFiles();
    expect(files.length).toBeGreaterThan(50);
    // The recursive half: a flat read would miss these entirely.
    expect(files, 'the walk must descend into tests/unit subdirectories')
      .toContain('protocol/roster.test.ts');

    // Stronger than a file count: the guard above is satisfied when NOTHING
    // matches, so pin that the pattern actually fires against real file text.
    // Without this, breaking MARKER_LITERAL into a regex that matches nothing
    // leaves the guard green while it enforces nothing at all.
    const naming = scannedFiles().filter(({ contents }) => MARKER_LITERAL.test(contents));
    expect(naming.length, 'the marker pattern matched no file in tests/unit').toBeGreaterThan(10);

    for (const known of [
      'guarded-sync-writes.test.ts',
      'cookie-jar-sharing.test.ts',
      'agent-driven-focus-sites.test.ts',
      'toast-negative-assertion.test.ts',
      'popover-inflow-menu.test.ts',
      'column-archived-filter-single-source.test.ts',
    ]) {
      expect(files, `${known} is a marker reader and should be scanned`).toContain(known);
    }
  });

  it('detects the shape it bans', () => {
    // The guard is a regex over file text, so pin what counts as a marker.
    expect(MARKER_LITERAL.test("const OPT_OUT = 'cookie-copy-ok:';")).toBe(true);
    expect(MARKER_LITERAL.test('// sync-write-ok: the caller reports.')).toBe(true);
    // The one marker whose name the `-ok` convention does not cover. Without
    // this the guard would miss a hand-rolled `hmr-safe` reader entirely.
    expect(MARKER_LITERAL.test('// hmr-safe: the guard survives Fast Refresh.')).toBe(true);
    // Fixture ids, which have no colon, must not drag a file into the scan.
    expect(MARKER_LITERAL.test("const taskId = 'task-ok';")).toBe(false);
    expect(MARKER_LITERAL.test("sessions: ['sess-ok', 't-ok']")).toBe(false);
  });
});

/**
 * Covers the shared opt-out marker reader (`helpers/opt-out-marker.ts`), which
 * a dozen convention scans now depend on. A bug here does not fail loudly: it
 * makes every one of those scans quietly stop enforcing, or quietly start
 * rejecting markers that are really there. So the three association rules and
 * the reason requirement are pinned directly rather than only through their
 * consumers.
 */

import { describe, it, expect } from 'vitest';
import {
  hasOptOutMarker,
  hasJsxOptOutMarker,
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

  it('does not match a file with no marker', () => {
    expect(hasFileScopedOptOut('const a = 1;\n', MARKER)).toBe(false);
  });
});

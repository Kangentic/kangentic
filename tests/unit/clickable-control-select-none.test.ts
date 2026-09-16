import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';

// Guards the text-selection half of the clickable-control convention. A native
// <button> gets `user-select: none` from the @layer base rule in index.css
// (pinned by button-cursor-base-rule.test.ts), but that rule is scoped to
// native buttons on purpose: role="button" is spread onto dnd-kit wrapper divs,
// so widening it would leak into a column's dead space. Every hand-rolled
// clickable control therefore has to opt in with `select-none` itself, or a
// click that drifts a few pixels selects the control's label instead of
// activating it.
//
// The scan parses the real TSX AST rather than matching `<Tag ...>` with a
// regex. A regex truncates at the `>` inside `onClick={() => ...}`, which
// silently drops exactly the clickable elements this guard exists to check, and
// a backward walk for the tag name misreads a <button> whose attributes span
// several lines. Both were measured while writing this test.
//
// `user-select` is inherited, so `select-none` on a container applies to every
// descendant. Where a control legitimately holds text a user copies (a live log
// line, an id), the call site overrides that locally with `select-text` rather
// than dropping the container's `select-none`.
//
// Scope is any ACTION_CURSORS cursor, not `cursor-pointer` alone. A drag source
// loses its gesture to a stray selection at least as badly as a click target
// does, and the board's TaskCard is exactly that case.

const REPO_ROOT = path.resolve(__dirname, '../..');
const RENDERER_ROOT = path.join(REPO_ROOT, 'src/renderer');

// How many lines above the element a `// select-none-ok:` marker may sit. The
// element's own opening line counts, so a marker on the line directly above a
// multi-line opening tag is still found.
const MARKER_LOOKBACK_LINES = 3;

// The cursors that advertise a gesture, matching the action cursors
// `light-dismiss-denylist.md` already enumerates. They share the failure this
// guard exists to stop: a press that drifts a few pixels selects the label
// instead of running the gesture. `cursor-grab` is the load-bearing one. The
// board's TaskCard is a drag source, not a plain click target, so a
// pointer-only check left every card outside the guard and a revert of its
// `select-none` would have stayed green. `cursor-grab` also substring-matches
// `active:cursor-grabbing`, which is harmless: both name the same handle.
const ACTION_CURSORS = [
  'cursor-pointer',
  'cursor-grab',
  'cursor-move',
  'cursor-col-resize',
  'cursor-row-resize',
];

interface ClickableControl {
  file: string;
  line: number;
  tagName: string;
  marked: boolean;
}

function collectTsxFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...collectTsxFiles(fullPath));
    else if (entry.name.endsWith('.tsx')) found.push(fullPath);
  }
  return found;
}

// Takes the source text rather than a path so the detector's own positive path
// can be driven over known-bad input below. Without that, a broken `inScope`
// would report nothing and the whole suite would pass vacuously.
function scanSource(fileLabel: string, source: string): ClickableControl[] {
  const sourceFile = ts.createSourceFile(
    fileLabel,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );
  const sourceLines = source.split('\n');
  const found: ClickableControl[] = [];

  function visit(node: ts.Node): void {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tagName = node.tagName.getText(sourceFile);
      const attributes = node.attributes.properties.filter(ts.isJsxAttribute);
      const hasOnClick = attributes.some(
        (attribute) => attribute.name.getText(sourceFile) === 'onClick',
      );

      // A native <button> is covered by the base rule. Resolving the className
      // costs a getText() over the whole attribute, so it runs only after the
      // two cheap predicates pass: nearly every JSX node in the tree is a
      // layout wrapper with no onClick at all.
      if (tagName !== 'button' && hasOnClick) {
        const classNameAttribute = attributes.find(
          (attribute) => attribute.name.getText(sourceFile) === 'className',
        );
        const classNameText = classNameAttribute?.initializer?.getText(sourceFile) ?? '';

        // A control is in scope only when it both acts (onClick) and advertises
        // the action with a cursor; a plain hover affordance is not a click
        // target.
        const inScope = ACTION_CURSORS.some((cursor) => classNameText.includes(cursor))
          && !classNameText.includes('select-none');

        if (inScope) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
          const lookbackStart = Math.max(0, line - MARKER_LOOKBACK_LINES);
          const markerLookbackText = sourceLines.slice(lookbackStart, line + 1).join('\n');
          found.push({
            file: fileLabel,
            line: line + 1,
            tagName,
            marked: markerLookbackText.includes('select-none-ok:'),
          });
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

function scanFile(filePath: string): ClickableControl[] {
  return scanSource(
    path.relative(REPO_ROOT, filePath).replace(/\\/g, '/'),
    fs.readFileSync(filePath, 'utf-8'),
  );
}

const rendererTsxFiles = collectTsxFiles(RENDERER_ROOT);
const allControls = rendererTsxFiles.flatMap(scanFile);

describe('clickable controls opt out of text selection', () => {
  it('has no unmarked non-button clickable control missing select-none', () => {
    const unmarked = allControls.filter((control) => !control.marked);
    const report = unmarked
      .map((control) => `  ${control.file}:${control.line} <${control.tagName}>`)
      .join('\n');

    expect(
      unmarked,
      unmarked.length === 0
        ? ''
        : `Clickable non-button controls missing \`select-none\`:\n${report}\n\n`
          + 'Add `select-none` to the element, or scope it to the text-bearing child and\n'
          + 'mark the element with `// select-none-ok: <reason>`.',
    ).toEqual([]);
  });

  // Without this the scan could pass vacuously: a parser change that stops
  // matching JSX elements would report zero unmarked controls and look green.
  // The marked sites are the proof it still resolves real elements.
  it('still resolves the known exempt controls (scan is not vacuous)', () => {
    const markedFiles = allControls
      .filter((control) => control.marked)
      .map((control) => control.file);

    expect(markedFiles).toEqual(
      expect.arrayContaining([
        'src/renderer/components/backlog/view/useBacklogColumns.tsx',
        'src/renderer/components/dialogs/completed-tasks/useCompletedColumns.tsx',
        'src/renderer/components/sidebar/project-sidebar/GroupHeader.tsx',
        'src/renderer/components/sidebar/project-sidebar/ProjectListItem.tsx',
        'src/renderer/components/terminal/TerminalPanel.tsx',
      ]),
    );
  });

  it('scans a meaningful number of renderer components', () => {
    expect(rendererTsxFiles.length).toBeGreaterThan(100);
  });
});

// The three cases above can all stay green while the detector is broken: an
// `inScope` that stops matching leaves `unmarked` empty, and the marker check
// reads raw source text, so it keeps resolving the five exempt files either
// way. These drive the detector over known input instead, so its positive path
// is pinned rather than assumed.
describe('the select-none detector itself', () => {
  it('reports an unmarked clickable control that lacks select-none', () => {
    const found = scanSource('probe.tsx', [
      'export const Probe = () => (',
      '  <div className="cursor-pointer" onClick={() => undefined}>Open</div>',
      ');',
    ].join('\n'));

    expect(found).toEqual([
      { file: 'probe.tsx', line: 2, tagName: 'div', marked: false },
    ]);
  });

  it('reports a cursor-grab drag source, not only cursor-pointer', () => {
    const found = scanSource('probe.tsx', [
      'export const Probe = () => (',
      '  <div className="cursor-grab active:cursor-grabbing" onClick={() => undefined}>Card</div>',
      ');',
    ].join('\n'));

    expect(found.map((control) => control.tagName)).toEqual(['div']);
  });

  it('clears a control that carries select-none', () => {
    const found = scanSource('probe.tsx', [
      'export const Probe = () => (',
      '  <div className="cursor-pointer select-none" onClick={() => undefined}>Open</div>',
      ');',
    ].join('\n'));

    expect(found).toEqual([]);
  });

  it('marks a control whose opt-out comment sits within the lookback window', () => {
    const found = scanSource('probe.tsx', [
      'export const Probe = () => (',
      '  // select-none-ok: the probe renders no text.',
      '  <div className="cursor-pointer" onClick={() => undefined} />',
      ');',
    ].join('\n'));

    expect(found.map((control) => control.marked)).toEqual([true]);
  });

  it('ignores a native button and a cursor-pointer element with no onClick', () => {
    const found = scanSource('probe.tsx', [
      'export const Probe = () => (',
      '  <>',
      '    <button className="cursor-pointer" onClick={() => undefined}>Go</button>',
      '    <div className="cursor-pointer">Hover only</div>',
      '  </>',
      ');',
    ].join('\n'));

    expect(found).toEqual([]);
  });
});

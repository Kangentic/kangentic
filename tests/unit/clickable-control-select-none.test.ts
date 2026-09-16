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

const REPO_ROOT = path.resolve(__dirname, '../..');
const RENDERER_ROOT = path.join(REPO_ROOT, 'src/renderer');

// How many lines above the element a `// select-none-ok:` marker may sit. The
// element's own opening line counts, so a marker on the line directly above a
// multi-line opening tag is still found.
const MARKER_LOOKBACK_LINES = 3;

interface ClickableControl {
  file: string;
  line: number;
  tagName: string;
  marked: boolean;
}

function collectTsxFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...collectTsxFiles(full));
    else if (entry.name.endsWith('.tsx')) found.push(full);
  }
  return found;
}

function scanFile(filePath: string): ClickableControl[] {
  const source = fs.readFileSync(filePath, 'utf-8');
  const sourceFile = ts.createSourceFile(
    path.basename(filePath),
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
      const classNameAttribute = attributes.find(
        (attribute) => attribute.name.getText(sourceFile) === 'className',
      );
      const classNameText = classNameAttribute?.initializer?.getText(sourceFile) ?? '';
      const hasOnClick = attributes.some(
        (attribute) => attribute.name.getText(sourceFile) === 'onClick',
      );

      // A native <button> is covered by the base rule. A control is in scope
      // only when it both acts (onClick) and advertises the action
      // (cursor-pointer); a plain hover affordance is not a click target.
      const inScope = tagName !== 'button'
        && hasOnClick
        && classNameText.includes('cursor-pointer')
        && !classNameText.includes('select-none');

      if (inScope) {
        const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
        const lookbackStart = Math.max(0, line - MARKER_LOOKBACK_LINES);
        const context = sourceLines.slice(lookbackStart, line + 1).join('\n');
        found.push({
          file: path.relative(REPO_ROOT, filePath).replace(/\\/g, '/'),
          line: line + 1,
          tagName,
          marked: context.includes('select-none-ok:'),
        });
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

const allControls = collectTsxFiles(RENDERER_ROOT).flatMap(scanFile);

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
    expect(collectTsxFiles(RENDERER_ROOT).length).toBeGreaterThan(100);
  });
});

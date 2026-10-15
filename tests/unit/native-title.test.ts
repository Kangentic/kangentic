import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';

// Guards `.claude/rules/one-tooltip.md`: hover text in the renderer is HoverTip
// (src/renderer/components/HoverTip.tsx), everywhere, with no exception. A native
// `title` is slow, unstyled, square-cornered beside the rounded HoverTip, never
// shown to a keyboard user, cannot draw key chips, and is tested only as an
// attribute. That holds for the full value of text the layout cuts short too: a
// truncated path gets a HoverTip with the whole path, so every tooltip in the app
// looks and behaves the same.
//
// What counts as a native tooltip:
//  - a `title` attribute on an intrinsic element (a lowercase tag),
//  - an SVG `<title>` element,
//  - an object literal spread onto an intrinsic element that carries `title`.
// A component prop named `title` is never visited: on ConfirmDialog, BaseDialog
// and the rest it is a heading. That leaves one hole: a component that spreads
// `...rest` onto an element passes a `title` it was given straight through, and
// this scan sees neither end. The backstop is the type: Pill, IsolatedBadge and
// Select omit `title` from the attributes they accept.
//
// There is no opt-out marker. A comment cannot make a native tooltip look like
// the rest of the app, so the scan has nothing to accept one for.
//
// The scan parses the TSX AST, as clickable-control-select-none.test.ts does: a
// regex truncates at the `>` inside `onClick={() => ...}` and misreads tags whose
// attributes span lines.

const REPO_ROOT = path.resolve(__dirname, '../..');
const RENDERER_ROOT = path.join(REPO_ROOT, 'src/renderer');

/** Dev-only overlays, built out of production; they keep their raw titles on purpose. */
const EXEMPT_DIRECTORY = 'src/renderer/components/debug/';

interface NativeTitleSite {
  file: string;
  line: number;
  kind: 'attribute' | 'svg-title' | 'spread';
  tagName: string;
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

function isIntrinsic(tagName: string): boolean {
  return /^[a-z][\w-]*$/.test(tagName);
}

/**
 * A property's key as written, unquoted, so `'title'`, `title`, `['title']` and a computed key in
 * backticks with no substitution are all the same key.
 */
function propertyKey(member: ts.ObjectLiteralElementLike, sourceFile: ts.SourceFile): string | undefined {
  const name = member.name;
  if (name === undefined) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)) return name.expression.text;
  return name.getText(sourceFile);
}

/**
 * The object literals a spread can place on an element: the literal itself, or the object side
 * of `condition && { ... }` and either branch of `condition ? { ... } : { ... }`.
 */
function spreadObjectLiterals(expression: ts.Expression): ts.ObjectLiteralExpression[] {
  if (ts.isParenthesizedExpression(expression)) return spreadObjectLiterals(expression.expression);
  if (ts.isObjectLiteralExpression(expression)) return [expression];
  if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) {
    return spreadObjectLiterals(expression.right);
  }
  if (ts.isConditionalExpression(expression)) {
    return [...spreadObjectLiterals(expression.whenTrue), ...spreadObjectLiterals(expression.whenFalse)];
  }
  return [];
}

// Takes the source text rather than a path so the detector can be driven over
// known-bad input below; a broken visitor would otherwise report nothing and
// every case would pass.
function scanSource(fileLabel: string, source: string): NativeTitleSite[] {
  const sourceFile = ts.createSourceFile(fileLabel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const found: NativeTitleSite[] = [];

  function record(node: ts.Node, kind: NativeTitleSite['kind'], tagName: string): void {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
    found.push({ file: fileLabel, line: line + 1, kind, tagName });
  }

  function visit(node: ts.Node): void {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const tagName = node.tagName.getText(sourceFile);
      if (tagName === 'title') record(node, 'svg-title', tagName);
      if (isIntrinsic(tagName)) {
        for (const property of node.attributes.properties) {
          if (ts.isJsxAttribute(property) && property.name.getText(sourceFile) === 'title') {
            record(property, 'attribute', tagName);
          } else if (
            ts.isJsxSpreadAttribute(property)
            && spreadObjectLiterals(property.expression).some((literal) =>
              literal.properties.some((member) => propertyKey(member, sourceFile) === 'title'))
          ) {
            record(property, 'spread', tagName);
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

function relative(filePath: string): string {
  return path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
}

const rendererTsxFiles = collectTsxFiles(RENDERER_ROOT);
const allSites = rendererTsxFiles.flatMap((filePath) => scanSource(relative(filePath), fs.readFileSync(filePath, 'utf-8')));
const scannedSites = allSites.filter((site) => !site.file.startsWith(EXEMPT_DIRECTORY));

describe('native titles in the renderer', () => {
  it('has none: every tooltip is a HoverTip', () => {
    const listed = scannedSites.map((site) => `  ${site.file}:${site.line} <${site.tagName}> (${site.kind})`);
    expect(
      listed,
      'Native tooltips found. Wrap the element in HoverTip (src/renderer/components/HoverTip.tsx) and\n'
        + 'drop its `title`; the full value of cut-short text is a HoverTip too. See .claude/rules/one-tooltip.md.\n'
        + listed.join('\n'),
    ).toEqual([]);
  });

  it('scans a meaningful number of renderer components', () => {
    expect(rendererTsxFiles.length).toBeGreaterThan(100);
  });

  // The exemption is a decision, so it must be the reason those sites are
  // skipped: if the walk stopped reaching the folder, this would say so instead
  // of the exemption silently covering nothing.
  it('reaches the exempt debug overlays and skips them only by the exemption', () => {
    expect(allSites.some((site) => site.file.startsWith(EXEMPT_DIRECTORY))).toBe(true);
  });
});

describe('the native title detector itself', () => {
  it('reports a title attribute on an intrinsic element', () => {
    const found = scanSource('probe.tsx', [
      'export const Probe = () => (',
      '  <button title="Close">x</button>',
      ');',
    ].join('\n'));
    expect(found.map((site) => [site.line, site.kind, site.tagName])).toEqual([[2, 'attribute', 'button']]);
  });

  it('reports an SVG title element', () => {
    const found = scanSource('probe.tsx', [
      'export const Probe = () => (',
      '  <svg><title>Running</title></svg>',
      ');',
    ].join('\n'));
    expect(found.map((site) => site.kind)).toEqual(['svg-title']);
  });

  it('reports an object literal spread that carries title', () => {
    const found = scanSource('probe.tsx', [
      'export const Probe = () => (',
      "  <span {...{ title: 'Why' }} />",
      ');',
    ].join('\n'));
    expect(found.map((site) => site.kind)).toEqual(['spread']);
  });

  it('reports a spread whose title key is quoted, shorthand, or behind a condition', () => {
    const found = scanSource('probe.tsx', [
      'export const Probe = () => (',
      '  <div>',
      "    <span {...{ 'title': 'Why' }} />",
      '    <span {...{ title }} />',
      '    <span {...(open && { title: why })} />',
      '    <span {...(open ? { title: why } : {})} />',
      '  </div>',
      ');',
    ].join('\n'));
    expect(found.map((site) => [site.line, site.kind])).toEqual([[3, 'spread'], [4, 'spread'], [5, 'spread'], [6, 'spread']]);
  });

  it('reports a spread whose title key is computed from a string or a plain backtick string', () => {
    const found = scanSource('probe.tsx', [
      'export const Probe = () => (',
      '  <div>',
      "    <span {...{ ['title']: why }} />",
      '    <span {...{ [`title`]: why }} />',
      '  </div>',
      ');',
    ].join('\n'));
    expect(found.map((site) => [site.line, site.kind])).toEqual([[3, 'spread'], [4, 'spread']]);
  });

  it('does not report a spread whose computed key is a variable', () => {
    const found = scanSource('probe.tsx', [
      'export const Probe = () => (',
      '  <span {...{ [attributeName]: why }} />',
      ');',
    ].join('\n'));
    expect(found).toEqual([]);
  });

  it('does not report a conditional spread with no title in it', () => {
    const found = scanSource('probe.tsx', [
      'export const Probe = () => (',
      "  <span {...(open ? { role: 'note' } : {})} />",
      ');',
    ].join('\n'));
    expect(found).toEqual([]);
  });

  it('ignores a component prop named title and title in plain object data', () => {
    const found = scanSource('probe.tsx', [
      "const columns = [{ title: 'Name' }];",
      'export const Probe = () => (',
      '  <ConfirmDialog title="Delete task" message={columns.length} />',
      ');',
    ].join('\n'));
    expect(found).toEqual([]);
  });

  it('reports a title on a multi-line opening tag at the attribute', () => {
    const found = scanSource('probe.tsx', [
      'export const Probe = () => (',
      '  <span',
      '    className="truncate"',
      '    title={path}',
      '  >{path}</span>',
      ');',
    ].join('\n'));
    expect(found.map((site) => [site.line, site.kind])).toEqual([[4, 'attribute']]);
  });

  // The keeper marker this scan once accepted is gone: a truncated value's full
  // text is a HoverTip like every other tip, so a comment exempts nothing.
  it('reports a title even under the retired native-title-ok marker', () => {
    const found = scanSource('probe.tsx', [
      'export const Probe = () => (',
      '  // native-title-ok: full value of the truncated path',
      '  <span className="truncate" title={path}>{path}</span>',
      ');',
    ].join('\n'));
    expect(found.map((site) => [site.line, site.kind])).toEqual([[3, 'attribute']]);
  });

  // The scan sees an object literal spread, where the keys are visible, and nothing behind a
  // spread of a variable. `one-tooltip.md` names this gap and leaves it to the component types
  // (Pill, IsolatedBadge and Select omit `title`), so the detector must not guess at it.
  it('does not report a spread of a non-literal', () => {
    const found = scanSource('probe.tsx', [
      'export const Probe = ({ ...rest }) => (',
      '  <span className="truncate" {...rest} />',
      ');',
    ].join('\n'));
    expect(found).toEqual([]);
  });
});

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';

// Guards `.claude/rules/one-tooltip.md`: a control carries no generic "Click to..."
// instruction. A tip that says "Click to open" or "Click to change model" tells a
// user what every control on the screen already does, and it shows on every hover
// of a control they use constantly.
//
// The scan reads every string the renderer could show rather than the props of
// each Tooltip. A tip often arrives through a variable or a helper
// (ModelEffortPicker built its tip in a local, DataTable in `sortHint()`), and a
// scan of `label=` and `detail=` attributes would read only the name. So it
// checks every string literal, every template's leading text (which covers the
// `t` and `msg` tagged templates and `msg({ message })`), and every JSX text run
// (which covers `<Trans>`), and fails on one that opens with "Click to".
//
// The other half of the rule, a tip that restates its control's label or section
// header, needs to know what the control shows, so it stays review-only.
//
// The scan parses the TS/TSX AST, as native-title.test.ts does, so a comment that
// quotes the phrase (like this one) is never read as copy.

const REPO_ROOT = path.resolve(__dirname, '../..');
const RENDERER_ROOT = path.join(REPO_ROOT, 'src/renderer');

// The text may end right after "to": `<Trans>Click to{' '}<b>sort</b></Trans>`
// splits its JSX text there.
const CLICK_INSTRUCTION = /^\s*click to(\s|$)/i;

interface ClickInstructionSite {
  file: string;
  line: number;
  text: string;
}

function collectSourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...collectSourceFiles(fullPath));
    else if (/\.tsx?$/.test(entry.name) && !entry.name.endsWith('.d.ts')) found.push(fullPath);
  }
  return found;
}

/** The text a node could put on screen, or null for a node that holds none. */
function shownText(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text;
  if (ts.isJsxText(node)) return node.text;
  return null;
}

// Takes the source text rather than a path so the detector can be driven over
// known-bad input below; a broken visitor would otherwise report nothing and
// every case would pass.
function scanSource(fileLabel: string, source: string): ClickInstructionSite[] {
  const scriptKind = fileLabel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(fileLabel, source, ts.ScriptTarget.Latest, true, scriptKind);
  const found: ClickInstructionSite[] = [];

  function visit(node: ts.Node): void {
    const text = shownText(node);
    if (text !== null && CLICK_INSTRUCTION.test(text)) {
      const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
      found.push({ file: fileLabel, line: line + 1, text: text.trim() });
    }
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return found;
}

function relative(filePath: string): string {
  return path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
}

const rendererFiles = collectSourceFiles(RENDERER_ROOT);
const allSites = rendererFiles.flatMap((filePath) => scanSource(relative(filePath), fs.readFileSync(filePath, 'utf-8')));

describe('"Click to..." instructions in the renderer', () => {
  it('has none: a tip says what the click does not already show', () => {
    const listed = allSites.map((site) => `  ${site.file}:${site.line} "${site.text}"`);
    expect(
      listed,
      'Generic "Click to..." copy found. Drop it, or say what the control does not already show.\n'
        + 'See .claude/rules/one-tooltip.md.\n'
        + listed.join('\n'),
    ).toEqual([]);
  });

  it('scans a meaningful number of renderer files', () => {
    expect(rendererFiles.length).toBeGreaterThan(100);
  });
});

describe('the "Click to" detector itself', () => {
  it('reports a t and a msg tagged template', () => {
    const found = scanSource('probe.tsx', [
      'const hint = msg`Click to sort`;',
      'export const Probe = () => <Tooltip label={t`Click to change model`}><button /></Tooltip>;',
    ].join('\n'));
    expect(found.map((site) => [site.line, site.text])).toEqual([[1, 'Click to sort'], [2, 'Click to change model']]);
  });

  it('reports a template with a placeholder by its leading text', () => {
    const found = scanSource('probe.tsx', [
      'export const Probe = ({ name }) => <Tooltip label={t`Click to open ${name}`}><button /></Tooltip>;',
    ].join('\n'));
    expect(found.map((site) => site.text)).toEqual(['Click to open']);
  });

  it('reports a message descriptor, a plain constant and a Trans text', () => {
    const found = scanSource('probe.tsx', [
      "const descriptor = msg({ message: 'Click to open', context: 'tip' });",
      "export const SORT_HINT = 'Click to sort - Shift+Click adds a secondary sort';",
      'export const Probe = () => (',
      '  <span><Trans>Click to copy</Trans></span>',
      ');',
    ].join('\n'));
    expect(found.map((site) => site.line)).toEqual([1, 2, 4]);
  });

  it('reports a JSX text run that ends right after "to"', () => {
    const found = scanSource('probe.tsx', [
      "export const Probe = () => <Trans>Click to{' '}<b>sort</b></Trans>;",
    ].join('\n'));
    expect(found.map((site) => site.text)).toEqual(['Click to']);
  });

  it('reports a .ts module too', () => {
    const found = scanSource('probe.ts', "export const tip = i18n._(msg`click to expand`);");
    expect(found.map((site) => site.text)).toEqual(['click to expand']);
  });

  it('ignores the phrase mid-sentence, a different verb, and comments', () => {
    const found = scanSource('probe.tsx', [
      '// Click to open used to be the tip here.',
      'const waiting = t`Waiting for the agent to report. Click to change.`;',
      "const sortLine = 'Shift+Click adds a secondary sort';",
      "const clicks = 'Clicking toggles the row';",
      "const tops = 'Click top to scroll';",
      "const className = 'cursor-pointer select-none';",
    ].join('\n'));
    expect(found).toEqual([]);
  });
});

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';
import { hasJsxOptOutMarker, hasOptOutMarker } from './helpers/opt-out-marker';
import { I18N_UNCONVERTED_FILES } from './helpers/i18n-unconverted-files';
import { I18N_UNCONVERTED_TOAST_FILES } from './helpers/i18n-unconverted-toast-files';

// Guards `.claude/rules/i18n.md`: user-facing text in the renderer goes through Lingui, so a
// translation can reach it. Hard-coded English shows in every language.
//
// What counts as hard-coded, in a renderer `.tsx` file:
//  - JSX text with a letter in it, outside a macro element (`<Trans>`, `<Plural>`, `<Select>`,
//    `<SelectOrdinal>`, whose children ARE the message) and outside `<code>`, `<kbd>`, `<pre>`
//    and `<samp>`, whose content is verbatim;
//  - a string literal with a letter in it, as a JSX child expression or as the value of a prop
//    that carries UI text (`UI_TEXT_PROPS`: label, placeholder, aria-label, a dialog's title and
//    message, a tooltip's tip...), including both arms of a conditional and a `??` fallback;
//  - a `t` macro call at module scope, which runs once at load, before the session's catalog is
//    active, so it is English forever. A module-level list uses `msg` and translates where it
//    renders.
//
// Not yet converted areas are allowlisted per file (helpers/i18n-unconverted-files.ts), grouped by
// catalog area and owner, and the three extraction tasks empty it. A listed file with nothing left
// fails, so the list only shrinks. Text that must stay as written (a product name alone, a file
// name, a shell command) carries `{/* i18n-ok: <reason> */}` on its line or above its element,
// read through tests/unit/helpers/opt-out-marker.ts. `components/debug/` is dev-only and exempt.
//
// A second scan covers what the first cannot see: a toast's text, which sits in the object literal
// handed to `addToast(...)` or `updateToast(id, ...)`, often in a `.ts` file. A literal `title`,
// `message` or `action.label` is hard-coded. Files still waiting for extraction are listed in
// helpers/i18n-unconverted-toast-files.ts, which only shrinks too; `// i18n-ok: <reason>` on the
// field's line or in the comment block above it marks text that stays. A toast raised through an
// alias (`const toast = store.addToast; toast({...})`) is out of its reach.
//
// The scans parse the TSX AST, as native-title.test.ts does.

const REPO_ROOT = path.resolve(__dirname, '../..');
const RENDERER_ROOT = path.join(REPO_ROOT, 'src/renderer');
const EXEMPT_DIRECTORY = 'src/renderer/components/debug/';
const MARKER = 'i18n-ok';

/** Props whose string value a user reads or hears. */
const UI_TEXT_PROPS = new Set([
  'label', 'placeholder', 'title', 'description', 'message', 'tip', 'tooltip', 'detail', 'hint', 'info',
  'heading', 'subtitle', 'caption', 'alt', 'tag', 'requirement', 'inlineDescription',
  'confirmLabel', 'cancelLabel', 'dontAskAgainLabel', 'emptyText', 'emptyLabel', 'emptyMessage',
  'ariaLabel', 'aria-label', 'aria-description', 'aria-placeholder', 'aria-valuetext', 'aria-roledescription',
]);
const MACRO_ELEMENTS = new Set(['Trans', 'Plural', 'Select', 'SelectOrdinal']);
const VERBATIM_ELEMENTS = new Set(['code', 'kbd', 'pre', 'samp']);
const HAS_LETTER = /\p{L}/u;

interface HardcodedTextSite {
  line: number;
  kind: 'jsx-text' | 'jsx-expression' | 'prop' | 'module-scope-t' | 'toast';
  text: string;
}

function collectSourceFiles(directory: string, pattern: RegExp): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...collectSourceFiles(fullPath, pattern));
    else if (pattern.test(entry.name)) found.push(fullPath);
  }
  return found;
}

function collectTsxFiles(directory: string): string[] {
  return collectSourceFiles(directory, /\.tsx$/);
}

/** The toast-store calls, and which argument carries the toast's text. */
const TOAST_CALL_ARGUMENT = new Map([['addToast', 0], ['updateToast', 1]]);
const TOAST_TEXT_FIELDS = new Set(['title', 'message']);

function calleeName(expression: ts.Expression): string | undefined {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return undefined;
}

function assignedName(property: ts.ObjectLiteralElementLike): string | undefined {
  if (!ts.isPropertyAssignment(property)) return undefined;
  const name = property.name;
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : undefined;
}

/** Every literal title, body or button label handed to the toast store in one file's source. */
function scanToastSource(fileLabel: string, source: string): HardcodedTextSite[] {
  const scriptKind = fileLabel.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(fileLabel, source, ts.ScriptTarget.Latest, true, scriptKind);
  const lines = source.split('\n');
  const sites: HardcodedTextSite[] = [];

  const checkInitializer = (property: ts.PropertyAssignment) => {
    const prose = literalTexts(property.initializer).find((text) => HAS_LETTER.test(text));
    if (prose === undefined) return;
    const line = sourceFile.getLineAndCharacterOfPosition(property.getStart(sourceFile)).line;
    if (hasOptOutMarker(lines, line, MARKER)) return;
    sites.push({ line: line + 1, kind: 'toast', text: prose.trim().replace(/\s+/g, ' ').slice(0, 60) });
  };

  const checkToastFields = (fields: ts.ObjectLiteralExpression) => {
    for (const property of fields.properties) {
      const name = assignedName(property);
      if (!name || !ts.isPropertyAssignment(property)) continue;
      if (TOAST_TEXT_FIELDS.has(name)) checkInitializer(property);
      else if (name === 'action' && ts.isObjectLiteralExpression(property.initializer)) {
        for (const actionProperty of property.initializer.properties) {
          if (assignedName(actionProperty) === 'label' && ts.isPropertyAssignment(actionProperty)) {
            checkInitializer(actionProperty);
          }
        }
      }
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node.expression);
      const argumentIndex = name === undefined ? undefined : TOAST_CALL_ARGUMENT.get(name);
      const fields = argumentIndex === undefined ? undefined : node.arguments[argumentIndex];
      if (fields && ts.isObjectLiteralExpression(fields)) checkToastFields(fields);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return sites;
}

/** Every literal string an expression can evaluate to, through conditionals and fallbacks. */
function literalTexts(expression: ts.Expression): string[] {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return [expression.text];
  if (ts.isTemplateExpression(expression)) {
    return [expression.head.text, ...expression.templateSpans.map((span) => span.literal.text)];
  }
  if (ts.isParenthesizedExpression(expression)) return literalTexts(expression.expression);
  if (ts.isConditionalExpression(expression)) return [...literalTexts(expression.whenTrue), ...literalTexts(expression.whenFalse)];
  if (ts.isBinaryExpression(expression)) {
    const operator = expression.operatorToken.kind;
    if (operator === ts.SyntaxKind.QuestionQuestionToken || operator === ts.SyntaxKind.BarBarToken) {
      return [...literalTexts(expression.left), ...literalTexts(expression.right)];
    }
    if (operator === ts.SyntaxKind.AmpersandAmpersandToken) return literalTexts(expression.right);
    if (operator === ts.SyntaxKind.PlusToken) return [...literalTexts(expression.left), ...literalTexts(expression.right)];
  }
  return [];
}

function tagNameOf(element: ts.JsxOpeningElement | ts.JsxSelfClosingElement, sourceFile: ts.SourceFile): string {
  return element.tagName.getText(sourceFile);
}

/** The names a file imports `t` under from the build-time core macro. */
function importedTMacroNames(sourceFile: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    if (statement.moduleSpecifier.text !== '@lingui/core/macro') continue;
    const bindings = statement.importClause?.namedBindings;
    if (!bindings || !ts.isNamedImports(bindings)) continue;
    for (const element of bindings.elements) {
      if ((element.propertyName ?? element.name).text === 't') names.add(element.name.text);
    }
  }
  return names;
}

function isInsideFunction(node: ts.Node): boolean {
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isFunctionLike(current)) return true;
  }
  return false;
}

/** Every hard-coded text site in one file's source. */
function scanSource(fileLabel: string, source: string): HardcodedTextSite[] {
  const sourceFile = ts.createSourceFile(fileLabel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const lines = source.split('\n');
  const tMacroNames = importedTMacroNames(sourceFile);
  const sites: HardcodedTextSite[] = [];

  const record = (node: ts.Node, kind: HardcodedTextSite['kind'], text: string) => {
    const line = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line;
    if (hasJsxOptOutMarker(lines, line, MARKER)) return;
    sites.push({ line: line + 1, kind, text: text.trim().replace(/\s+/g, ' ').slice(0, 60) });
  };

  const checkAttributes = (element: ts.JsxOpeningElement | ts.JsxSelfClosingElement) => {
    for (const property of element.attributes.properties) {
      if (!ts.isJsxAttribute(property) || !UI_TEXT_PROPS.has(property.name.getText(sourceFile))) continue;
      const initializer = property.initializer;
      if (!initializer) continue;
      const texts = ts.isStringLiteral(initializer)
        ? [initializer.text]
        : ts.isJsxExpression(initializer) && initializer.expression ? literalTexts(initializer.expression) : [];
      const prose = texts.find((text) => HAS_LETTER.test(text));
      if (prose !== undefined) record(property, 'prop', prose);
    }
  };

  // JSX passed as a prop (`icon={<span>Hi</span>}`, `render={() => <p>Hi</p>}`) is
  // drawn like a child, so each attribute's expression is scanned too. A macro
  // element's attributes are its message (`<Plural one="# task">`) and are skipped.
  const visitAttributeExpressions = (element: ts.JsxOpeningElement | ts.JsxSelfClosingElement, insideVerbatim: boolean) => {
    for (const property of element.attributes.properties) {
      if (!ts.isJsxAttribute(property)) continue;
      const initializer = property.initializer;
      if (initializer && ts.isJsxExpression(initializer) && initializer.expression) {
        visit(initializer.expression, false, insideVerbatim);
      }
    }
  };

  const visit = (node: ts.Node, insideMacro: boolean, insideVerbatim: boolean): void => {
    if (ts.isJsxElement(node)) {
      const tagName = tagNameOf(node.openingElement, sourceFile);
      const isMacro = MACRO_ELEMENTS.has(tagName);
      if (!isMacro && !insideMacro) {
        checkAttributes(node.openingElement);
        visitAttributeExpressions(node.openingElement, insideVerbatim);
      }
      for (const child of node.children) {
        visit(child, insideMacro || isMacro, insideVerbatim || VERBATIM_ELEMENTS.has(tagName));
      }
      return;
    }
    if (ts.isJsxSelfClosingElement(node)) {
      if (!MACRO_ELEMENTS.has(tagNameOf(node, sourceFile)) && !insideMacro) {
        checkAttributes(node);
        visitAttributeExpressions(node, insideVerbatim);
      }
      return;
    }
    if (ts.isJsxText(node)) {
      if (!insideMacro && !insideVerbatim && HAS_LETTER.test(node.text)) record(node, 'jsx-text', node.text);
      return;
    }
    if (ts.isJsxExpression(node) && node.parent && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) {
      if (!insideMacro && !insideVerbatim && node.expression) {
        const prose = literalTexts(node.expression).find((text) => HAS_LETTER.test(text));
        if (prose !== undefined) record(node, 'jsx-expression', prose);
      }
      if (node.expression) visit(node.expression, insideMacro, insideVerbatim);
      return;
    }
    if (tMacroNames.size > 0 && !isInsideFunction(node)) {
      const tag = ts.isTaggedTemplateExpression(node) ? node.tag : ts.isCallExpression(node) ? node.expression : undefined;
      if (tag && ts.isIdentifier(tag) && tMacroNames.has(tag.text)) record(node, 'module-scope-t', node.getText(sourceFile));
    }
    ts.forEachChild(node, (child) => visit(child, insideMacro, insideVerbatim));
  };
  visit(sourceFile, false, false);
  return sites;
}

function relativePosix(filePath: string): string {
  return path.relative(REPO_ROOT, filePath).replace(/\\/g, '/');
}

const scannedFiles = collectTsxFiles(RENDERER_ROOT)
  .map((filePath) => ({ file: relativePosix(filePath), filePath }))
  .filter(({ file }) => !file.startsWith(EXEMPT_DIRECTORY));
const sitesByFile = new Map(
  scannedFiles.map(({ file, filePath }) => [file, scanSource(file, fs.readFileSync(filePath, 'utf8'))] as const),
);
const allowlisted = new Set(Object.values(I18N_UNCONVERTED_FILES).flat());

describe('hard-coded UI text in the renderer', () => {
  it('scans the renderer', () => {
    expect(scannedFiles.length).toBeGreaterThan(300);
  });

  it('has none outside the files still waiting for extraction', () => {
    const offenders = [...sitesByFile.entries()]
      .filter(([file, sites]) => sites.length > 0 && !allowlisted.has(file))
      .flatMap(([file, sites]) => sites.map((site) => `${file}:${site.line} ${site.kind} "${site.text}"`));
    expect(
      offenders,
      'Put user-facing text through Lingui: <Trans> for JSX text, `t` from useLingui() for a prop, '
      + '`msg` for a module-level list (see .claude/rules/i18n.md). Text that must stay as written takes '
      + '{/* i18n-ok: <reason> */}.',
    ).toEqual([]);
  });

  it('lists only files that still hold hard-coded text, so the allowlist only shrinks', () => {
    const missing = [...allowlisted].filter((file) => !sitesByFile.has(file));
    expect(missing, 'Allowlisted files that no longer exist: remove them from helpers/i18n-unconverted-files.ts').toEqual([]);
    const converted = [...allowlisted].filter((file) => (sitesByFile.get(file) ?? []).length === 0);
    expect(converted, 'These files are converted: remove them from helpers/i18n-unconverted-files.ts').toEqual([]);
  });

  it('files each allowlisted file under its own catalog area', () => {
    const misfiled = Object.entries(I18N_UNCONVERTED_FILES).flatMap(([area, files]) =>
      files.filter((file) => catalogAreaOf(file) !== area).map((file) => `${file} is under ${area}, its catalog is ${catalogAreaOf(file)}`));
    expect(misfiled).toEqual([]);
  });
});

const toastScannedFiles = collectSourceFiles(RENDERER_ROOT, /\.tsx?$/)
  .map((filePath) => ({ file: relativePosix(filePath), filePath }))
  .filter(({ file }) => !file.startsWith(EXEMPT_DIRECTORY) && !file.endsWith('.d.ts'));
const toastSitesByFile = new Map(
  toastScannedFiles.map(({ file, filePath }) => [file, scanToastSource(file, fs.readFileSync(filePath, 'utf8'))] as const),
);
const toastAllowlisted = new Set(Object.values(I18N_UNCONVERTED_TOAST_FILES).flat());

describe('literal toast text in the renderer', () => {
  it('scans the renderer, its .ts modules included, and finds the toast calls', () => {
    expect(toastScannedFiles.length).toBeGreaterThan(scannedFiles.length);
    // Not vacuous: the toast store's own callers are where the text used to be literal.
    const callers = toastScannedFiles.filter(({ filePath }) => /\b(?:addToast|updateToast)\(/.test(fs.readFileSync(filePath, 'utf8')));
    expect(callers.length).toBeGreaterThan(40);
  });

  it('has none outside the files still waiting for extraction', () => {
    const offenders = [...toastSitesByFile.entries()]
      .filter(([file, sites]) => sites.length > 0 && !toastAllowlisted.has(file))
      .flatMap(([file, sites]) => sites.map((site) => `${file}:${site.line} ${site.kind} "${site.text}"`));
    expect(
      offenders,
      'Put a toast\'s title, body and button label through Lingui: `t` in a component, '
      + '`i18n._(msg...)` in a .ts module (see .claude/rules/i18n.md). Text main wrote, such as '
      + '`asSentence(describeIpcError(error))`, is not a literal and needs nothing.',
    ).toEqual([]);
  });

  it('lists only files that still raise literal toast text, so the list only shrinks', () => {
    const missing = [...toastAllowlisted].filter((file) => !toastSitesByFile.has(file));
    expect(missing, 'Listed files that no longer exist: remove them from helpers/i18n-unconverted-toast-files.ts').toEqual([]);
    const converted = [...toastAllowlisted].filter((file) => (toastSitesByFile.get(file) ?? []).length === 0);
    expect(converted, 'These files are converted: remove them from helpers/i18n-unconverted-toast-files.ts').toEqual([]);
  });

  it('files each listed file under its own catalog area', () => {
    const misfiled = Object.entries(I18N_UNCONVERTED_TOAST_FILES).flatMap(([area, files]) =>
      files.filter((file) => catalogAreaOf(file) !== area).map((file) => `${file} is under ${area}, its catalog is ${catalogAreaOf(file)}`));
    expect(misfiled).toEqual([]);
  });
});

describe('literal toast text detector (fixtures)', () => {
  const kinds = (source: string, file = 'fixture.ts') => scanToastSource(file, source).map((site) => site.text);

  it('flags a literal title, body or button label, through a store read and in updateToast', () => {
    expect(kinds("useToastStore.getState().addToast({ title: 'Saved', message: 'The task moved.' });"))
      .toEqual(['Saved', 'The task moved.']);
    expect(kinds("addToast({ title: ok ? 'Agent resumed' : 'Agent started', message: body });")).toEqual(['Agent resumed']);
    expect(kinds("store.updateToast(id, { title: `${count} agents paused` });")).toEqual(['agents paused']);
    expect(kinds("addToast({ title: t, message: m, persistent: true, action: { label: 'Review', icon: 'review' } });"))
      .toEqual(['Review']);
    expect(kinds("export function A() { addToast({ title: 'Saved', message: m }); return null; }", 'fixture.tsx')).toEqual(['Saved']);
  });

  it('leaves translated text, main\'s reasons, placeholders only and marked fields alone', () => {
    expect(kinds('addToast({ title: i18n._(msg`Saved`), message: asSentence(describeIpcError(error)) });')).toEqual([]);
    expect(kinds('addToast({ title: t`Saved`, message: `${taskTitle}: ${reason}` });')).toEqual([]);
    expect(kinds("addToast({\n  // i18n-ok: the product name\n  title: 'Kangentic',\n  message: m,\n});")).toEqual([]);
    expect(kinds("dismissToast('Saved');")).toEqual([]);
    // A marker needs its reason.
    expect(kinds("addToast({\n  // i18n-ok:\n  title: 'Kangentic',\n  message: m,\n});")).toEqual(['Kangentic']);
  });
});

/** The catalog a renderer file extracts into (lingui.config.ts): its components/ folder, else src-renderer. */
function catalogAreaOf(file: string): string {
  const match = /^src\/renderer\/components\/([^/]+)\//.exec(file);
  return match ? match[1] : 'src-renderer';
}

// The live scan above is only as good as its detectors, so they run over known-bad and
// known-good source here, independent of the tree.
describe('hard-coded text detectors (fixtures)', () => {
  const kinds = (source: string) => scanSource('fixture.tsx', source).map((site) => site.kind);

  it('flags JSX text, a literal child, and a literal UI prop, including both arms of a conditional', () => {
    expect(kinds('export const A = () => <p>Hello there</p>;')).toEqual(['jsx-text']);
    expect(kinds("export const A = () => <p>{'Hello'}</p>;")).toEqual(['jsx-expression']);
    expect(kinds('export const A = () => <Button label="Save" />;')).toEqual(['prop']);
    expect(kinds("export const A = ({ on }) => <Button label={on ? 'On' : 'Off'} />;")).toEqual(['prop']);
    expect(kinds('export const A = () => <input aria-label="Search" />;')).toEqual(['prop']);
    expect(kinds('export const A = ({ name }) => <Tip label={name ?? `Untitled`} />;')).toEqual(['prop']);
  });

  it('flags text in JSX passed as a prop', () => {
    expect(kinds('export const A = () => <Foo icon={<span>Hello</span>} />;')).toEqual(['jsx-text']);
    expect(kinds('export const A = () => <Foo render={() => <p>Hello</p>}>x</Foo>;')).toEqual(['jsx-text', 'jsx-text']);
    expect(kinds('export const A = () => <Foo icon={<Icon size={14} />} />;')).toEqual([]);
  });

  it('leaves macros, verbatim elements, non-text props, symbols and marked sites alone', () => {
    expect(kinds("import { Trans } from '@lingui/react/macro';\nexport const A = () => <p><Trans>Hello <b>there</b></Trans></p>;")).toEqual([]);
    expect(kinds("import { Plural } from '@lingui/react/macro';\nexport const A = ({ n }) => <Plural value={n} one=\"# task\" other=\"# tasks\" />;")).toEqual([]);
    expect(kinds('export const A = () => <p><code>npm install</code></p>;')).toEqual([]);
    expect(kinds('export const A = () => <div data-testid="save-button" className="flex" />;')).toEqual([]);
    expect(kinds('export const A = () => <span>·</span>;')).toEqual([]);
    expect(kinds('export const A = () => <span>{count}</span>;')).toEqual([]);
    expect(kinds('export const A = () => (\n  // i18n-ok: the product name\n  <span>Kangentic</span>\n);')).toEqual([]);
    expect(kinds('export const A = () => (\n  <div>\n    {/* i18n-ok: the product name */}\n    <span>Kangentic</span>\n  </div>\n);')).toEqual([]);
    // A marker needs its reason.
    expect(kinds('export const A = () => (\n  <div>\n    {/* i18n-ok: */}\n    <span>Kangentic</span>\n  </div>\n);')).toEqual(['jsx-text']);
  });

  it('flags a module-scope t call and leaves one inside a function', () => {
    expect(kinds("import { t } from '@lingui/core/macro';\nconst LABEL = t`Save`;")).toEqual(['module-scope-t']);
    expect(kinds("import { t } from '@lingui/core/macro';\nexport function label() { return t`Save`; }")).toEqual([]);
    expect(kinds("import { msg } from '@lingui/core/macro';\nconst LABEL = msg`Save`;")).toEqual([]);
  });
});

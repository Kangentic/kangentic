/**
 * The settings card design scan: parses the settings tabs' TSX and reports the
 * cards, the tiles, the descriptions each card shows with their one-line budget,
 * and every design violation. `tests/unit/settings-card-design.test.ts` holds the
 * checks and the reasons behind them (`.claude/rules/settings-card-design.md`).
 *
 * It lives here, not in the test, because the translation harness
 * (`scripts/i18n/`) reads the same shown descriptions and budgets to check that a
 * translated description still fits on one line. The repo root is a parameter so
 * the harness can import this through esbuild, where `__dirname` does not exist.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';
import { SETTINGS_REGISTRY } from '../../../src/renderer/components/settings/settings-registry';
import { englishText } from '../../../src/shared/i18n/english';
import { hasJsxOptOutMarker } from './opt-out-marker';

const BASE_TILES = ['CardRow', 'CardToggleRow', 'CardChoiceRow', 'CardGroupTile', 'CardTile'];
/** Components that render their children in place, so the scan looks through them. */
const TRANSPARENT_WRAPPERS = new Set(['Fragment', 'React.Fragment', 'DndContext', 'SortableContext']);
/** What a tab may render at its top level besides cards. */
const TAB_ROOT_EXTRAS = new Set(['ConfirmDialog', 'DevToolsSections', 'WorkflowAgentPromptDialog', 'LanguageRestartDialog']);

/**
 * `CardTile`'s className is for layout inside the tile. A fill or padding there
 * would re-style one tile by hand: a darker well, or a label off the card's
 * left edge. The tile's own fill and insets come from the component.
 */
const TILE_STYLE_CLASS = /(^|\s)(bg-|p-|px-|py-|pt-|pb-|pl-|pr-)/;

/** Characters that fit on one line in each context (see the test's header comment). */
export const DESCRIPTION_BUDGET = {
  beside_switch: 60,
  no_switch: 66,
  nested_row: 54,
} as const;
export type BudgetContext = keyof typeof DESCRIPTION_BUDGET;

export interface ShownDescription {
  file: string;
  line: number;
  owner: string;
  text: string;
  context: BudgetContext;
}

interface Violation {
  file: string;
  line: number;
  where: string;
  found: string;
}

// A registry description is a `msg` descriptor once its area is translated, so it
// is resolved to the English the budgets measure before anything reads its length.
export const registryDescriptions = new Map(SETTINGS_REGISTRY.map((entry) => [entry.id, englishText(entry.description)]));

function parse(fileLabel: string, source: string): ts.SourceFile {
  return ts.createSourceFile(fileLabel, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
}

function tagName(node: ts.JsxElement | ts.JsxSelfClosingElement, sourceFile: ts.SourceFile): string {
  return (ts.isJsxElement(node) ? node.openingElement : node).tagName.getText(sourceFile);
}

function attributeNamed(element: ts.JsxOpeningLikeElement, name: string, sourceFile: ts.SourceFile): ts.JsxAttribute | undefined {
  return element.attributes.properties.find(
    (property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && property.name.getText(sourceFile) === name,
  );
}

/** The text of a template literal, with each placeholder written `{name}` as a translator sees it. */
function templateText(template: ts.TemplateLiteral, sourceFile: ts.SourceFile): string {
  if (ts.isNoSubstitutionTemplateLiteral(template)) return template.text;
  return template.head.text + template.templateSpans
    .map((span) => `{${span.expression.getText(sourceFile).replace(/[{}\s]/g, '')}}${span.literal.text}`)
    .join('');
}

/**
 * The English a description or label expression shows, through the Lingui
 * forms a converted tab uses: a string literal, `` t`...` `` or `` msg`...` ``,
 * `t({ message })` or `msg({ message })`, and `i18n._(...)` or
 * `translateText(...)` around one of those. Undefined for anything else, which
 * the budget then cannot measure. Without this, converting a tab to Lingui
 * would quietly take its descriptions out of the budget check.
 */
function macroText(expression: ts.Expression, sourceFile: ts.SourceFile): string | undefined {
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return expression.text;
  if (ts.isParenthesizedExpression(expression)) return macroText(expression.expression, sourceFile);
  if (ts.isTaggedTemplateExpression(expression)) {
    const tag = expression.tag.getText(sourceFile);
    return tag === 't' || tag === 'msg' ? templateText(expression.template, sourceFile) : undefined;
  }
  if (ts.isCallExpression(expression)) {
    const callee = expression.expression.getText(sourceFile);
    const [argument] = expression.arguments;
    if (!argument) return undefined;
    if (callee === 't' || callee === 'msg') {
      if (!ts.isObjectLiteralExpression(argument)) return macroText(argument, sourceFile);
      const message = argument.properties.find(
        (property): property is ts.PropertyAssignment => ts.isPropertyAssignment(property) && property.name.getText(sourceFile) === 'message',
      );
      return message ? macroText(message.initializer, sourceFile) : undefined;
    }
    if (callee === 'i18n._' || callee === 'translateText') return macroText(argument, sourceFile);
  }
  return undefined;
}

/** Every string literal inside an expression: `a ? undefined : 'text'` yields 'text'. */
function stringLiterals(node: ts.Node): string[] {
  const found: string[] = [];
  const walk = (current: ts.Node): void => {
    if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) found.push(current.text);
    ts.forEachChild(current, walk);
  };
  walk(node);
  return found;
}

/** The expressions a function-like returns: an arrow's expression body, or each `return`. */
function returnedExpressions(fn: ts.SignatureDeclarationBase & { body?: ts.Node }): ts.Expression[] {
  if (!fn.body) return [];
  if (!ts.isBlock(fn.body)) return [fn.body as ts.Expression];
  const found: ts.Expression[] = [];
  const walk = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) return; // a nested function's returns are its own
    if (ts.isReturnStatement(node) && node.expression) found.push(node.expression);
    ts.forEachChild(node, walk);
  };
  fn.body.forEachChild(walk);
  return found;
}

/**
 * Check that `node`, rendered in a place that only takes `allowed` tags, renders
 * nothing else: looks through fragments, transparent wrappers, conditionals and
 * `.map()` callbacks. Returns what it found that is not allowed.
 */
function disallowedRenders(
  node: ts.Node,
  allowed: (tag: string) => boolean,
  allowedIdentifier: (name: string) => boolean,
  sourceFile: ts.SourceFile,
): ts.Node[] {
  const bad: ts.Node[] = [];
  const visit = (current: ts.Node): void => {
    if (ts.isJsxText(current)) {
      if (current.getText(sourceFile).trim()) bad.push(current);
      return;
    }
    if (ts.isJsxExpression(current)) {
      if (current.expression) visit(current.expression);
      return;
    }
    if (ts.isParenthesizedExpression(current)) return visit(current.expression);
    if (ts.isConditionalExpression(current)) {
      visit(current.whenTrue);
      visit(current.whenFalse);
      return;
    }
    if (ts.isBinaryExpression(current) && current.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken) return visit(current.right);
    if (current.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(current) && current.text === 'undefined')) return;
    if (ts.isIdentifier(current) && allowedIdentifier(current.text)) return;
    if (ts.isJsxFragment(current)) {
      current.children.forEach(visit);
      return;
    }
    if (ts.isJsxElement(current) || ts.isJsxSelfClosingElement(current)) {
      const tag = tagName(current, sourceFile);
      if (TRANSPARENT_WRAPPERS.has(tag) && ts.isJsxElement(current)) {
        current.children.forEach(visit);
        return;
      }
      if (!allowed(tag)) bad.push(current);
      return;
    }
    // `list.map((item) => <Tile />)`: check what the callback returns.
    if (ts.isCallExpression(current) && ts.isPropertyAccessExpression(current.expression) && current.expression.name.text === 'map') {
      const [callback] = current.arguments;
      if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback))) {
        returnedExpressions(callback).forEach(visit);
        return;
      }
    }
    bad.push(current);
  };
  visit(node);
  return bad;
}

interface SourceUnit {
  label: string;
  sourceFile: ts.SourceFile;
}

function collectTsx(directory: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...collectTsx(fullPath));
    else if (entry.name.endsWith('.tsx')) found.push(fullPath);
  }
  return found;
}

/**
 * Names of components whose every return renders only tiles (or null), found
 * across the given sources. Repeats until stable, so a component that returns
 * another tile-rendering component counts too.
 */
function findTileComponents(units: SourceUnit[]): Set<string> {
  const tiles = new Set(BASE_TILES);
  let grew = true;
  while (grew) {
    grew = false;
    for (const { sourceFile } of units) {
      const visit = (node: ts.Node): void => {
        if (ts.isFunctionDeclaration(node) && node.name && /^[A-Z]/.test(node.name.text) && !tiles.has(node.name.text)) {
          const returns = returnedExpressions(node);
          const rendersOnlyTiles = returns.length > 0 && returns.every(
            (expression) => disallowedRenders(expression, (tag) => tiles.has(tag), () => false, sourceFile).length === 0,
          );
          if (rendersOnlyTiles) {
            tiles.add(node.name.text);
            grew = true;
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sourceFile);
    }
  }
  return tiles;
}

function scanUnit(unit: SourceUnit, tileComponents: Set<string>, isTabFile: boolean) {
  const { label: fileLabel, sourceFile } = unit;
  const cards: string[] = [];
  const checkedTabs: string[] = [];
  const descriptions: ShownDescription[] = [];
  const violations: Violation[] = [];
  const lineOf = (node: ts.Node): number => sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const sourceLines = sourceFile.text.split('\n');

  // `const relayHeading = settingProps('mobileBridge.relayMode')` lets a card
  // pass `description={relayHeading.description}`; resolve those too.
  const settingPropsBindings = new Map<string, string>();
  const collectBindings = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)
      && node.initializer.expression.getText(sourceFile) === 'settingProps') {
      const [argument] = node.initializer.arguments;
      if (argument && ts.isStringLiteral(argument)) settingPropsBindings.set(node.name.text, argument.text);
    }
    ts.forEachChild(node, collectBindings);
  };
  collectBindings(sourceFile);

  const spreadSettingId = (element: ts.JsxOpeningLikeElement): string | undefined => {
    for (const property of element.attributes.properties) {
      if (!ts.isJsxSpreadAttribute(property)) continue;
      const expression = property.expression;
      if (ts.isCallExpression(expression) && expression.expression.getText(sourceFile) === 'settingProps') {
        const [argument] = expression.arguments;
        if (argument && ts.isStringLiteral(argument)) return argument.text;
      }
    }
    return undefined;
  };

  const descriptionOf = (element: ts.JsxOpeningLikeElement): string | undefined => {
    const attribute = attributeNamed(element, 'description', sourceFile);
    if (attribute?.initializer) {
      if (ts.isStringLiteral(attribute.initializer)) return attribute.initializer.text;
      if (ts.isJsxExpression(attribute.initializer) && attribute.initializer.expression) {
        const expression = attribute.initializer.expression;
        const text = macroText(expression, sourceFile);
        if (text !== undefined) return text;
        if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression)) {
          const boundId = settingPropsBindings.get(expression.expression.text);
          if (boundId) return registryDescriptions.get(boundId);
        }
      }
      return undefined;
    }
    const id = spreadSettingId(element);
    return id ? registryDescriptions.get(id) : undefined;
  };

  const labelOf = (element: ts.JsxOpeningLikeElement): string => {
    const id = spreadSettingId(element);
    if (id) return id;
    const labelAttribute = attributeNamed(element, 'label', sourceFile);
    const initializer = labelAttribute?.initializer;
    if (!initializer) return element.tagName.getText(sourceFile);
    // A translated label reads as the literal it replaced, `"Board layout"`, so
    // a card is named the same before and after its tab is converted.
    if (ts.isJsxExpression(initializer) && initializer.expression) {
      const text = macroText(initializer.expression, sourceFile);
      if (text !== undefined) return JSON.stringify(text);
    }
    return initializer.getText(sourceFile);
  };

  const visit = (node: ts.Node): void => {
    // (1) A tab's top level is cards.
    if (isTabFile && ts.isFunctionDeclaration(node) && node.name && /Tab$/.test(node.name.text)) {
      checkedTabs.push(node.name.text);
      for (const expression of returnedExpressions(node)) {
        // A tab returns one card, or a wrapper (`<div className="space-y-4">` or a
        // fragment) that holds its cards.
        const root = ts.isParenthesizedExpression(expression) ? expression.expression : expression;
        if (root.kind === ts.SyntaxKind.NullKeyword) continue;
        if ((ts.isJsxElement(root) || ts.isJsxSelfClosingElement(root)) && tagName(root, sourceFile) === 'SettingsCard') continue;
        const children = ts.isJsxElement(root) || ts.isJsxFragment(root) ? root.children : undefined;
        if (!children) {
          violations.push({ file: fileLabel, line: lineOf(root), where: `${node.name.text} top level`, found: root.getText(sourceFile).slice(0, 50) });
          continue;
        }
        for (const child of children) {
          for (const bad of disallowedRenders(child, (tag) => tag === 'SettingsCard' || TAB_ROOT_EXTRAS.has(tag), (name) => /Dialog$/.test(name), sourceFile)) {
            violations.push({ file: fileLabel, line: lineOf(bad), where: `${node.name.text} top level`, found: bad.getText(sourceFile).slice(0, 50) });
          }
        }
      }
    }

    const opening = ts.isJsxElement(node) ? node.openingElement : ts.isJsxSelfClosingElement(node) ? node : undefined;
    if (opening) {
      const tag = opening.tagName.getText(sourceFile);
      if (tag === 'SettingsCard') {
        const card = labelOf(opening);
        cards.push(card);
        const hasSwitch = attributeNamed(opening, 'checked', sourceFile) !== undefined;
        const context: BudgetContext = hasSwitch ? 'beside_switch' : 'no_switch';
        const description = descriptionOf(opening);
        if (description !== undefined) descriptions.push({ file: fileLabel, line: lineOf(opening), owner: card, text: description, context });
        const unavailable = attributeNamed(opening, 'requirement', sourceFile);
        if (unavailable?.initializer) {
          for (const text of stringLiterals(unavailable.initializer)) {
            descriptions.push({ file: fileLabel, line: lineOf(unavailable), owner: `${card} (unavailable)`, text, context });
          }
        }
        // (2) Every body child is a tile.
        if (ts.isJsxElement(node)) {
          for (const child of node.children) {
            for (const bad of disallowedRenders(child, (childTag) => tileComponents.has(childTag), () => false, sourceFile)) {
              violations.push({ file: fileLabel, line: lineOf(bad), where: `card "${card}"`, found: ts.isJsxElement(bad) || ts.isJsxSelfClosingElement(bad) ? `<${tagName(bad, sourceFile)}>` : bad.getText(sourceFile).slice(0, 40) });
            }
          }
        }
      }
      // (5) A short fixed choice is never a dropdown, unless marked. Only
      // static <option>s count: a Select whose options come from a list may
      // hold three today and ten tomorrow.
      if (tag === 'Select' && ts.isJsxElement(node)) {
        const staticOptions = node.children.filter(
          (child) => ts.isJsxElement(child) && child.openingElement.tagName.getText(sourceFile) === 'option',
        ).length;
        // A `{/* comment */}` child is an empty expression and lists nothing.
        const listed = node.children.some((child) => ts.isJsxExpression(child) && child.expression !== undefined);
        const marked = hasJsxOptOutMarker(sourceLines, lineOf(opening) - 1, 'choice-select-ok');
        if (staticOptions >= 2 && staticOptions <= 4 && !listed && !marked) {
          violations.push({ file: fileLabel, line: lineOf(opening), where: 'Select', found: 'short fixed choice as a dropdown: use CardChoiceRow or SegmentedControl' });
        }
      }
      // (3) A CardTile never restyles itself.
      if (tag === 'CardTile') {
        const className = attributeNamed(opening, 'className', sourceFile);
        const classText = className?.initializer ? stringLiterals(className.initializer).join(' ') : '';
        if (TILE_STYLE_CLASS.test(classText)) {
          violations.push({ file: fileLabel, line: lineOf(opening), where: 'CardTile', found: `restyled tile: "${classText}"` });
        }
      }
      if (tag === 'CardToggleRow' && attributeNamed(opening, 'inlineDescription', sourceFile)) {
        const description = descriptionOf(opening);
        const nested = attributeNamed(opening, 'nested', sourceFile) !== undefined;
        if (description !== undefined) {
          descriptions.push({ file: fileLabel, line: lineOf(opening), owner: labelOf(opening), text: description, context: nested ? 'nested_row' : 'beside_switch' });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return { cards, checkedTabs, descriptions, violations };
}

function scanSources(units: SourceUnit[], tabLabels: Set<string>) {
  const tileComponents = findTileComponents(units);
  const results = units.map((unit) => scanUnit(unit, tileComponents, tabLabels.has(unit.label)));
  return {
    tileComponents,
    cards: results.flatMap((result) => result.cards),
    checkedTabs: results.flatMap((result) => result.checkedTabs),
    descriptions: results.flatMap((result) => result.descriptions),
    violations: results.flatMap((result) => result.violations),
  };
}

/** Scan the real settings tree under `repoRoot`, plus the dev-only cards the Developer tab renders. */
export function scanRealSettings(repoRoot: string) {
  const settingsRoot = path.join(repoRoot, 'src/renderer/components/settings');
  const tabsRoot = path.join(settingsRoot, 'tabs');
  // Dev-only cards rendered inside the Developer tab; build-excluded, but the same design.
  const devSectionsFile = path.join(repoRoot, 'src/devtools/renderer/DevToolsSections.tsx');
  const files = [...collectTsx(settingsRoot), devSectionsFile];
  const units = files.map((file) => ({
    label: path.relative(repoRoot, file).split(path.sep).join('/'),
    sourceFile: parse(file, fs.readFileSync(file, 'utf-8')),
  }));
  const tabLabels = new Set(
    fs.readdirSync(tabsRoot)
      .filter((name) => /Tab\.tsx$/.test(name))
      .map((name) => path.relative(repoRoot, path.join(tabsRoot, name)).split(path.sep).join('/')),
  );
  return { ...scanSources(units, tabLabels), tabLabels };
}

export function scanSnippet(label: string, source: string, isTab = false) {
  return scanSources([{ label, sourceFile: parse(label, source) }], new Set(isTab ? [label] : []));
}

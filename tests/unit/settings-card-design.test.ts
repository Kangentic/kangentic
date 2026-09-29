import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';
import { SETTINGS_REGISTRY } from '../../src/renderer/components/settings/settings-registry';
import { hasJsxOptOutMarker } from './helpers/opt-out-marker';

// Guards the settings card design (`.claude/rules/settings-card-design.md`).
// Five things a new tab or a new setting can quietly break, and that no type or
// lint check sees:
//
// 1. Every settings tab is built from cards. A tab's top level holds
//    `SettingsCard`s (plus its dialogs and the dev-only sections), never a loose
//    row, so every tab in the panel flows the same way.
// 2. Every child of a card body is a tile component (`CardRow`,
//    `CardToggleRow`, `CardChoiceRow`, `CardTile`, or a component whose every
//    return is one). A
//    raw `<div>` in a body renders as a bare block among tiles: no fill, no
//    inset, and a label off the card's left edge. A `wideBody` card holds a grid
//    directly by design.
// 3. A `CardTile` never sets its own fill or padding.
// 4. Every description a card SHOWS (a header's, or a toggle row's with
//    `inlineDescription`) fits on one line. The settings panel is a fixed 720px,
//    but the UI font is the OS's own, so a pixel check on the Linux runner would
//    measure a font no user sees. The budget is characters instead, set from the
//    widest text measured in Segoe UI (5.7px per character) against each
//    context's text column, with room left for the wider macOS and Linux fonts:
//    a header or row beside a switch has 373px, a header with no switch 421px, a
//    nested row 343px. Tooltip (`InfoTip`) text is not shown inline and has no
//    budget.
// 5. A short fixed choice, two to four options, is a segmented control
//    (`CardChoiceRow`, or `SegmentedControl` inside a tile), never a `<Select>`:
//    every option shows at once and any is one click away. A set whose labels
//    do not fit beside the row's label keeps its dropdown and says so with
//    `// choice-select-ok: <reason>`.
//
// The scan parses TSX ASTs, the same way clickable-control-select-none.test.ts
// does, and every detector is driven over known-bad input below so a broken walk
// cannot pass vacuously.

const REPO_ROOT = path.resolve(__dirname, '../..');
const SETTINGS_ROOT = path.join(REPO_ROOT, 'src/renderer/components/settings');
const TABS_ROOT = path.join(SETTINGS_ROOT, 'tabs');
/** Dev-only cards rendered inside the Developer tab; build-excluded, but the same design. */
const DEV_SECTIONS_FILE = path.join(REPO_ROOT, 'src/devtools/renderer/DevToolsSections.tsx');

const BASE_TILES = ['CardRow', 'CardToggleRow', 'CardChoiceRow', 'CardTile'];
/** Components that render their children in place, so the scan looks through them. */
const TRANSPARENT_WRAPPERS = new Set(['Fragment', 'React.Fragment', 'DndContext', 'SortableContext']);
/** What a tab may render at its top level besides cards. */
const TAB_ROOT_EXTRAS = new Set(['ConfirmDialog', 'DevToolsSections']);

/**
 * `CardTile`'s className is for layout inside the tile. A fill or padding there
 * would re-style one tile by hand: a darker well, or a label off the card's
 * left edge. The tile's own fill and insets come from the component.
 */
const TILE_STYLE_CLASS = /(^|\s)(bg-|p-|px-|py-|pt-|pb-|pl-|pr-)/;

/** Characters that fit on one line in each context (see the header comment). */
const DESCRIPTION_BUDGET = {
  beside_switch: 60,
  no_switch: 66,
  nested_row: 54,
} as const;
type BudgetContext = keyof typeof DESCRIPTION_BUDGET;

interface ShownDescription {
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

const registryDescriptions = new Map(SETTINGS_REGISTRY.map((entry) => [entry.id, entry.description]));

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
        if (ts.isStringLiteral(expression)) return expression.text;
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
    return labelAttribute?.initializer ? labelAttribute.initializer.getText(sourceFile) : element.tagName.getText(sourceFile);
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
        const wideBody = attributeNamed(opening, 'wideBody', sourceFile) !== undefined;
        if (ts.isJsxElement(node) && !wideBody) {
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

function scanRealSettings() {
  const files = [...collectTsx(SETTINGS_ROOT), DEV_SECTIONS_FILE];
  const units = files.map((file) => ({
    label: path.relative(REPO_ROOT, file).split(path.sep).join('/'),
    sourceFile: parse(file, fs.readFileSync(file, 'utf-8')),
  }));
  const tabLabels = new Set(
    fs.readdirSync(TABS_ROOT)
      .filter((name) => /Tab\.tsx$/.test(name))
      .map((name) => path.relative(REPO_ROOT, path.join(TABS_ROOT, name)).split(path.sep).join('/')),
  );
  return { ...scanSources(units, tabLabels), tabLabels };
}

function scanSnippet(label: string, source: string, isTab = false) {
  return scanSources([{ label, sourceFile: parse(label, source) }], new Set(isTab ? [label] : []));
}

describe('settings card design', () => {
  it('every tab is cards, every card body is tiles, and no tile restyles itself', () => {
    const { violations } = scanRealSettings();
    const report = violations.map((violation) => `${violation.file}:${violation.line} in ${violation.where}: ${violation.found}`);
    expect(report, 'Put settings in a SettingsCard; wrap custom content in <CardTile>; use CardRow or CardToggleRow for a setting').toEqual([]);
  });

  it('every description a card shows fits on one line', () => {
    const { descriptions } = scanRealSettings();
    const over = descriptions
      .filter((entry) => entry.text.length > DESCRIPTION_BUDGET[entry.context])
      .map((entry) => `${entry.file}:${entry.line} ${entry.owner}: ${entry.text.length} > ${DESCRIPTION_BUDGET[entry.context]} (${entry.context}) "${entry.text}"`);
    expect(over, 'Shorten the description; the whole sentence has to fit on one line').toEqual([]);
  });

  it('reads the real settings tree, so no check passes vacuously', () => {
    const { cards, checkedTabs, descriptions, tileComponents, tabLabels } = scanRealSettings();
    // Every tab file is covered by the top-level check.
    expect(tabLabels.size).toBeGreaterThan(15);
    expect(checkedTabs.length).toBe(tabLabels.size);
    // A card per feature on tabs across the panel, the dev-only sections included.
    for (const card of ['memory.indexingEnabled', 'git.worktreesEnabled', 'dictation.enabled', 'browserAutomation.enabled',
      'mcpServer.enabled', 'mobileBridge.enabled', 'browser.enabled', '"Board layout"', '"Sessions"', '"Terminal"',
      '"Appearance"', '"Shortcuts"', '"Analytics"', '"Diagnostics"', '"Dev inspection bridge"']) {
      expect(cards, `expected the ${card} card`).toContain(card);
    }
    // Components that render tiles are found wherever they live: a local one, an
    // imported helper, and the keybindings rows.
    for (const component of ['NotifyChannelRow', 'AgentExecutionFields', 'AgentLaunchOptionFields', 'HotkeyRow', 'OsHotkeyBanner', 'SortableActionItem', 'ActionRow', 'AgentRows', 'DictationModelStatus', 'CardSourceList']) {
      expect(tileComponents.has(component), `expected ${component} to be recognised as rendering tiles`).toBe(true);
    }
    const owners = descriptions.map((entry) => entry.owner);
    // A registry-sourced header, a literal header, a settingProps binding, an
    // inline row, a nested row, and an unavailable reason.
    expect(owners).toContain('memory.semanticEnabled');
    expect(owners).toContain('"Project defaults"');
    expect(descriptions.some((entry) => entry.text === registryDescriptions.get('mobileBridge.relayMode'))).toBe(true);
    expect(owners).toContain('browserAutomation.allowInteraction');
    expect(descriptions.find((entry) => entry.owner === 'browserAutomation.restrictNavigationToLocalhost')?.context).toBe('nested_row');
    expect(owners.some((owner) => owner.endsWith('(unavailable)'))).toBe(true);
  });

  it('flags a bare element in a card body and a description over budget', () => {
    const { violations, descriptions } = scanSnippet('bad.tsx', `
      export function Bad() {
        return (
          <SettingsCard icon={null} label="Bad" description="${'x'.repeat(61)}" checked={true} onChange={() => {}}>
            {on ? (
              <>
                <CardRow label="Fine" description="fine"><span /></CardRow>
                <div className="flex">custom</div>
              </>
            ) : null}
            {statusLine}
            {items.map((item) => <CardToggleRow key={item} label={item} description="d" checked onChange={() => {}} />)}
            {items.map((item) => <p key={item}>{item}</p>)}
          </SettingsCard>
        );
      }
    `);
    expect(violations.map((violation) => violation.found)).toEqual(['<div>', 'statusLine', '<p>']);
    expect(descriptions[0].text.length).toBeGreaterThan(DESCRIPTION_BUDGET[descriptions[0].context]);
  });

  it('accepts a component that renders only tiles, and rejects one that does not', () => {
    const { violations, tileComponents } = scanSnippet('components.tsx', `
      function GoodRows({ on }) {
        if (!on) return null;
        return (
          <>
            <CardRow label="A" description="a"><span /></CardRow>
            <CardTile className="flex">b</CardTile>
          </>
        );
      }
      function BadRow() {
        return <div className="row">loose</div>;
      }
      export function Host() {
        return (
          <SettingsCard icon={null} label="Host" description="ok">
            <GoodRows on />
            <BadRow />
          </SettingsCard>
        );
      }
    `);
    expect(tileComponents.has('GoodRows')).toBe(true);
    expect(tileComponents.has('BadRow')).toBe(false);
    expect(violations.map((violation) => violation.found)).toEqual(['<BadRow>']);
  });

  it('flags a CardTile that sets its own fill or padding', () => {
    const { violations } = scanSnippet('restyled.tsx', `
      export function Restyled() {
        return (
          <SettingsCard icon={null} label="Restyled" description="ok">
            <CardTile className="flex items-center gap-3">fine</CardTile>
            <CardTile className="flex bg-surface-inset px-2">darker well</CardTile>
          </SettingsCard>
        );
      }
    `);
    expect(violations.map((violation) => violation.found)).toEqual(['restyled tile: "flex bg-surface-inset px-2"']);
  });

  it('flags a tab that renders a loose row outside any card', () => {
    const { violations } = scanSnippet('tabs/LooseTab.tsx', `
      export function LooseTab() {
        return (
          <div className="space-y-4">
            <SettingsCard icon={null} label="Fine" description="ok"><CardTile>ok</CardTile></SettingsCard>
            <div className="loose-row">not in a card</div>
            {showConfirm && <ConfirmDialog />}
            {relocationDialog}
          </div>
        );
      }
    `, true);
    expect(violations.map((violation) => violation.where)).toEqual(['LooseTab top level']);
  });

  it('flags a short fixed dropdown, and leaves a longer, listed or marked one alone', () => {
    const { violations } = scanSnippet('choices.tsx', `
      export function Choices() {
        return (
          <SettingsCard icon={null} label="Choices" description="ok">
            <CardRow label="Two" description="d">
              <Select value="a" onChange={() => {}}>{/* a comment lists nothing */}<option value="a">A</option><option value="b">B</option></Select>
            </CardRow>
            <CardRow label="Four" description="d">
              <Select value="a" onChange={() => {}}><option value="a">A</option><option value="b">B</option><option value="c">C</option><option value="d">D</option></Select>
            </CardRow>
            <CardRow label="Five" description="d">
              <Select value="a" onChange={() => {}}><option value="a">A</option><option value="b">B</option><option value="c">C</option><option value="d">D</option><option value="e">E</option></Select>
            </CardRow>
            <CardRow label="Marked" description="d">
              {/* choice-select-ok: three phrase-length options do not fit. */}
              <Select value="a" onChange={() => {}}><option value="a">A</option><option value="b">B</option><option value="c">C</option></Select>
            </CardRow>
            <CardRow label="Empty marker" description="d">
              {/* choice-select-ok: */}
              <Select value="a" onChange={() => {}}><option value="a">A</option><option value="b">B</option><option value="c">C</option></Select>
            </CardRow>
            <CardRow label="Listed" description="d">
              <Select value="a" onChange={() => {}}><option value="">Auto</option>{shells.map((shell) => <option key={shell}>{shell}</option>)}</Select>
            </CardRow>
            <CardChoiceRow label="Segmented" description="d" options={[]} value="a" onChange={() => {}} />
          </SettingsCard>
        );
      }
    `);
    // Two, four and the empty marker (no reason) are flagged; five, marked and listed are not.
    expect(violations.map((violation) => violation.found)).toEqual(Array(3).fill('short fixed choice as a dropdown: use CardChoiceRow or SegmentedControl'));
  });

  it('lets a wideBody card hold its grid directly', () => {
    const { violations } = scanSnippet('wide.tsx', `
      export function Wide() {
        return (
          <SettingsCard icon={null} label="Wide" description="ok" wideBody>
            <div data-testid="grid" />
          </SettingsCard>
        );
      }
    `);
    expect(violations).toEqual([]);
  });
});

/**
 * Self-maintaining guard that every `ThemeMode` is actually reachable and actually
 * painted.
 *
 * `THEME_BACKGROUNDS`, `THEME_FOREGROUNDS` and `THEME_BASES` are each
 * `Record<ThemeMode, ...>`, so tsc already refuses a theme that skips them. Two
 * edges have no type to lean on, and both fail silently rather than loudly:
 *
 * 1. `src/renderer/index.css` needs a `.theme-<id>` block. Without one the class is
 *    added to <html>, matches no rule, and the theme renders as the `:root` dark
 *    palette. `dark` is the exception by design: it IS `:root`, and config-store
 *    deliberately adds no class for it.
 * 2. `demo/boot.js` carries `APP_THEMES`, a hand-maintained mirror of the union.
 *    A theme missing there makes `?theme=<id>` hit the web build's error card, which
 *    is how the site would discover it.
 *
 * Both lists are parsed out of their real files rather than re-declared here, so this
 * test cannot drift into agreeing with itself. The union is read with the TypeScript
 * compiler API, the same approach `mock-electron-api-parity.test.ts` uses.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';
import { THEME_BASES, NAMED_THEMES } from '../../src/shared/types';

const REPO_ROOT = path.resolve(__dirname, '../..');
const TYPES_PATH = path.join(REPO_ROOT, 'src/shared/types.ts');
const CSS_PATH = path.join(REPO_ROOT, 'src/renderer/index.css');
const DEMO_BOOT_PATH = path.join(REPO_ROOT, 'demo/boot.js');

/** `dark` is the no-class default: config-store skips the class, and :root IS its block. */
const CLASSLESS_THEME = 'dark';

/** Read the `ThemeMode` union from source, so the union is the input rather than an echo. */
function parseThemeModeUnion(): string[] {
  const source = ts.createSourceFile(
    TYPES_PATH,
    fs.readFileSync(TYPES_PATH, 'utf-8'),
    ts.ScriptTarget.Latest,
    true,
  );
  let members: string[] | null = null;
  source.forEachChild((node) => {
    if (!ts.isTypeAliasDeclaration(node) || node.name.text !== 'ThemeMode') return;
    if (!ts.isUnionTypeNode(node.type)) {
      throw new Error('ThemeMode is no longer a plain union; extend this parse rather than deleting it.');
    }
    members = node.type.types.map((member) => {
      if (!ts.isLiteralTypeNode(member) || !ts.isStringLiteral(member.literal)) {
        throw new Error('ThemeMode carries a non string-literal member; extend this parse.');
      }
      return member.literal.text;
    });
  });
  if (!members) throw new Error('ThemeMode not found in src/shared/types.ts');
  return members;
}

/** Every `.theme-<id>` selector index.css defines, including those in a grouped selector. */
function parseThemeClassesFromCss(): Set<string> {
  const css = fs.readFileSync(CSS_PATH, 'utf-8');
  return new Set(Array.from(css.matchAll(/\.theme-([a-z0-9-]+)/g), (match) => match[1]));
}

/** The APP_THEMES array literal in demo/boot.js, plus the alias map's targets. */
function parseDemoThemes(): { allowed: Set<string>; aliasTargets: string[] } {
  const boot = fs.readFileSync(DEMO_BOOT_PATH, 'utf-8');
  const listMatch = boot.match(/var APP_THEMES = \[([\s\S]*?)\]/);
  if (!listMatch) throw new Error('APP_THEMES not found in demo/boot.js');
  const allowed = new Set(Array.from(listMatch[1].matchAll(/'([a-z0-9-]+)'/g), (match) => match[1]));

  const aliasMatch = boot.match(/var THEME_ALIASES = \{([\s\S]*?)\}/);
  if (!aliasMatch) throw new Error('THEME_ALIASES not found in demo/boot.js');
  const aliasTargets = Array.from(aliasMatch[1].matchAll(/:\s*'([a-z0-9-]+)'/g), (match) => match[1]);
  return { allowed, aliasTargets };
}

describe('theme registry parity', () => {
  const themeModes = parseThemeModeUnion();

  it('parses a plausible union', () => {
    // Vacuity guard: a broken parse would otherwise pass every check below on an empty list.
    expect(themeModes.length).toBeGreaterThanOrEqual(10);
    expect(themeModes).toContain('dark');
    expect(themeModes).toContain('light');
  });

  it('answers the light-or-dark question for every theme, with no stale entries', () => {
    // The Record type already enforces this at compile time; the reverse direction is
    // the half tsc cannot see, and a stale key outlives the theme it described.
    expect(Object.keys(THEME_BASES).sort()).toEqual([...themeModes].sort());
  });

  it('paints every theme in index.css', () => {
    const classes = parseThemeClassesFromCss();
    const unpainted = themeModes.filter((theme) => theme !== CLASSLESS_THEME && !classes.has(theme));
    expect(unpainted, 'these themes would silently render as the :root dark palette').toEqual([]);
  });

  it('reaches every theme from the web build', () => {
    const { allowed, aliasTargets } = parseDemoThemes();
    const unreachable = themeModes.filter((theme) => !allowed.has(theme));
    expect(unreachable, 'these would hit the demo error card on ?theme=<id>').toEqual([]);
    // An alias pointing at a theme that no longer exists sends the site to the error card.
    for (const target of aliasTargets) {
      expect(themeModes, `THEME_ALIASES target ${target}`).toContain(target);
    }
  });

  it('lists only real themes in the settings dropdown', () => {
    // NAMED_THEMES is allowed to omit a theme (dark and light are hardcoded options),
    // but an entry naming a theme that does not exist renders a dead dropdown row.
    for (const named of NAMED_THEMES) {
      expect(themeModes, `NAMED_THEMES entry ${named.id}`).toContain(named.id);
    }
    const labels = NAMED_THEMES.map((named) => named.label);
    expect(new Set(labels).size, 'two dropdown entries share a label').toBe(labels.length);
  });
});

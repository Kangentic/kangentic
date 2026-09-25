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
 * 3. `NAMED_THEMES` is the Theme tab's picker list. A theme missing from it has no
 *    tile, and an array cannot be made total by the type system the way the Records
 *    are.
 * 4. `THEME_BACKGROUNDS` and `THEME_FOREGROUNDS` are a hex per theme copied from the
 *    CSS by hand (the launch background, the terminal's "match my app theme"
 *    preset). A palette tuned in index.css and not there drifts silently.
 *
 * Every list is parsed out of its real file rather than re-declared here, so this
 * test cannot drift into agreeing with itself. The union is read with the TypeScript
 * compiler API, the same approach `mock-electron-api-parity.test.ts` uses.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';
import { THEME_BACKGROUNDS, THEME_BASES, THEME_FOREGROUNDS, NAMED_THEMES } from '../../src/shared/types';

const REPO_ROOT = path.resolve(__dirname, '../..');
const TYPES_PATH = path.join(REPO_ROOT, 'src/shared/types.ts');
const CSS_PATH = path.join(REPO_ROOT, 'src/renderer/index.css');
const DEMO_BOOT_PATH = path.join(REPO_ROOT, 'demo/boot.js');

/**
 * `dark` is the no-class default for the <html> element: config-store skips the class,
 * and :root IS its block. The CSS check below exempts it anyway, though since the
 * Theme tab's tiles needed `.theme-dark` grouped onto that block (see the grouped
 * selector test) the exemption is vacuous there; it stays as a statement of intent
 * about the <html> class, which is what the check describes.
 */
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

/**
 * The value of `--kng-<token>` inside the block that paints `theme`. `dark` paints from
 * the `:root, .theme-dark` block, every other theme from its own `.theme-<id>` block.
 * The selector is matched at the start of a line so the `.theme-<id>` mentions inside
 * comments and grouped chart-token overrides are skipped.
 */
function cssToken(theme: string, token: string): string | undefined {
  const css = fs.readFileSync(CSS_PATH, 'utf-8');
  const selector = theme === CLASSLESS_THEME ? /^:root, \.theme-dark \{/m : new RegExp(`^\\.theme-${theme} \\{`, 'm');
  const blockStart = css.search(selector);
  if (blockStart < 0) return undefined;
  const block = css.slice(blockStart, css.indexOf('}', blockStart));
  return block.match(new RegExp(`--kng-${token}\\s*:\\s*(#[0-9a-fA-F]{6})`))?.[1];
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

  it('gives every theme exactly one tile in the Theme tab', () => {
    // The picker iterates NAMED_THEMES, so a theme missing here has no tile and cannot
    // be chosen, and an entry naming a theme that does not exist is a dead tile. The
    // array used to be allowed to omit dark and light (they were hardcoded dropdown
    // options); the grid has no such backstop.
    expect(NAMED_THEMES.map((named) => named.id).sort()).toEqual([...themeModes].sort());
    const labels = NAMED_THEMES.map((named) => named.label);
    expect(new Set(labels).size, 'two tiles share a label').toBe(labels.length);
  });

  it('keeps the dark palette reachable as a class, for the Dark tile inside a light app', () => {
    // A tile scopes itself to its theme by carrying `theme-<id>`; `dark` is `:root`
    // and has no class of its own unless the block is grouped. Tidying this back to a
    // bare `:root {` would paint the Dark tile in whatever theme the app is showing.
    const css = fs.readFileSync(CSS_PATH, 'utf-8');
    expect(css).toMatch(/^:root, \.theme-dark \{/m);
  });

  it('keeps the two hand-copied palettes in step with index.css', () => {
    // THEME_BACKGROUNDS mirrors --kng-surface (the BrowserWindow launch colour) and
    // THEME_FOREGROUNDS mirrors --kng-fg-secondary (the terminal's theme-match preset).
    const drift: string[] = [];
    for (const theme of themeModes) {
      const surface = cssToken(theme, 'surface');
      const foreground = cssToken(theme, 'fg-secondary');
      expect(surface, `${theme}: --kng-surface not found in its index.css block`).toBeDefined();
      expect(foreground, `${theme}: --kng-fg-secondary not found in its index.css block`).toBeDefined();
      const background = THEME_BACKGROUNDS[theme as keyof typeof THEME_BACKGROUNDS];
      const named = THEME_FOREGROUNDS[theme as keyof typeof THEME_FOREGROUNDS];
      if (background !== surface) drift.push(`${theme}: THEME_BACKGROUNDS ${background} vs --kng-surface ${surface}`);
      if (named !== foreground) drift.push(`${theme}: THEME_FOREGROUNDS ${named} vs --kng-fg-secondary ${foreground}`);
    }
    expect(drift).toEqual([]);
  });

  it('defines every token the Theme tab\'s swatch paints with, in every theme block', () => {
    // ThemeTile (ThemeTab.tsx) paints its swatch with bg-surface, bg-surface-raised,
    // border-edge, bg-fg, bg-fg-muted, and bg-accent inside the .theme-<id> scope. A block
    // that omits one of these silently inherits :root's dark value there, so a light tile
    // would paint one dark detail with no test going red.
    const swatchTokens = ['surface', 'surface-raised', 'edge', 'fg', 'fg-muted', 'accent'];
    const missing: string[] = [];
    for (const theme of themeModes) {
      for (const token of swatchTokens) {
        if (cssToken(theme, token) === undefined) missing.push(`${theme}: --kng-${token}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

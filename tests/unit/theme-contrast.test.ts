/**
 * Text/background contrast, checked against EVERY theme rather than the default.
 *
 * The bug this exists to prevent: a whole design pass was reasoned about using
 * the default zinc theme's token values, and the conclusions did not transfer.
 * `fg-muted` on `surface-hover` is 4.07:1 in zinc - marginal but arguable - and
 * 3.34:1 in forest, 3.58:1 in moon, 3.85:1 in ember. Each of the 10 themes
 * redefines BOTH the fg ramp and the surface ramp, so a ratio computed in one
 * says nothing about the others, and the failure is invisible unless you happen
 * to be running that theme.
 *
 * The rule it encodes: text a user must READ (a setting's title, its
 * description, a control's value) clears WCAG AA in every theme. Hint text that
 * is replaced by real content the moment the field is used (placeholders) is
 * exempt and listed explicitly, because it must stay dimmer than the value it
 * stands in for - if it matched, an empty field would be indistinguishable from
 * a filled one.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '../..');
const CSS = fs.readFileSync(path.join(REPO_ROOT, 'src/renderer/index.css'), 'utf-8');

const AA_NORMAL_TEXT = 4.5;

interface Theme {
  name: string;
  vars: Record<string, string>;
}

/** Every selector block that defines the `--kng-*` palette is one theme. */
function parseThemes(css: string): Theme[] {
  const themes: Theme[] = [];
  for (const block of css.matchAll(/(^|\})\s*([^{}]+?)\s*\{([^}]*--kng-[^}]*)\}/gms)) {
    const vars: Record<string, string> = {};
    for (const declaration of block[3].matchAll(/--kng-([a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})/g)) {
      vars[declaration[1]] = declaration[2];
    }
    // A theme block defines the full palette; partial blocks (a single
    // token override, an animation rule) are not themes.
    if (vars['fg'] && vars['surface-control'] && vars['surface-raised']) {
      // Selectors are multi-line with comments; the last line is the selector.
      const name = block[2].split('\n').map((line) => line.trim()).filter(Boolean).pop() ?? block[2];
      themes.push({ name, vars });
    }
  }
  return themes;
}

function channelLuminance(value: number): number {
  const srgb = value / 255;
  return srgb <= 0.04045 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
}

function relativeLuminance(hex: string): number {
  return 0.2126 * channelLuminance(parseInt(hex.slice(1, 3), 16))
    + 0.7152 * channelLuminance(parseInt(hex.slice(3, 5), 16))
    + 0.0722 * channelLuminance(parseInt(hex.slice(5, 7), 16));
}

export function contrastRatio(foreground: string, background: string): number {
  const first = relativeLuminance(foreground);
  const second = relativeLuminance(background);
  const lighter = Math.max(first, second);
  const darker = Math.min(first, second);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * The pairings the shared control surface actually produces. Keep this in step
 * with `SettingText.tsx`, `Field.tsx` (FIELD_CONTROL_BASE), and
 * `settings/shared.tsx` (INPUT_CLASS) when any of them changes a colour.
 */
const MUST_READ: { what: string; foreground: string; background: string }[] = [
  { what: 'setting title on a card', foreground: 'fg', background: 'surface-control' },
  { what: 'setting title on the panel', foreground: 'fg', background: 'surface-raised' },
  { what: 'setting description on a card', foreground: 'fg-tertiary', background: 'surface-control' },
  { what: 'setting description on the panel', foreground: 'fg-tertiary', background: 'surface-raised' },
  { what: 'control value', foreground: 'fg-tertiary', background: 'surface-control' },
];

describe('theme contrast (all themes, not just the default)', () => {
  const themes = parseThemes(CSS);

  it('parses every theme in index.css', () => {
    // Guards against the scan silently matching nothing and passing vacuously.
    expect(themes.length).toBeGreaterThanOrEqual(8);
    expect(themes.some((theme) => theme.name.includes(':root'))).toBe(true);
  });

  it('keeps must-read text at or above WCAG AA in every theme', () => {
    const failures: string[] = [];
    for (const theme of themes) {
      for (const pairing of MUST_READ) {
        const foreground = theme.vars[pairing.foreground];
        const background = theme.vars[pairing.background];
        if (!foreground || !background) continue;
        const ratio = contrastRatio(foreground, background);
        if (ratio < AA_NORMAL_TEXT) {
          failures.push(
            `${theme.name}: ${pairing.what} (${pairing.foreground} on ${pairing.background}) = ${ratio.toFixed(2)}:1`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it('keeps a placeholder dimmer than the value it stands in for', () => {
    // Placeholders are deliberately exempt from AA (they are transient hints,
    // and the field's own label carries the same information), but they must
    // stay clearly below the value or an empty field reads as a filled one.
    for (const theme of themes) {
      const placeholder = theme.vars['fg-muted'];
      const value = theme.vars['fg-tertiary'];
      const background = theme.vars['surface-control'];
      if (!placeholder || !value || !background) continue;
      expect(
        contrastRatio(placeholder, background),
        `${theme.name}: placeholder should be dimmer than the value`,
      ).toBeLessThan(contrastRatio(value, background));
    }
  });
});

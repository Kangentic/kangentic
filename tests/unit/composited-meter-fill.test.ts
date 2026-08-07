import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

// Guards the one way the composited progress-bar fills can regress SILENTLY.
//
// The context-usage fills (board card + monitor card via ContextUsageFooter, and the terminal
// ContextBar) draw a full-width bar and scale it with `transform: scaleX(p)` instead of setting
// `width: p%`. `transform` is composited; `width` is a layout property, so a width transition
// costs layout AND paint on every frame of its 300ms, on every surface with a running session.
//
// The trap: the CSS transition list is a SEPARATE string from the style that does the scaling.
// Leave a stale `transition-[width,...]` next to a `transform: scaleX()` and the bar still
// renders at exactly the right size - it just stops animating. Nothing else catches that.
// `getComputedStyle` assertions read the property list, not whether motion occurred, and the
// existing UI specs assert the fill's COUNT and COLOR, never its movement.
//
// So: wherever a fill is scaled, its transition list must name `transform`, and must not still
// name `width`.
//
// Deliberately NOT covered: bars that legitimately stay on `width`. RateLimitBar
// (ContextBar.tsx) keeps a `minWidth: 2px` floor, which has no scale-space equivalent without
// measuring the track, and it ticks minutes apart; the stats bars (BreakdownCard,
// PerProjectTable) have no transition at all, so there is nothing to composite. This scan only
// fires on an element that already opted into `scaleX`, so those are silent by construction
// rather than by allowlist.

const REPO_ROOT = path.resolve(__dirname, '../..');
const SCAN_DIR = 'src/renderer';
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx']);

/** How far back from a `scaleX(` to look for the className that owns it. Comfortably spans a
 *  multi-line JSX element without reaching the previous sibling. */
const CLASSNAME_LOOKBEHIND = 600;

function collectSourceFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectSourceFiles(fullPath));
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function toPosix(relativePath: string): string {
  return relativePath.replace(/\\/g, '/');
}

function lineNumberAt(text: string, index: number): number {
  let line = 1;
  for (let characterIndex = 0; characterIndex < index; characterIndex++) {
    if (text[characterIndex] === '\n') line++;
  }
  return line;
}

interface ScaledFill {
  location: string;
  transitionList: string | null;
  hasOriginLeft: boolean;
}

function findScaledFills(): ScaledFill[] {
  const found: ScaledFill[] = [];
  for (const filePath of collectSourceFiles(path.join(REPO_ROOT, SCAN_DIR))) {
    const source = fs.readFileSync(filePath, 'utf-8');
    const relative = toPosix(path.relative(REPO_ROOT, filePath));
    const scaleMatcher = /scaleX\(/g;
    let match: RegExpExecArray | null;
    while ((match = scaleMatcher.exec(source)) !== null) {
      const windowStart = Math.max(0, match.index - CLASSNAME_LOOKBEHIND);
      const preceding = source.slice(windowStart, match.index);
      // The className nearest above the scaling style is the one on the same element.
      const transitionMatches = [...preceding.matchAll(/transition-\[([^\]]*)\]/g)];
      const last = transitionMatches.at(-1);
      found.push({
        location: `${relative}:${lineNumberAt(source, match.index)}`,
        transitionList: last ? last[1] : null,
        hasOriginLeft: /\borigin-left\b/.test(preceding),
      });
    }
  }
  return found;
}

describe('composited meter fills', () => {
  it('finds the scaled fills, so the scan below cannot pass vacuously', () => {
    const fills = findScaledFills();
    // ContextUsageFooter (board + monitor cards) and the terminal ContextBar's context fill.
    expect(fills.length).toBeGreaterThanOrEqual(2);
    const files = new Set(fills.map((fill) => fill.location.split(':')[0]));
    expect(files).toContain('src/renderer/components/board/ContextUsageFooter.tsx');
    expect(files).toContain('src/renderer/components/terminal/ContextBar.tsx');
  });

  it('every scaled fill transitions `transform`, never a stale `width`', () => {
    const offenders = findScaledFills().filter(
      (fill) => fill.transitionList === null || !/\btransform\b/.test(fill.transitionList),
    );
    expect(
      offenders,
      'A fill scaled with transform: scaleX() whose transition list does not name `transform`. '
        + 'It will render at the correct size and silently stop animating. Offenders:\n'
        + offenders.map((offender) => `  ${offender.location} -> transition-[${offender.transitionList ?? 'MISSING'}]`).join('\n'),
    ).toEqual([]);
  });

  it('no scaled fill still names `width` in its transition list', () => {
    const offenders = findScaledFills().filter((fill) => fill.transitionList !== null && /\bwidth\b/.test(fill.transitionList));
    expect(
      offenders,
      'A scaled fill still transitions `width`, the layout property the scale was meant to '
        + 'replace. Offenders:\n'
        + offenders.map((offender) => `  ${offender.location} -> transition-[${offender.transitionList}]`).join('\n'),
    ).toEqual([]);
  });

  it('every scaled fill anchors its transform origin to the left edge', () => {
    // Without `origin-left` a scaled bar grows from its centre, which reads as a bar that
    // shrinks at both ends rather than a meter that fills.
    const offenders = findScaledFills().filter((fill) => !fill.hasOriginLeft);
    expect(
      offenders,
      'A fill scaled with scaleX() is missing `origin-left`, so it grows from its centre. '
        + 'Offenders:\n' + offenders.map((offender) => `  ${offender.location}`).join('\n'),
    ).toEqual([]);
  });

  it('no scaled fill pins a permanent will-change layer', () => {
    // A transform transition composites while it RUNS without any hint. A standing
    // `will-change: transform` would mint one persistent compositor layer per board card.
    const offenders: string[] = [];
    for (const filePath of collectSourceFiles(path.join(REPO_ROOT, SCAN_DIR))) {
      const source = fs.readFileSync(filePath, 'utf-8');
      const scaleMatcher = /scaleX\(/g;
      let match: RegExpExecArray | null;
      while ((match = scaleMatcher.exec(source)) !== null) {
        const preceding = source.slice(Math.max(0, match.index - CLASSNAME_LOOKBEHIND), match.index);
        if (/will-change/.test(preceding)) {
          offenders.push(`${toPosix(path.relative(REPO_ROOT, filePath))}:${lineNumberAt(source, match.index)}`);
        }
      }
    }
    expect(offenders, `will-change near a scaled fill:\n${offenders.join('\n')}`).toEqual([]);
  });
});

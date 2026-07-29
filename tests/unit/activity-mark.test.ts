import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { innerMarkup, ACTIVITY_MARK_NAMES } from '../../src/renderer/components/ActivityMark';

// ActivityMark renders a React-authored <svg> root and injects only the packaged file's INNER
// markup, so `innerMarkup` has to drop the shipped <svg> wrapper exactly. Its regex stops the
// opening tag at the first `>`, which is correct for these single-line generated files but would
// silently strip into the body if upstream ever emitted a `>` inside an attribute value. A
// "non-empty, contains no <svg" check passes on that partial strip, so every assertion below
// names the leaf content the app actually depends on.

const REPO_ROOT = path.resolve(__dirname, '../..');
const ACTIVITY_DIR = path.join(REPO_ROOT, 'node_modules', '@kangentic', 'branding', 'assets', 'activity');

function readMark(markName: string): string {
  return fs.readFileSync(path.join(ACTIVITY_DIR, `${markName}.svg`), 'utf-8');
}

describe('innerMarkup', () => {
  it('drops the packaged <svg> wrapper for every mark', () => {
    const leaked = ACTIVITY_MARK_NAMES.filter((markName) => {
      const inner = innerMarkup(readMark(markName));
      return inner.includes('<svg') || inner.includes('</svg>') || inner.trim() === '';
    });
    expect(
      leaked,
      `innerMarkup left an <svg> wrapper (or produced nothing) for:\n${leaked.join('\n')}`,
    ).toEqual([]);
  });

  it('keeps the marching group and its dash on the working marks', () => {
    // The march is a <g class="kng-march"> wrapper plus a pathLength-normalized dash. Losing
    // either leaves a working mark that renders but never animates.
    const broken = ACTIVITY_MARK_NAMES.filter((markName) => markName.endsWith('-working')).filter(
      (markName) => {
        const inner = innerMarkup(readMark(markName));
        return !inner.includes('class="kng-march"') || !inner.includes('stroke-dasharray');
      },
    );
    expect(broken, `working marks missing their march group or dash:\n${broken.join('\n')}`).toEqual([]);
  });

  it('keeps the control ring at r=10, which the size-20 call sites depend on', () => {
    // TaskDetailHeader and CommandTerminalWindow render these at size 20, where an r=10 ring
    // draws 20 * (2*10+2)/24 = 18.33px - a pixel match for the lucide Circle they replaced.
    // The radius already moved once (r=9 in branding 2.5.0, r=10 in 2.6.0) and this assertion
    // is what caught it, so keep it pinned: a silent radius change resizes both controls.
    const controlMarks = ACTIVITY_MARK_NAMES.filter((markName) => markName.startsWith('control-'));
    const wrongRadius = controlMarks.filter((markName) => !innerMarkup(readMark(markName)).includes('r="10"'));
    expect(
      wrongRadius,
      `control marks no longer draw an r=10 ring; the size={20} call sites in TaskDetailHeader and CommandTerminalWindow are stale - recompute size so that size * (2r+2)/24 stays 18.33px:\n${wrongRadius.join('\n')}`,
    ).toEqual([]);
  });

  it('keeps the agent ring at r=9, matching the lucide Loader2 it replaced', () => {
    // The indicator ring did NOT move when the controls went to r=10, which is what lets the
    // indicator call sites sit at 15 while the controls sit at 20. Pinned separately so the two
    // radii cannot silently converge and quietly resize the board card.
    expect(innerMarkup(readMark('agent-working'))).toContain('r="9"');
  });

  it('draws the needs-you envelope in landscape, not square', () => {
    // Branding 2.5.0 squared the envelope to 18x18 and it stopped reading as an envelope on the
    // board (it looked like a photo placeholder); 2.6.0 restored 18 x 14.4, a uniform 0.9 scale
    // of the reference Mail glyph. That single change fixes three things at once, which is why
    // the height is pinned here rather than left to the grid contract:
    //   1. aspect 1.25, the proportion people actually read as mail;
    //   2. the flap vertex angle, which scaling preserves - 2.5.0's square box had dragged it
    //      to 108.8 degrees against the 120.4 reference, a second defect on the same glyph;
    //   3. area parity with agent-working, which is the one that matters most on a task card.
    //
    // (3) is easy to miss: the card swaps idle for working IN PLACE, so what the eye judges is
    // apparent size, not outline length. The square envelope enclosed 321 units against the
    // ring's 254 (+26%), so an agent going idle made the indicator visibly grow. At 18 x 14.4
    // it encloses 256 (+0.5%) - the envelope is shorter, but a circle leaves its corners empty,
    // so the two land within half a percent. That parity falls out of the aspect fix; it holds
    // only while agent-working stays r=9, which the assertion above pins.
    const inner = innerMarkup(readMark('agent-idle'));
    expect(inner, 'agent-idle must stay 18 wide so it holds the indicator keyline').toContain('width="18"');
    expect(inner, 'agent-idle must stay 14.4 tall (aspect 1.25); 18 reads as a square photo icon').toContain('height="14.4"');
  });

  it('keeps the control glyph as a sibling of the marching group, not inside it', () => {
    // The pause bars / stop square must NOT march with the ring. They are siblings of the
    // <g class="kng-march"> in the packaged file; a strip that reordered or nested them would
    // set the whole glyph spinning.
    for (const markName of ['control-stop-working', 'control-pause-working']) {
      const inner = innerMarkup(readMark(markName));
      const marchEnd = inner.indexOf('</g>');
      expect(marchEnd, `${markName} has no closing </g> for its march group`).toBeGreaterThan(-1);
      expect(
        inner.slice(marchEnd).includes('fill="currentColor"'),
        `${markName} should carry its filled glyph AFTER the march group, so it does not animate`,
      ).toBe(true);
    }
  });

  it('keeps the terminal prompt paths the Command Terminal icon reads as a shell', () => {
    const inner = innerMarkup(readMark('terminal-working'));
    expect(inner).toContain('M7.5 9.5 L10.5 12 L7.5 14.5');
    expect(inner).toContain('M12.5 14.5 H16.5');
    expect(inner).toContain('stroke-dasharray="65 35"');
  });

  it('keeps the plus glyph on the new-terminal action mark', () => {
    const inner = innerMarkup(readMark('terminal-new'));
    expect(inner).toContain('M12 8.5 V15.5');
    expect(inner).toContain('M8.5 12 H15.5');
    // The action mark never marches: it represents a spawn, not a running terminal.
    expect(inner).not.toContain('kng-march');
  });
});

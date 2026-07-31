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

  it('keeps the needs-you envelope on the 18 x 16 box its edges are hinted to', () => {
    // Branding has reshaped this mark three times, so pin the box rather than trusting the grid
    // contract: 2.5.0 squared it to 18x18 (it read as a photo placeholder on a board card),
    // 2.6.0 restored 18 x 14.4 as a uniform 0.9 scale of the reference Mail glyph, and 2.7.1
    // moved it to 18 x 16 so its y edges sit on the integer lattice at 4 / 20.
    //
    // What 2.7.1 bought: stroke 2 on a 24 grid is fractional at every size in the 12-16
    // indicator band, so no coordinate puts both stroke edges on a pixel boundary - an integer
    // coordinate just lands closest. Measured upstream at devicePixelRatio 1, the ring and the
    // terminal chip both scored 1.92 softness (what any icon-library glyph on an 18 box scores)
    // while the envelope on y 4.8 / 19.2 was the single outlier at 1.95. The 20 x 16 glyph this
    // set replaced already sat on y 4 / 20; the 0.9 scale that restored the flap moved it off.
    //
    // What it cost, accepted upstream rather than argued away, and NOT to be "fixed" here:
    //   1. aspect drops from 1.25 to 1.125. The judgement that this reads squat beside the ring
    //      was outweighed, not overturned.
    //   2. enclosed area goes from +0.5% to +11.8% against agent-working's ring (284.6 units
    //      against 254). This is the legible one: a card swaps idle for working IN PLACE, so
    //      what the eye judges is apparent size, not outline length - at 18x18's +26% the
    //      indicator visibly grew on every state change. +11.8% was checked on a rendered
    //      idle/working swap strip before being accepted. The r=9 pin above is what keeps that
    //      measured figure meaningful; it is no longer a parity guarantee.
    //
    // The flap survives both moves intact at 120.4 degrees, because upstream pins a target
    // angle rather than flap ratios - ratios are fractions of the box, so they do not carry an
    // angle onto a box of a different aspect.
    const inner = innerMarkup(readMark('agent-idle'));
    expect(inner, 'agent-idle must stay 18 wide so it holds the indicator keyline').toContain('width="18"');
    expect(
      inner,
      'agent-idle must stay 16 tall: 18 x 16 puts its y edges on the integer lattice at 4 / 20, '
      + 'a deliberate hinting trade against aspect and area parity - do not restore 14.4',
    ).toContain('height="16"');
    // The box is only half the mark. 2.7.1 moved the flap too (2.7.0 drew M3 7.5 L12 12.6566
    // L21 7.5), and it is the flap that carries the 120.4 degree vertex the note above claims
    // survived: atan(9 / 5.1566) * 2, from the vertex out to each flap endpoint. Pinning the box
    // alone would pass a reshape that kept 18 x 16 and re-angled the flap, which is the one
    // defect 2.5.0 shipped. terminal-working and terminal-new pin their paths for the same
    // reason.
    expect(
      inner,
      'agent-idle flap moved: the vertex offset is what holds the 120.4 degree angle across a '
      + 'box change, so re-derive the angle before re-pinning this path',
    ).toContain('d="M3 7 L12 12.1566 L21 7"');
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

/**
 * The marching indicator must run smoothly for as long as an agent is working. It kept
 * visibly resetting, which read as the board freezing or choking.
 *
 * Two independent causes, each guarded below:
 *
 *  1. `TaskCard` rendered the idle and working marks as two SIBLING conditional slots.
 *     React reconciles unkeyed children positionally, so an idle/thinking flip was a
 *     delete at one index plus a create at the other - unmounting the <svg>, re-injecting
 *     `MARK_INNER`, and restarting the dash from zero.
 *  2. `.kng-march` lives on a node inside `dangerouslySetInnerHTML`, so it has no React
 *     fiber. Anything that rebuilds or merely MOVES that node (Chromium restarts CSS
 *     animations on detach/reattach) hands it a fresh animation starting at zero.
 *
 * (1) is fixed structurally. (2) cannot be, so the animation is anchored to the document
 * timeline, making its phase a pure function of time - a rebuilt node resumes where the
 * surviving ones are, and every mark marches in lockstep.
 *
 * The lucide spinner these replaced hid this for free: a rotating circle looks identical at
 * every phase. The dashed ring does not, which is why the restarts only became visible when
 * the marks landed.
 */
describe('marching indicator smoothness', () => {
  // Strip comments: both files deliberately DESCRIBE the retired two-slot shape so the next
  // reader knows why it changed, and a naive scan would match that prose and fail.
  const readSource = (relativePath: string): string =>
    fs.readFileSync(path.join(REPO_ROOT, relativePath), 'utf-8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');

  const activityCss = fs.readFileSync(path.join(ACTIVITY_DIR, 'activity.css'), 'utf-8');
  const taskCard = readSource('src/renderer/components/board/TaskCard.tsx');
  const activityMark = readSource('src/renderer/components/ActivityMark.tsx');

  it('the packaged march is an infinite linear loop', () => {
    // Timeline anchoring only makes sense for a loop with a constant period. A finite or
    // eased march would put anchored marks permanently out of phase with each other.
    const march = /\.kng-march\s*\{\s*animation:\s*kng-activity-march\s+(\d+)ms\s+linear\s+infinite/
      .exec(activityCss);
    expect(
      march,
      'upstream changed the .kng-march animation shorthand. It must stay `<duration>ms linear '
      + 'infinite` for document-timeline anchoring to keep every mark in phase.',
    ).not.toBeNull();
    expect(Number(march?.[1])).toBeGreaterThan(0);
  });

  it('reduced motion drops the animation entirely, so there is nothing to anchor', () => {
    // `anchorMarchToTimeline` relies on getAnimations() being empty here rather than on a
    // reduced-motion branch of its own.
    expect(activityCss).toMatch(/prefers-reduced-motion[\s\S]*\.kng-march[^}]*animation:\s*none/);
  });

  it('TaskCard renders the activity mark in ONE slot, not two conditional siblings', () => {
    const hasIdleSlot = /\{isIdle\s*&&\s*\(?\s*<ActivityMark/.test(taskCard);
    const hasThinkingSlot = /\{isThinking\s*&&\s*\(?\s*<ActivityMark/.test(taskCard);
    expect(
      hasIdleSlot || hasThinkingSlot,
      'TaskCard is back to per-state conditional <ActivityMark> slots. React reconciles them '
      + 'positionally, so every idle/thinking flip unmounts one and mounts the other, '
      + 'restarting the march from zero. Render one slot with a computed `mark` instead.',
    ).toBe(false);

    // Exactly one render site, and its mark is computed rather than literal.
    expect(taskCard.match(/<ActivityMark/g) ?? []).toHaveLength(1);
    expect(taskCard).toMatch(/mark=\{isThinking \? 'agent-working' : 'agent-idle'\}/);
  });

  it('ActivityMark anchors the march to the document timeline before paint', () => {
    expect(
      activityMark.includes('startTime = 0'),
      'ActivityMark no longer re-bases the march onto the document timeline. Without it a '
      + 'rebuilt or moved node starts its dash at zero and the indicator visibly resets.',
    ).toBe(true);

    // A layout effect, so the phase is corrected before the frame is painted; a plain effect
    // would show one frame of the reset.
    expect(activityMark).toMatch(/useLayoutEffect\(\(\) => \{\s*anchorMarchToTimeline/);

    // No dependency array: a DOM move or a re-injection can hand us a fresh animation
    // without `mark` changing, and the anchor is idempotent so running it is free.
    expect(activityMark).not.toMatch(/anchorMarchToTimeline\(markGroupRef\.current\);\s*\}, \[/);
  });
});

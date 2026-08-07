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

  it('gives every working mark a motion group', () => {
    // A working mark that renders but never animates is the failure this catches, and nothing
    // else would: `data-mark` is still right, the geometry is still right, it just sits there.
    const broken = ACTIVITY_MARK_NAMES.filter((markName) => markName.endsWith('-working')).filter(
      (markName) => !/class="kng-(spin|march|blink)"/.test(innerMarkup(readMark(markName))),
    );
    expect(broken, `working marks with no motion group:\n${broken.join('\n')}`).toEqual([]);
  });

  it('pins WHICH primitive each working mark uses, and pairs each with what it needs', () => {
    // The whole point of the 2026-08-07 change. Chromium can composite `transform` and `opacity`
    // and nothing else that matters here, so a `stroke-dashoffset` march stops producing frames
    // for exactly as long as this renderer's main thread is blocked. Measured in the shipping
    // runtime (Electron 41, Chromium 146) against a 4000ms block via CDP Page.startScreencast:
    // HTML rotation 349 distinct frames, SVG <g> rotation 355, dashoffset march 0.
    //
    // Geometry decides which primitive a mark can take, and it is a hard constraint rather than
    // a preference. To travel a dash along a perimeter, a transform has to map the shape onto
    // ITSELF while advancing arc length - that is the shape's symmetry group. A circle's is
    // continuous, so the three ROUND marks rotate and it is the same image the march produced
    // (pathLength 100 makes a dash shift of d exactly a rotation of d percent of 360 degrees;
    // verified by pixel diff across eight phases). A rounded square's symmetry group is DISCRETE
    // - four 90 degree rotations, nothing between - so the chip cannot travel a dash at all. Its
    // working state was redesigned instead: a solid outline with a blinking cursor.
    //
    // Each primitive needs a specific companion, which is why they are asserted together:
    // an outline primitive is invisible without a dash (a solid ring rotating shows nothing),
    // and the blink needs its own element to ride or the whole mark would flash.
    const primitive: Record<string, { motionClass: string; needs: RegExp; because: string }> = {
      'agent-working': { motionClass: 'kng-spin', needs: /stroke-dasharray/, because: 'a solid rotating ring shows no motion' },
      'control-pause-working': { motionClass: 'kng-spin', needs: /stroke-dasharray/, because: 'a solid rotating ring shows no motion' },
      'control-stop-working': { motionClass: 'kng-spin', needs: /stroke-dasharray/, because: 'a solid rotating ring shows no motion' },
      'terminal-working': {
        motionClass: 'kng-blink',
        // The blink wraps the WHOLE PROMPT and nothing else. Both bounds are load-bearing and
        // both have been wrong once or nearly so:
        //  - Too little. 2.8.0 blinked the prompt BAR alone, which is 4 units and draws 2.7px at
        //    the 16px sidebar size, against the 15.6px of perimeter the march it replaced put in
        //    motion. It was reported illegible immediately. The whole prompt is 11.8 units, 7.9px.
        //  - Too much. Wrapping the outline, or the whole mark, moves more ink but fades the glyph
        //    as a whole - and the app encodes state in TONE, `text-active` working against a muted
        //    rest. A whole-mark fade makes a working terminal periodically read as a resting one.
        needs: /<rect [^>]*\/><g class="kng-blink"><path d="M7\.5 9\.5 L10\.5 12 L7\.5 14\.5"\/><path d="M12\.5 14\.5 H16\.5"\/><\/g>$/,
        because:
          'the blink must ride the whole prompt and leave the outline solid - the bar alone is '
          + 'illegible at 16px, and including the outline fades the tone that carries the state',
      },
    };
    for (const [markName, { motionClass, needs, because }] of Object.entries(primitive)) {
      const inner = innerMarkup(readMark(markName));
      expect(
        inner,
        `${markName} should carry class="${motionClass}". A round mark on kng-march freezes under `
        + 'renderer jank; the chip on kng-spin tilts. Neither is a silent upstream call.',
      ).toContain(`class="${motionClass}"`);
      expect(inner, `${markName}: ${because}`).toMatch(needs);
    }
  });

  it('leaves the terminal chip outline solid, with no dash to freeze', () => {
    // The chip's dash is gone entirely, which is what makes `static` the right rest strategy for
    // it now: `drop-dash` existed because a STOPPED 65/35 ring reads as broken, and there is no
    // longer a dash to stop. A dash left behind here would render as a permanently broken chip,
    // since nothing animates the outline any more.
    const inner = innerMarkup(readMark('terminal-working'));
    expect(inner, 'the working chip outline must be solid').not.toContain('stroke-dasharray');
    expect(inner).toContain('<rect x="3" y="3" width="18" height="18" rx="3" pathLength="100"/>');
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

  it('keeps the control glyph as a sibling of the motion group, not inside it', () => {
    // The pause bars / stop square must NOT animate with the ring. They are siblings of the
    // <g class="kng-spin"> in the packaged file; a strip that reordered or nested them would
    // set the whole glyph moving.
    //
    // This got sharper when the controls moved from march to spin. Nesting them under a MARCHING
    // group was invisible (a dashoffset only affects a dashed stroke, and these are filled), so
    // the assertion was pure insurance. Nesting them under a ROTATING group visibly turns the
    // pause bars and the stop square. It is now the thing that stands between a correct mark and
    // an obviously broken one.
    for (const markName of ['control-stop-working', 'control-pause-working']) {
      const inner = innerMarkup(readMark(markName));
      const motionEnd = inner.indexOf('</g>');
      expect(motionEnd, `${markName} has no closing </g> for its motion group`).toBeGreaterThan(-1);
      expect(
        inner.slice(motionEnd).includes('fill="currentColor"'),
        `${markName} should carry its filled glyph AFTER the motion group, or the pause bars / `
        + 'stop square rotate with the ring',
      ).toBe(true);
    }
  });

  it('keeps the terminal prompt paths the Command Terminal icon reads as a shell', () => {
    // Both terminal states carry both prompt paths. The working mark splitting the bar into its
    // own <g> is what the blink rides; it must not lose or move either path in the process,
    // because the chevron plus bar IS what makes this glyph read as a shell rather than a box.
    for (const markName of ['terminal-idle', 'terminal-working']) {
      const inner = innerMarkup(readMark(markName));
      expect(inner, `${markName} lost its prompt chevron`).toContain('M7.5 9.5 L10.5 12 L7.5 14.5');
      expect(inner, `${markName} lost its prompt bar`).toContain('M12.5 14.5 H16.5');
    }
  });

  it('keeps the plus glyph on the new-terminal action mark', () => {
    const inner = innerMarkup(readMark('terminal-new'));
    expect(inner).toContain('M12 8.5 V15.5');
    expect(inner).toContain('M8.5 12 H15.5');
    // The action mark never animates: it represents a spawn, not a running terminal. Checked
    // against EVERY primitive, not just the retired march - `terminal-new` does not end in
    // `-working`, so the motion-group sweep above never reaches it, and a march-only guard would
    // wave through an upstream release that attached `.kng-spin` or `.kng-blink` to it.
    expect(inner).not.toMatch(/kng-(march|spin|blink)/);
  });
});

/**
 * The activity indicator must run smoothly for as long as an agent is working. Three
 * independent defects have broken that, and all three are guarded below. The first two are
 * RESTARTS (the mark jumps back to phase zero); the third is a STALL (the mark stops
 * producing frames). They look identical to the eye and have nothing in common mechanically,
 * which is why diagnosing one as the other wasted a pass.
 *
 *  1. `TaskCard` rendered the idle and working marks as two SIBLING conditional slots.
 *     React reconciles unkeyed children positionally, so an idle/thinking flip was a
 *     delete at one index plus a create at the other - unmounting the <svg>, re-injecting
 *     `MARK_INNER`, and restarting from zero.
 *  2. The motion class lives on a node inside `dangerouslySetInnerHTML`, so it has no React
 *     fiber. Anything that rebuilds or merely MOVES that node (Chromium restarts CSS
 *     animations on detach/reattach) hands it a fresh animation starting at zero.
 *  3. `stroke-dashoffset` is a paint property, so Chromium cannot composite it. A marching
 *     mark stops dead for exactly as long as the renderer's main thread is blocked, and the
 *     desktop measured 194 such stalls in 3.6 hours, worst 703ms.
 *
 * (1) is fixed structurally. (2) cannot be, so the animation is anchored to the document
 * timeline, making its phase a pure function of time - a rebuilt node resumes where the
 * surviving ones are, and every mark moves in lockstep. (3) is fixed upstream by putting every
 * working mark on a composited property: `transform` where the geometry allows a rotation,
 * `opacity` where it does not. See the primitive pin above.
 *
 * Note that (3)'s fix does NOT retire (2)'s: the set rotates a DASHED arc, so a restarted
 * rotation snaps its gap back to 12 o'clock just as visibly as a restarted march did, and a
 * restarted blink can land the cursor mid-off. Only the solid lucide spinner these replaced was
 * phase-invariant, which is why the restarts became legible when the marks landed.
 */
describe('activity indicator smoothness', () => {
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

  it('every packaged primitive is an infinite linear loop of the SAME period', () => {
    // Timeline anchoring only makes sense for a loop with a constant period. A finite or
    // eased animation would put anchored marks permanently out of phase with each other.
    const durationOf = (motionClass: string, keyframes: string): number => {
      const shorthand = new RegExp(
        `\\.${motionClass}\\s*\\{\\s*animation:\\s*${keyframes}\\s+(\\d+)ms\\s+linear\\s+infinite`,
      ).exec(activityCss);
      expect(
        shorthand,
        `upstream changed the .${motionClass} animation shorthand. It must stay `
        + '`<duration>ms linear infinite` for document-timeline anchoring to keep every mark in phase.',
      ).not.toBeNull();
      return Number(shorthand?.[1]);
    };
    const periods = {
      march: durationOf('kng-march', 'kng-activity-march'),
      spin: durationOf('kng-spin', 'kng-activity-spin'),
      blink: durationOf('kng-blink', 'kng-activity-blink'),
    };
    expect(periods.march).toBeGreaterThan(0);
    // The periods must MATCH across all three. A rotating agent ring and a blinking Command
    // Terminal chip sit in the SAME sidebar row, and anchoring both to the document timeline
    // only reads as deliberate if they share a period; different periods drift them apart into
    // N independent indicators. It is also what made the march-to-spin swap a pure performance
    // change rather than a visible speed change on the marks that moved.
    expect(
      [periods.spin, periods.blink],
      'a primitive period diverged. All are anchored to the document timeline, so a mismatch '
      + 'drifts a rotating ring out of lockstep with the blinking chip beside it.',
    ).toEqual([periods.march, periods.march]);
  });

  it('the cursor blink is a cursor, not a fade', () => {
    // The ramps are short on purpose: a slow sinusoidal fade reads as "pulsing/attention", the
    // vocabulary animate-pulse-subtle already owns elsewhere in the app, rather than as a shell
    // cursor. And the off state is 0.06 rather than 0, because at the 12px indicator floor a
    // fully absent bar reads as a mark that has lost a piece.
    expect(
      activityCss,
      'the blink keyframes were reshaped. Ramps longer than a few percent of the period turn the '
      + 'cursor into a pulse, and a 0 trough reads as a mark missing a piece at the 12px floor.',
    ).toContain('@keyframes kng-activity-blink { 0%, 44% { opacity: 1; } 50%, 94% { opacity: 0.06; } 100% { opacity: 1; } }');
  });

  it('the rotation resolves its origin in viewBox units, not the arc bbox', () => {
    // A dashed arc's own bbox is not the circle's centre, so a percentage or fill-box origin
    // would wobble the ring instead of spinning it. `transform-box: view-box` is the CSS
    // initial value, but it is written out upstream precisely so this does not depend on a
    // UA default.
    expect(activityCss).toMatch(/\.kng-spin[^}]*transform-origin:\s*12px 12px/);
    expect(activityCss).toMatch(/\.kng-spin[^}]*transform-box:\s*view-box/);
  });

  it('reduced motion drops EVERY animation, so there is nothing to anchor', () => {
    // `anchorMarkMotionToTimeline` relies on getAnimations() being empty here rather than on a
    // reduced-motion branch of its own. The rule must name every class: each time a primitive
    // was added, a rule naming only the previous ones would have left the newest marks moving
    // for a user who asked for no motion, silently and only for that user.
    const reduced = /@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/.exec(activityCss);
    expect(reduced, 'the packaged CSS lost its prefers-reduced-motion block').not.toBeNull();
    for (const motionClass of ['kng-march', 'kng-spin', 'kng-blink']) {
      expect(reduced?.[1], `reduced motion does not silence .${motionClass}`)
        .toMatch(new RegExp(`\\.${motionClass}[^}]*animation:\\s*none`));
    }
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

  it('ActivityMark anchors mark motion to the document timeline before paint', () => {
    expect(
      activityMark.includes('startTime = 0'),
      'ActivityMark no longer re-bases mark motion onto the document timeline. Without it a '
      + 'rebuilt or moved node starts at phase zero and the indicator visibly resets.',
    ).toBe(true);

    // A layout effect, so the phase is corrected before the frame is painted; a plain effect
    // would show one frame of the reset.
    expect(activityMark).toMatch(/useLayoutEffect\(\(\) => \{\s*anchorMarkMotionToTimeline/);

    // No dependency array: a DOM move or a re-injection can hand us a fresh animation
    // without `mark` changing, and the anchor is idempotent so running it is free.
    expect(activityMark).not.toMatch(/anchorMarkMotionToTimeline\(markGroupRef\.current\);\s*\}, \[/);
  });

  it('the anchor selector covers BOTH motion classes', () => {
    // The regression this pins actually happened in review: the selector was
    // `querySelector('.kng-march')`, so the moment upstream moved the round marks to
    // `.kng-spin` they stopped being anchored - and because the set rotates a DASHED arc, that
    // reintroduces the visible restart this whole describe block exists to prevent, on exactly
    // the marks the composite fix was meant to help. Silent, and indistinguishable by eye from
    // the stall being fixed.
    for (const motionClass of ['.kng-march', '.kng-spin', '.kng-blink']) {
      expect(
        activityMark,
        `ActivityMark's motion selector no longer covers ${motionClass}, so those marks lose `
        + 'their timeline anchor and visibly restart on any DOM move.',
      ).toContain(motionClass);
    }
    // querySelectorAll, not querySelector: a mark can only carry one primitive today, but a
    // single-element query silently anchors the first match and leaves any sibling adrift.
    expect(activityMark).toMatch(/querySelectorAll\(MOTION_SELECTOR\)/);
  });

  it('the Monitor Active tile freezes BOTH primitives at zero, importantly', () => {
    // The one consumer-side motion override in the codebase, and it has to clear two separate
    // bars. It must name BOTH classes, because it named only `.kng-march` and so matched nothing
    // once `agent-working` moved to `.kng-spin`. And each must be `!important`: `ActivityMark`
    // imports the packaged CSS straight from node_modules, so `.kng-spin` arrives UNLAYERED and
    // outranks any Tailwind utility (those compile into `@layer utilities`) at every specificity.
    // Dropping the `!` does not weaken the override, it deletes it.
    //
    // This is a SOURCE SCAN, so it cannot see a lost cascade at all: an override that wins
    // nothing still reads perfectly correct here. The real guard is the rendered red-green pair
    // in tests/ui/agent-monitor.spec.ts; this only pins the shape so the two cannot drift.
    const summaryCards = readSource('src/renderer/components/monitor/MonitorSummaryCards.tsx');
    for (const motionClass of ['kng-march', 'kng-spin']) {
      expect(
        summaryCards,
        `the Active tile's zero-state freeze no longer covers .${motionClass} with !important`,
      ).toContain(`[&_.${motionClass}]:[animation:none]!`);
    }
  });
});

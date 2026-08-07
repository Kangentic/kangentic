import React from 'react';
import '@kangentic/branding/assets/activity/activity.css';
import activityJson from '@kangentic/branding/assets/activity/activity.json';
import agentIdleSvg from '@kangentic/branding/assets/activity/agent-idle.svg?raw';
import agentWorkingSvg from '@kangentic/branding/assets/activity/agent-working.svg?raw';
import controlPauseIdleSvg from '@kangentic/branding/assets/activity/control-pause-idle.svg?raw';
import controlPauseWorkingSvg from '@kangentic/branding/assets/activity/control-pause-working.svg?raw';
import controlStopIdleSvg from '@kangentic/branding/assets/activity/control-stop-idle.svg?raw';
import controlStopWorkingSvg from '@kangentic/branding/assets/activity/control-stop-working.svg?raw';
import terminalIdleSvg from '@kangentic/branding/assets/activity/terminal-idle.svg?raw';
import terminalNewSvg from '@kangentic/branding/assets/activity/terminal-new.svg?raw';
import terminalWorkingSvg from '@kangentic/branding/assets/activity/terminal-working.svg?raw';

/**
 * The activity marks, owned upstream in `@kangentic/branding` (`assets/activity/`) and shared
 * with the website and the mobile app. Nine marks over five silhouettes (`activity.json` counts
 * `control-pause` and `control-stop` separately) on one 24 grid at stroke 2, `currentColor` only.
 *
 * Motion is composited, always, because Chromium can only composite `transform` and `opacity` and
 * a non-composited animation stops producing frames for exactly as long as THIS renderer's main
 * thread is blocked - which is what made the indicators visibly hitch. Two primitives ship, and
 * which one a mark gets is decided by its geometry:
 *
 *  - `.kng-spin` (a `transform`) on the ROUND working marks, riding a `pathLength`-normalized
 *    dash on the outline. On a circle a rotation and a marching dash are the same image, so this
 *    was a free swap.
 *  - `.kng-blink` (an `opacity`) on the terminal chip's PROMPT, outline held solid. A rounded rect
 *    has only a DISCRETE symmetry group, so no transform can travel a dash around it, and the
 *    chip's working state was redesigned rather than left stalling. Which element blinks is a
 *    legibility decision settled at the 16px sidebar size, not at review size: branding 2.8.0
 *    blinked the 4-unit prompt BAR alone, which draws 2.7px there and was reported illegible
 *    immediately. Blinking the outline too would move more ink but fade the tone that carries
 *    working-vs-resting, so the outline stays at full strength.
 *
 * `.kng-march` (the original `stroke-dashoffset`) still ships in the packaged CSS but no mark
 * uses it. Upstream holds every primitive to one period so marks stay in lockstep in a shared row.
 *
 * The grid is a WIDTH KEYLINE, not a square ink box: every mark fills its slot's width and
 * takes whatever height its form actually needs. Two keylines, one per role - 18 for
 * indicators, 20 for controls. Width is what has to match, because icons in a row behave like
 * glyphs in a line of type: width is the advance and shifts everything after it, while height
 * is absorbed by `align-items: center`. Branding 2.5.0 briefly read the grid as a literal
 * 18x18 ink box, squared the envelope to fit, and it stopped reading as an envelope on a task
 * card; 2.6.0 reframed it to this model.
 *
 * A deliberate inline-SVG exception to the lucide-only icon convention (`ui-conventions.md`),
 * and the third in that chain after `BrandMark.tsx` and `command-bar/CommandTerminalIcon.tsx`
 * (which is now a wrapper over this): no lucide glyph carries a dashed activity border, and
 * these marks must stay byte-identical across three surfaces. The `?raw` sources are trusted
 * build-time package assets.
 *
 * Tone is the CALLER's job. The marks paint in `currentColor`, so a call site applies
 * `text-active` / `text-attention` / `text-fg-muted` exactly as it did to the lucide glyph it
 * replaced. Never hardcode a hex here: `--kng-active` / `--kng-attention` are desktop-only
 * values and mobile/web deliberately differ.
 *
 * There is no `-rest` mark on purpose. Upstream ships rest as the `-idle` GEOMETRY in a muted
 * tone, so a rest twin cannot drift from its idle counterpart.
 */
export const ACTIVITY_MARK_NAMES = [
  'agent-idle',
  'agent-working',
  'terminal-idle',
  'terminal-working',
  'terminal-new',
  'control-pause-idle',
  'control-pause-working',
  'control-stop-idle',
  'control-stop-working',
] as const;

export type ActivityMarkName = (typeof ACTIVITY_MARK_NAMES)[number];

const RAW_MARKS: Record<ActivityMarkName, string> = {
  'agent-idle': agentIdleSvg,
  'agent-working': agentWorkingSvg,
  'terminal-idle': terminalIdleSvg,
  'terminal-working': terminalWorkingSvg,
  'terminal-new': terminalNewSvg,
  'control-pause-idle': controlPauseIdleSvg,
  'control-pause-working': controlPauseWorkingSvg,
  'control-stop-idle': controlStopIdleSvg,
  'control-stop-working': controlStopWorkingSvg,
};

interface ActivityMarkMeta {
  file: string;
  /** Reduced-motion strategy, NOT a tone: 'static' | 'keep-dash' | 'drop-dash'. */
  reducedMotion: string;
  minPx: number;
}

/**
 * The shipped contract, re-declared so the wide inferred JSON type is not indexed directly.
 *
 * `marks` is PARTIAL on purpose. This is package data crossing the TypeScript boundary, so a
 * total `Record` would be a claim the type system cannot check: a branding release that drops or
 * renames a mark still typechecks, and `CONTRACT.marks[mark].reducedMotion` would then throw
 * mid-render. `TaskCard` renders a mark per board card and nothing above it catches, so that
 * throw takes the whole renderer down rather than blanking one icon.
 * `tests/unit/branding-assets.test.ts` fails CI on that drift; the `?? 'static'` below is the
 * runtime floor for anyone running against a package the test never saw.
 */
interface ActivityContract {
  marks: Partial<Record<ActivityMarkName, ActivityMarkMeta>>;
}

const CONTRACT = activityJson as unknown as ActivityContract;

/**
 * Drops the packaged file's own `<svg>` wrapper so React can own the root element.
 *
 * Exported for `tests/unit/activity-mark.test.ts`, which asserts per mark that the expected
 * leaf content survived. "Non-empty" is not a sufficient check: `[^>]*` stops at the first
 * `>`, which is correct for these single-line generated files but would silently strip into
 * the body if upstream ever emitted a `>` inside an attribute value.
 */
export function innerMarkup(raw: string): string {
  return raw.replace(/^[\s\S]*?<svg\b[^>]*>/, '').replace(/<\/svg>\s*$/, '');
}

const MARK_INNER: Record<ActivityMarkName, string> = Object.fromEntries(
  ACTIVITY_MARK_NAMES.map((name) => [name, innerMarkup(RAW_MARKS[name])]),
) as Record<ActivityMarkName, string>;

/**
 * Every class the packaged set uses to carry motion. ALL THREE must be listed.
 *
 * None of the three is phase-invariant, so every one of them needs the anchor:
 * the set rotates a 75/25 DASHED arc, so a restart snaps its gap back to 12
 * o'clock exactly as visibly as a restarted march did, and a restarted blink can
 * land the cursor mid-off. (The lucide spinner these replaced was
 * phase-invariant because it was one solid arc, which is why the restarts only
 * became legible when the marks landed.) A selector that named only the classes
 * in use at the time would silently un-anchor whatever upstream moved next -
 * which is exactly what happened when the round marks went from march to spin.
 * `.kng-march` is currently unused by the shipped set and is listed anyway.
 */
const MOTION_SELECTOR = '.kng-march, .kng-spin, .kng-blink';

/**
 * Anchor every animated mark to the document timeline so the animation's phase is a
 * pure function of time rather than of when its DOM node happened to be created.
 *
 * The motion lives on a node inside `dangerouslySetInnerHTML`, so it has no React
 * fiber: anything that rebuilds or re-inserts that node gives it a brand-new
 * animation starting at zero, and the 75/25 dashed ring snaps its gap back to 12
 * o'clock. That is highly legible - it reads as the indicator freezing or choking.
 *
 * Setting `startTime = 0` re-bases the animation onto the document timeline origin,
 * making its phase `documentTime % period` for EVERY mark. Two consequences, both
 * wanted: a rebuilt node resumes exactly where the surviving ones are (so a restart
 * is undetectable), and all marks on screen move in lockstep, which reads as
 * deliberate rather than as N independent spinners. Upstream deliberately holds
 * every primitive to the same period so a rotating agent ring and a blinking
 * terminal chip stay in lockstep in the same sidebar row.
 *
 * Idempotent by construction - re-applying always computes the same anchor - so it
 * is safe to run on any render.
 */
function anchorMarkMotionToTimeline(host: SVGGElement | null): void {
  if (!host) return;
  for (const animated of host.querySelectorAll(MOTION_SELECTOR)) {
    // `getAnimations` is unavailable in jsdom and absent under reduced motion (the
    // packaged CSS drops the animation entirely), where there is nothing to anchor.
    if (typeof animated.getAnimations !== 'function') continue;
    for (const animation of animated.getAnimations()) {
      // Only write on drift: assigning startTime unconditionally on every render
      // would be a needless style mutation on every card, every frame.
      if (animation.startTime !== 0) animation.startTime = 0;
    }
  }
}

export interface ActivityMarkProps extends React.SVGProps<SVGSVGElement> {
  mark: ActivityMarkName;
  /** Rendered width and height in px. Floors: 12 for indicators, 16 for controls. */
  size?: number;
}

/**
 * Renders one activity mark.
 *
 * The `<svg>` root is authored HERE and only the mark's INNER markup is injected, into a `<g>`.
 * That shape is load-bearing and must not be "simplified" into `BrandMark`'s wrapper-`<span>` +
 * `dangerouslySetInnerHTML` form:
 *
 *  1. React forbids `children` alongside `dangerouslySetInnerHTML` on the same element, and
 *     `TaskCard` passes a `<title>` child for its native hover tooltip. On a sibling `<g>`,
 *     children stay free.
 *  2. The packaged files carry a hardcoded `width="24" height="24"`; a React-authored root
 *     overrides them directly instead of needing a `[&>svg]:h-full` neutralisation wrapper.
 *  3. A wrapper `<span>` carrying the tone class would break the sidebar specs, which assert
 *     that `span.text-active` / `span.text-attention` resolve to the count digits alone.
 *
 * The extra `<g>` is harmless to the packaged CSS: every motion rule is a class selector and the
 * reduced-motion dash rule is `svg[data-rest="drop-dash"] *`, so all of them still match one level
 * deeper. It is also harmless to compositing: the animated element is the packaged inner `<g>`,
 * and an extra static ancestor does not stop Blink from promoting it.
 */
export function ActivityMark({
  mark,
  size = 24,
  strokeWidth = 2,
  children,
  ...rest
}: ActivityMarkProps): React.ReactNode {
  // Decorative by default; a call site that names the mark (aria-label) or supplies a <title>
  // child is exposing it to assistive tech, so it must not also be aria-hidden.
  const isLabelled = rest['aria-label'] !== undefined || children !== undefined;

  const markGroupRef = React.useRef<SVGGElement>(null);
  // Layout effect, not an effect: this runs after React has injected the markup but
  // BEFORE paint, so a rebuilt node is already in phase on the frame it appears and
  // the reset is never shown. No dependency array on purpose - a DOM move or a
  // re-injection can hand us a fresh animation without changing `mark`, and
  // `anchorMarkMotionToTimeline` no-ops when the anchor is already correct.
  React.useLayoutEffect(() => {
    anchorMarkMotionToTimeline(markGroupRef.current);
  });

  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
      data-mark={mark}
      data-rest={CONTRACT.marks[mark]?.reducedMotion ?? 'static'}
      role={isLabelled ? 'img' : undefined}
      aria-hidden={isLabelled ? undefined : true}
    >
      <g ref={markGroupRef} dangerouslySetInnerHTML={{ __html: MARK_INNER[mark] }} />
      {children}
    </svg>
  );
}

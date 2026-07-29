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
 * `control-pause` and `control-stop` separately) on one 24 grid at stroke 2, `currentColor` only,
 * motion via a marching `stroke-dashoffset`.
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
 * (which is now a wrapper over this): no lucide glyph carries a marching activity border, and
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
 * The extra `<g>` is harmless to the packaged CSS: `.kng-march` is a class selector and the
 * reduced-motion rule is `svg[data-rest="drop-dash"] *`, so both still match one level deeper.
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
      <g dangerouslySetInnerHTML={{ __html: MARK_INNER[mark] }} />
      {children}
    </svg>
  );
}

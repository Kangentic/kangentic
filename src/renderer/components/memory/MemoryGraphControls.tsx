/**
 * The Memory Graph's left panel: what is on the map, how it is divided, how it
 * is drawn, and what is in the index.
 *
 * FOUR cards in one stack, in the order a question is scoped: Filter (Projects,
 * then time and status), Regions (Detail, then the list it recuts), Display
 * (Color by, Show), then Index. The first three are open by default because they
 * are what you touch; Index is closed because it is reference you consult, and
 * it opens to the side. Filter comes first because it is also the scope a
 * question is asked in, and the time and status rows used to sit inside Display,
 * where they read as drawing options rather than scope.
 *
 * The gap between cards is deliberate, and so is how SMALL it is. This started
 * as two floating panels pinned to the top and bottom of the left edge with a
 * screen-height void between them, which read as two unrelated things; pulling
 * them into one continuous slab then went too far the other way. A small gap
 * states the seam without scattering the panel.
 *
 * The old horizontal strip this replaced put counts, a view switch, a colour
 * switch, two raw checkboxes and a filter in one undifferentiated row, which
 * produced four concrete misreadings: the group labels looked like options,
 * "Links" was both a count and a toggle forty pixels apart, "Depth" was a colour
 * mode meaning conversation length sitting next to a 3D view, and "36
 * unconnected" was a filter that looked like a statistic. Hence labelled groups,
 * shared controls instead of raw checkboxes, "Depth" renamed to "Length", the
 * count moved away from the toggle, and the filter stated as a filter.
 *
 * EXPLANATORY TEXT LIVES IN HINTS, not in the layout. A description under a
 * control reflows the whole panel when the selection changes (each colour mode's
 * sentence is a different length), and prose sitting inside a control group reads
 * as part of the control rather than as help.
 */

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { ChevronDown, ChevronRight, Database, Filter, Search, Shapes, SlidersHorizontal, X } from 'lucide-react';
import { SegmentedControl } from '../SegmentedControl';
import { OverlayPopover } from '../OverlayPopover';
import { Select } from '../settings/shared';
import type { MemoryGraphColorMode } from './MemoryGraphCanvas';
import { clusterHue } from './memory-graph-scene';
import type {
  MemoryCoverageSummary,
  MemoryGraphGranularity,
  MemoryIndexCorpus,
  MemoryIndexCorpusSummary,
  MemoryIndexSummary,
} from '../../../shared/types';
import { PanelRow, InfoHint, formatBytes } from './PanelRow';

/** How far back a conversation's last activity may be. */
export type MemoryGraphTimeWindow = 'any' | '7d' | '30d' | '90d';

export const TIME_WINDOW_DAYS: Readonly<Record<Exclude<MemoryGraphTimeWindow, 'any'>, number>> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

/**
 * The facets the map can be scoped by.
 *
 * These are the SAME dimensions the colour modes encode, which is the point:
 * before this you could colour by Outcome and see that some work was abandoned,
 * but you could not scope the map to it. Anything the map can show you, it can
 * now show you only.
 *
 * They INTERSECT with each other and with search rather than replacing it, so
 * "pairing" + Abandoned is abandoned pairing work, not one or the other.
 */
export interface MemoryGraphFacets {
  /**
   * Regions switched OFF, by cluster index.
   *
   * Stored as the exclusions rather than the inclusions so the default is the
   * empty set, which means "everything". Storing the inclusions would require
   * knowing how many regions exist before the projection has loaded, and would
   * silently hide a new region the next build discovers.
   *
   * This replaced a single-select "All regions / one region" dropdown, which
   * could only ever answer "just this one". The regions ARE the map's domains,
   * so comparing two of them, or hiding one noisy area, is the natural thing to
   * want and the dropdown could express neither.
   */
  hiddenRegions: ReadonlySet<number>;
  since: MemoryGraphTimeWindow;
  outcome: 'any' | MemoryGraphOutcome;
}

export const EMPTY_FACETS: MemoryGraphFacets = {
  hiddenRegions: new Set<number>(),
  since: 'any',
  outcome: 'any',
};

/** True when nothing is scoped, so callers can skip the intersection entirely. */
export function facetsAreEmpty(facets: MemoryGraphFacets): boolean {
  return facets.hiddenRegions.size === 0 && facets.since === 'any' && facets.outcome === 'any';
}

/**
 * Which facet rows have anything to offer on THIS corpus.
 *
 * A control that can only ever return the same set is worse than no control.
 * Time is the
 * subtle one: if every conversation is inside the narrowest window then all
 * three windows and "Any time" select identically, so the row is dead even
 * though the timestamps exist.
 */
export interface FacetAvailability {
  since: boolean;
  /**
   * The outcomes actually present, in display order - not a boolean.
   *
   * On a real board archiving happens after Done essentially always, so
   * "Abandoned" (archived without ever reaching Done) matches nothing and would
   * sit there as a permanently empty choice. Offering only what exists makes
   * that self-correcting rather than a judgement about one board: the option
   * appears on a board where work really does get dropped, and the row itself
   * disappears when fewer than two outcomes remain.
   */
  outcomes: ReadonlyArray<MemoryGraphOutcome>;
}

export type MemoryGraphOutcome = 'done' | 'active' | 'abandoned';

/**
 * Phrased as what HAPPENED, not as a lane name: these read beside each other in
 * a list, where a bare "Done" next to "Active" reads as a column picker rather
 * than a history.
 *
 * They were "Reached Done" / "Still on the board" / "Abandoned", which got the
 * intent right and the words wrong: a clause, a clause and an adjective, with a
 * column name inside the first. These are three plain states of the same kind,
 * and no lane is named. The internal values keep the word `outcome` - the code's
 * vocabulary and the reader's do not have to be the same word, and renaming the
 * wire field would cost a projection rebuild to change a label.
 */
export const OUTCOME_LABELS: Readonly<Record<MemoryGraphOutcome, string>> = {
  done: 'Finished',
  active: 'Still open',
  // "Dropped" rather than "Archived" because archiving is how a FINISHED task
  // leaves the board, so it is not the opposite of finishing - dropping is.
  abandoned: 'Dropped',
};

/** Display order, independent of whatever order the corpus happened to yield. */
export const OUTCOME_ORDER: ReadonlyArray<MemoryGraphOutcome> = ['done', 'active', 'abandoned'];

export const NO_FACETS_AVAILABLE: FacetAvailability = { since: false, outcomes: [] };

/**
 * Every colour mode, in display order. What is OFFERED is filtered from this by
 * `availableColorModes`, so a mode this index cannot express never appears.
 *
 * One word each, deliberately. "Conversation length" was the odd one out in a
 * list of single words, and the qualifier turned out to be unnecessary once
 * Duration and Cost sat beside it: three magnitudes in a row disambiguate each
 * other far better than a longer name does, and the hint carries the rest.
 *
 * The three are not three readings of one thing, which was measured rather than
 * assumed on the real 648-conversation corpus: length to duration 0.507, length
 * to cost 0.560, duration to cost 0.664.
 */
const COLOR_OPTIONS: ReadonlyArray<{ value: MemoryGraphColorMode; label: string; hint: string }> = [
  { value: 'cluster', label: 'Topic', hint: 'Color by the region of the map each conversation sits in' },
  { value: 'recency', label: 'Recency', hint: 'Warm is recent, cool is old - shows where your attention has moved' },
  { value: 'outcome', label: 'Outcome', hint: 'Green finished, amber still open, grey dropped without finishing' },
  {
    value: 'size',
    label: 'Length',
    hint: 'How much transcript the conversation holds: warm and bright is long, deep indigo is short. This is text, not time or money - a long conversation is often a cheap one',
  },
  {
    value: 'duration',
    label: 'Duration',
    hint: 'How long the conversation ran for in wall time: warm and bright is slow, deep indigo is quick. A brief conversation can still be a slow one',
  },
  {
    value: 'cost',
    label: 'Cost',
    hint: 'What the conversation cost to run: warm and bright is expensive, deep indigo is cheap. Conversations with no recorded cost draw at the cheap end',
  },
];

/** Keyed rather than listed, so the rendered set is driven by what the corpus
 *  can actually express while the copy stays in one place. */
const GRANULARITY_OPTIONS: Record<
  MemoryGraphGranularity,
  { value: MemoryGraphGranularity; label: string; title: string }
> = {
  coarse: { value: 'coarse', label: 'Coarse', title: 'Fewer, broader regions' },
  balanced: {
    value: 'balanced',
    label: 'Balanced',
    title: 'The default: regions of roughly 10 to 26 conversations',
  },
  fine: { value: 'fine', label: 'Fine', title: 'More, narrower regions' },
};

/**
 * Regions above which the list gets a filter field.
 *
 * A control that can only ever do nothing is not rendered - the rule this
 * surface already follows for the dead facet rows and the Detail chips - and a
 * text box over four rows is exactly that. The number comes from the eight real
 * project indexes measured in Round 26: the seven small ones top out at EIGHT
 * regions across all three granularities, and the 646-conversation one starts at
 * TWENTY-TWO. Anything in 9..21 therefore hides on every small project and shows
 * on the large one; 12 sits in the middle of that gap rather than on either edge.
 */
const REGION_FILTER_MIN = 12;

/** Case-insensitive substring, on the label the row actually shows. */
function regionMatches(label: string, query: string): boolean {
  return label.toLowerCase().includes(query.trim().toLowerCase());
}

export interface MemoryGraphControlsProps {
  colorMode: MemoryGraphColorMode;
  onColorModeChange: (mode: MemoryGraphColorMode) => void;
  /** Only the modes this index can express - see `availableColorModes`. A mode
   *  that would paint every node the same is not offered. */
  availableColorModes: ReadonlyArray<MemoryGraphColorMode>;
  showLabels: boolean;
  onShowLabelsChange: (show: boolean) => void;
  showTitles: boolean;
  onShowTitlesChange: (show: boolean) => void;
  showEdges: boolean;
  onShowEdgesChange: (show: boolean) => void;
  facets: MemoryGraphFacets;
  onFacetsChange: (facets: MemoryGraphFacets) => void;
  /** Rows with nothing to offer on this corpus are not rendered at all. */
  facetAvailability: FacetAvailability;
  /** One entry per region, in cluster order, for the Regions section. `group`
   *  names the project a region belongs to when the map holds several; the list
   *  groups under it. */
  regions: ReadonlyArray<{ id: number; label: string; count: number; group?: string }>;
  granularity: MemoryGraphGranularity;
  /** Only those that cut the map differently - see `availableGranularities`. */
  availableGranularities: MemoryGraphGranularity[];
  onGranularityChange: (granularity: MemoryGraphGranularity) => void;
  coverage: MemoryCoverageSummary;
  /** Every corpus the index holds, and its size on disk. */
  index: MemoryIndexSummary;
  semanticAvailable: boolean;
  edgeCount: number;
  building: boolean;
  /** The Projects picker, rendered at the top of Filter. Absent when fewer than
   *  two projects have an index, since a one-option scope is a dead control. */
  projectsPicker?: ReactNode;
}

/**
 * One region, as a toggle.
 *
 * The whole row is the control rather than a separate checkbox, because the
 * swatch and the name are what the eye is aiming at anyway. Off is expressed by
 * draining the row rather than by hiding it - the region still exists, and a
 * list that reflowed as you toggled would be much harder to work through.
 */
function RegionRow({
  label,
  count,
  hue,
  on,
  onToggle,
}: {
  label: string;
  count: number;
  hue: number;
  on: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      role="switch"
      aria-checked={on}
      className={`flex w-full items-center gap-2 rounded px-1.5 py-1 text-left transition-colors cursor-pointer hover:bg-surface-hover ${on ? '' : 'opacity-45'}`}
      data-testid="memory-graph-region-row"
      data-region-on={on}
      title={on ? `Hide ${label}` : `Show ${label}`}
    >
      <span
        className="h-2.5 w-2.5 flex-shrink-0 rounded-full border"
        style={{
          backgroundColor: on ? `hsl(${hue} 68% 62%)` : 'transparent',
          borderColor: `hsl(${hue} 68% 62%)`,
        }}
        aria-hidden
      />
      <span className="min-w-0 flex-1 truncate text-[11px] text-fg">{label}</span>
      <span className="flex-shrink-0 text-[11px] tabular-nums text-fg-faint">{count}</span>
    </button>
  );
}

function GroupLabel({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
      <span>{children}</span>
      {hint ? <InfoHint text={hint} /> : null}
    </div>
  );
}

/** The Index section's rows are all counts, so they format and align as numbers.
 *  The shape itself is shared with the detail panel (`PanelRow`). */
function IndexRow({
  label,
  value,
  tone = 'neutral',
  hint,
}: {
  label: string;
  value: number | string;
  tone?: 'neutral' | 'ok' | 'problem';
  hint?: string;
}) {
  return (
    <PanelRow
      label={label}
      value={typeof value === 'number' ? value.toLocaleString() : value}
      tone={tone}
      hint={hint}
      numeric
    />
  );
}

/** How the Index panel names each corpus, and what its row's hint says. */
const CORPUS_ROWS: Record<MemoryIndexCorpus, { label: string; hint: string }> = {
  conversation: {
    label: 'Conversations',
    hint: 'Agent conversations indexed for the projects on the map. These are what the map draws.',
  },
  task: {
    label: 'Task records',
    hint: 'Each task and backlog item: its title, labels and description. Searched when you ask, never drawn.',
  },
  change: {
    label: 'Session changes',
    hint: 'The files each session changed, read from its conversation. Kept as text, never drawn.',
  },
};

/** A corpus row's value: its document count, and while it is still embedding,
 *  how much of it is. A corpus with nothing in it says so rather than 0. */
function corpusValue(entry: MemoryIndexCorpusSummary, semanticAvailable: boolean): string {
  if (entry.documents === 0) return 'Not yet indexed';
  const count = entry.documents.toLocaleString();
  if (!entry.embeds || !semanticAvailable || entry.chunks === 0 || entry.embeddedChunks >= entry.chunks) return count;
  return `${count}, ${Math.floor((entry.embeddedChunks / entry.chunks) * 100)}% embedded`;
}

function SectionHeader({
  icon,
  label,
  collapsed,
  onToggle,
  testId,
  /** Where the section's body appears. A `side` header keeps its chevron
   *  pointing at the flyout rather than rotating down onto content that is not
   *  underneath it. */
  opens = 'down',
}: {
  icon: React.ReactNode;
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  testId: string;
  opens?: 'down' | 'side';
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-2 px-3 py-2 text-xs font-semibold text-fg-secondary hover:text-fg transition-colors cursor-pointer"
      aria-expanded={!collapsed}
      data-testid={testId}
    >
      {icon}
      <span className="flex-1 text-left">{label}</span>
      {opens === 'side' ? (
        <ChevronRight size={13} aria-hidden />
      ) : (
        <ChevronDown
          size={13}
          aria-hidden
          className={`transition-transform ${collapsed ? '-rotate-90' : ''}`}
        />
      )}
    </button>
  );
}

/** Card chrome shared by the panel's four sections. No `overflow` here:
 *  nothing inside a card may clip. */
const CARD_SURFACE_CLASS = 'rounded-lg border border-edge bg-surface-raised/80 backdrop-blur-md shadow-xl';
const CARD_CLASS = `flex-shrink-0 ${CARD_SURFACE_CLASS}`;
/**
 * The Regions card over a long list. It is the one card that gives way: it
 * takes the height the others leave and its list scrolls, so the panel itself
 * does not, and Index stays in view at the bottom. It keeps about three rows,
 * below which the list stops being one; only a window too short for even that
 * lets the panel scroll.
 */
const REGIONS_FLEX_CARD_CLASS = `flex min-h-[15rem] flex-col ${CARD_SURFACE_CLASS}`;

/** Air kept between the Index flyout and the viewport's bottom edge, which
 *  clears the app's status bar showing through beneath this surface. */
const FLYOUT_VIEWPORT_PADDING = 40;

export function MemoryGraphControls({
  colorMode,
  onColorModeChange,
  availableColorModes,
  showLabels,
  onShowLabelsChange,
  showTitles,
  onShowTitlesChange,
  showEdges,
  onShowEdgesChange,
  facets,
  onFacetsChange,
  facetAvailability,
  regions,
  granularity,
  availableGranularities,
  onGranularityChange,
  coverage,
  index,
  semanticAvailable,
  edgeCount,
  building,
  projectsPicker,
}: MemoryGraphControlsProps) {
  // Open by default: these three are controls the user acts on.
  const [filterCollapsed, setFilterCollapsed] = useState(false);
  const [regionsCollapsed, setRegionsCollapsed] = useState(false);
  const [displayCollapsed, setDisplayCollapsed] = useState(false);
  // Closed by default: the numbers are reference, not a control.
  const [indexCollapsed, setIndexCollapsed] = useState(true);
  // Every corpus, not just what the map draws: the Index panel accounts for
  // the whole store.
  const totalChunks = index.corpora.reduce((total, entry) => total + entry.chunks, 0);
  // The embedded share is of what gets embedded: a text-only corpus would
  // otherwise hold it below 100% forever.
  const embeddableChunks = index.corpora.reduce((total, entry) => total + (entry.embeds ? entry.chunks : 0), 0);
  const totalEmbedded = index.corpora.reduce((total, entry) => total + entry.embeddedChunks, 0);
  const [regionQuery, setRegionQuery] = useState('');

  /**
   * Index opens to the SIDE, not downward, and outside the panel.
   *
   * To the side because it is the last card in a column whose middle is a list
   * of every region the index holds, forty on a large project, so a section
   * opening downward ran off the bottom of the window. Outside the panel because
   * the panel scrolls as a whole in a short window, and a scrolling box clips
   * anything positioned inside it. It is portaled to the body and placed beside
   * its header, pushed up to stay clear of the bottom edge.
   */
  const indexTriggerRef = useRef<HTMLDivElement>(null);
  const indexPopoverRef = useRef<HTMLDivElement>(null);
  const [indexFlyoutPosition, setIndexFlyoutPosition] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    if (indexCollapsed) return;
    const trigger = indexTriggerRef.current;
    const popover = indexPopoverRef.current;
    if (!trigger || !popover) return;
    const triggerBox = trigger.getBoundingClientRect();
    const height = popover.offsetHeight;
    const lowest = window.innerHeight - FLYOUT_VIEWPORT_PADDING - height;
    setIndexFlyoutPosition({
      left: triggerBox.right + 8,
      top: Math.max(8, Math.min(triggerBox.top, lowest)),
    });
  }, [indexCollapsed]);
  useEffect(() => {
    if (indexCollapsed) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (indexPopoverRef.current?.contains(target)) return;
      // The header is the toggle, so let its own handler close it rather than
      // closing here and reopening on the same click.
      if (indexTriggerRef.current?.contains(target)) return;
      setIndexCollapsed(true);
    };
    document.addEventListener('mousedown', closeOnOutsideClick, true);
    return () => document.removeEventListener('mousedown', closeOnOutsideClick, true);
  }, [indexCollapsed]);

  const shownRegionCount = regions.filter((region) => !facets.hiddenRegions.has(region.id)).length;
  const regionFilterable = regions.length >= REGION_FILTER_MIN;
  const listedRegions = useMemo(
    () => (regionFilterable && regionQuery.trim() !== ''
      ? regions.filter((region) => regionMatches(region.label, regionQuery))
      : regions),
    [regions, regionQuery, regionFilterable],
  );
  // Grouped by project only when the map holds more than one.
  const regionGroups = useMemo(() => {
    const groups: Array<{ name: string | null; regions: Array<(typeof listedRegions)[number]> }> = [];
    for (const region of listedRegions) {
      const name = region.group ?? null;
      const last = groups[groups.length - 1];
      if (last && last.name === name) last.regions.push(region);
      else groups.push({ name, regions: [region] });
    }
    return groups;
  }, [listedRegions]);
  const grouped = regionGroups.some((group) => group.name !== null) && regionGroups.length > 1;

  const anyFacetAvailable = facetAvailability.since || facetAvailability.outcomes.length > 1;
  const showFilter = projectsPicker != null || anyFacetAvailable;
  const showRegionList = regions.length > 1;
  const showDetail = availableGranularities.length > 1;

  const toggleRegion = (regionId: number): void => {
    const next = new Set(facets.hiddenRegions);
    if (next.has(regionId)) next.delete(regionId);
    else next.add(regionId);
    onFacetsChange({ ...facets, hiddenRegions: next });
  };

  return (
    // Capped at the height it is given. A long region list scrolls inside its
    // card rather than the panel scrolling; the panel scrolls only when even
    // the other cards fill it (measured: under about 890 px of window, and at
    // the 900x600 floor Filter, Display and Index alone need 510 of its 450).
    // Four cards, in the order a question is scoped: what is on the map, how it
    // is divided, how it is drawn, then reference.
    <div
      className="pointer-events-auto flex max-h-full w-64 flex-col gap-3 overflow-y-auto"
      data-testid="memory-graph-controls"
    >
      {showFilter ? (
        <div className={CARD_CLASS} data-testid="memory-graph-filter-card">
          <SectionHeader
            icon={<Filter size={13} aria-hidden />}
            label="Filter"
            collapsed={filterCollapsed}
            onToggle={() => setFilterCollapsed((current) => !current)}
            testId="memory-graph-filter-toggle"
          />
          {!filterCollapsed ? (
            // The scope of the map, and of any question asked of it.
            <div className="space-y-3 px-3 pb-3">
              {projectsPicker != null ? (
                <div>
                  <GroupLabel hint="Which projects the map shows and a question is asked across. Starts on the open project.">
                    Projects
                  </GroupLabel>
                  {projectsPicker}
                </div>
              ) : null}
              {anyFacetAvailable ? (
                // A STACK of rows rather than one control, because these are
                // independent questions. Each option is written to be
                // self-describing ("Last 30 days", not "30d"), so the rows need no
                // labels of their own and the panel stays narrow.
                <div className="space-y-1.5">
                  {facetAvailability.since ? (
                    <Select
                      value={facets.since}
                      onChange={(event) =>
                        onFacetsChange({ ...facets, since: event.target.value as MemoryGraphTimeWindow })
                      }
                      aria-label="Filter by when the conversation was last active"
                      data-testid="memory-graph-filter-since"
                    >
                      <option value="any">Any time</option>
                      <option value="7d">Last 7 days</option>
                      <option value="30d">Last 30 days</option>
                      <option value="90d">Last 90 days</option>
                    </Select>
                  ) : null}

                  {facetAvailability.outcomes.length > 1 ? (
                    <Select
                      value={facets.outcome}
                      onChange={(event) =>
                        onFacetsChange({
                          ...facets,
                          outcome: event.target.value as MemoryGraphFacets['outcome'],
                        })
                      }
                      aria-label="Filter by the task's status"
                      data-testid="memory-graph-filter-outcome"
                    >
                      {/* "Any status", not "Any outcome": one of the values is
                          "Still open", which is not an outcome at all - it is
                          the absence of one. */}
                      <option value="any">Any status</option>
                      {facetAvailability.outcomes.map((outcome) => (
                        <option key={outcome} value={outcome}>{OUTCOME_LABELS[outcome]}</option>
                      ))}
                    </Select>
                  ) : null}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {showRegionList || showDetail ? (
        <div
          className={showRegionList && regionFilterable && !regionsCollapsed ? REGIONS_FLEX_CARD_CLASS : CARD_CLASS}
          data-testid="memory-graph-regions-card"
        >
          <SectionHeader
            icon={<Shapes size={13} aria-hidden />}
            label="Regions"
            collapsed={regionsCollapsed}
            onToggle={() => setRegionsCollapsed((current) => !current)}
            testId="memory-graph-regions-toggle"
          />
          {!regionsCollapsed ? (
            <div className="flex min-h-0 flex-1 flex-col px-3 pb-3">
              {/* Detail sits directly above the list it recuts. Only the
                  granularities that produce a DIFFERENT map: on a small index
                  every band clamps to the same region count, so the other chips
                  would repaint the identical picture. */}
              {showDetail ? (
                <div className={`shrink-0 ${showRegionList ? 'mb-3' : ''}`}>
                  <GroupLabel hint="How finely the map is cut into regions. Each one is computed with the map, so switching is instant. No measurement can pick this for you: every way of scoring a clustering prefers the fewest regions on a cloud this continuous, so it is a question of how much detail you want to read.">
                    Detail
                  </GroupLabel>
                  <SegmentedControl
                    options={availableGranularities.map((value) => GRANULARITY_OPTIONS[value])}
                    value={granularity}
                    onChange={onGranularityChange}
                    ariaLabel="Region detail"
                    testId="memory-graph-granularity"
                    fullWidth
                  />
                </div>
              ) : null}

              {showRegionList ? (
                <>
                  {/* The map's domains, each independently switchable. All on by
                      default: the map means the whole index until the user says
                      otherwise. */}
                  <div className="mb-1.5 flex shrink-0 items-center justify-between">
                    <span className="text-[11px] text-fg-muted">
                      {shownRegionCount} of {regions.length} shown
                    </span>
                    <div className="flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => onFacetsChange({ ...facets, hiddenRegions: new Set() })}
                        disabled={facets.hiddenRegions.size === 0}
                        className="rounded px-1.5 py-0.5 text-[11px] text-fg-muted hover:bg-surface-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent cursor-pointer disabled:cursor-default"
                        data-testid="memory-graph-regions-all"
                      >
                        All
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          onFacetsChange({ ...facets, hiddenRegions: new Set(regions.map((region) => region.id)) })
                        }
                        disabled={shownRegionCount === 0}
                        className="rounded px-1.5 py-0.5 text-[11px] text-fg-muted hover:bg-surface-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent cursor-pointer disabled:cursor-default"
                        data-testid="memory-graph-regions-none"
                      >
                        None
                      </button>
                    </div>
                  </div>
                  {/* Narrows the LIST, never the map. All and None stay scoped to
                      every region, which is what the "N of M shown" line above
                      them names; re-scoping them off a text box would be a hidden
                      mode, and hiding regions the user cannot see is the one
                      mistake this list can make. */}
                  {regionFilterable ? (
                    <div className="relative mb-1.5 shrink-0">
                      <Search
                        size={12}
                        className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg-muted"
                        aria-hidden
                      />
                      <input
                        value={regionQuery}
                        onChange={(event) => setRegionQuery(event.target.value)}
                        placeholder="Find a region"
                        aria-label="Find a region"
                        data-testid="memory-graph-region-filter"
                        className="w-full rounded border border-edge/60 bg-surface-control/60 py-1 pl-7 pr-6 text-[11px] text-fg placeholder:text-fg-muted outline-none focus:border-edge-input"
                      />
                      {regionQuery ? (
                        <button
                          type="button"
                          onClick={() => setRegionQuery('')}
                          className="absolute right-1 top-1/2 -translate-y-1/2 rounded p-0.5 text-fg-muted hover:bg-surface-hover hover:text-fg cursor-pointer"
                          aria-label="Clear region filter"
                          data-testid="memory-graph-region-filter-clear"
                        >
                          <X size={12} />
                        </button>
                      ) : null}
                    </div>
                  ) : null}
                  {/* The one scroller in the panel: the region count reaches
                      forty on a large index, so the list takes the height the
                      other cards leave. The count and the bulk actions stay
                      OUTSIDE it, since they are how you recover from a long
                      list rather than part of it. */}
                  <div className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-0.5" data-testid="memory-graph-region-list">
                    {listedRegions.length === 0 ? (
                      <p
                        className="px-1.5 py-2 text-[11px] text-fg-muted"
                        data-testid="memory-graph-region-filter-empty"
                      >
                        No region matches that.
                      </p>
                    ) : regionGroups.map((group) => (
                      <div key={group.name ?? 'regions'}>
                        {grouped && group.name ? (
                          <div
                            className="px-1.5 pb-0.5 pt-2 text-[11px] font-semibold uppercase tracking-wide text-fg-muted"
                            data-testid="memory-graph-region-group"
                          >
                            {group.name}
                          </div>
                        ) : null}
                        {group.regions.map((region) => (
                          <RegionRow
                            key={region.id}
                            label={region.label}
                            count={region.count}
                            hue={clusterHue(region.id)}
                            on={!facets.hiddenRegions.has(region.id)}
                            onToggle={() => toggleRegion(region.id)}
                          />
                        ))}
                      </div>
                    ))}
                  </div>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className={CARD_CLASS}>
        <SectionHeader
          icon={<SlidersHorizontal size={13} aria-hidden />}
          label="Display"
          collapsed={displayCollapsed}
          onToggle={() => setDisplayCollapsed((current) => !current)}
          testId="memory-graph-controls-toggle"
        />

        {!displayCollapsed ? (
          <div className="space-y-3 px-3 pb-3">
            <div>
              <GroupLabel hint={COLOR_OPTIONS.find((option) => option.value === colorMode)?.hint}>
                Color by
              </GroupLabel>
              {/* A Select, not a SegmentedControl: four labels overflowed the
                  panel at every width tried, cutting the last option in half. */}
              <Select
                value={colorMode}
                onChange={(event) => onColorModeChange(event.target.value as MemoryGraphColorMode)}
                aria-label="Color conversations by"
                data-testid="memory-graph-color-mode"
              >
                {/* Only the modes this corpus can actually express. An option
                    that paints every node identically is a dead control. */}
                {COLOR_OPTIONS.filter(
                  (option) => availableColorModes.includes(option.value),
                ).map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </Select>
            </div>

            <div>
              <GroupLabel>Show</GroupLabel>
              <div className="space-y-1.5">
                {/* "Regions", not "Labels": there are two kinds of label on this
                    map, and the generic word stopped saying which one this row
                    governs. */}
                <SegmentedControl
                  options={[
                    { value: 'on', label: 'Regions' },
                    { value: 'off', label: 'Hidden' },
                  ]}
                  value={showLabels ? 'on' : 'off'}
                  onChange={(value) => onShowLabelsChange(value === 'on')}
                  ariaLabel="Region labels"
                  testId="memory-graph-toggle-labels"
                  fullWidth
                />
                {/* On by default. Titles are the map's main source of context
                    clues, so this is an OFF switch for a map the user finds busy,
                    not an opt-in they have to find. */}
                <SegmentedControl
                  options={[
                    { value: 'on', label: 'Titles' },
                    { value: 'off', label: 'Hidden' },
                  ]}
                  value={showTitles ? 'on' : 'off'}
                  onChange={(value) => onShowTitlesChange(value === 'on')}
                  ariaLabel="Conversation titles"
                  testId="memory-graph-toggle-titles"
                  fullWidth
                />
                <SegmentedControl
                  options={[
                    { value: 'on', label: 'Links' },
                    { value: 'off', label: 'Hidden' },
                  ]}
                  value={showEdges ? 'on' : 'off'}
                  onChange={(value) => onShowEdgesChange(value === 'on')}
                  ariaLabel="Similarity links"
                  testId="memory-graph-toggle-edges"
                  fullWidth
                />
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <div ref={indexTriggerRef} className={CARD_CLASS}>
        <SectionHeader
          icon={<Database size={13} aria-hidden />}
          label="Index"
          collapsed={indexCollapsed}
          onToggle={() => setIndexCollapsed((current) => !current)}
          testId="memory-graph-index-toggle"
          opens="side"
        />
      </div>
      <OverlayPopover
        open={!indexCollapsed}
        popoverRef={indexPopoverRef}
        portal
        style={indexFlyoutPosition
          ? { left: indexFlyoutPosition.left, top: indexFlyoutPosition.top }
          // Measured before it is placed, so the first frame is invisible.
          : { left: 0, top: 0, visibility: 'hidden' }}
        transformOrigin="left top"
        className="fixed z-[2147483646] w-64 rounded-lg border border-edge bg-surface-raised/95 backdrop-blur-md shadow-xl"
        data-testid="memory-graph-index-panel"
      >
        <div className="px-3 py-3">
          {/* A definition list, not the coverage STRIP: aligned label and value
              rows are what a narrow column of reference numbers wants. */}
          <dl className="divide-y divide-edge/60" data-testid="memory-graph-index-rows">
            {/* One row per corpus the index holds, conversations first. A
                corpus not indexed yet says so rather than showing a zero. */}
            {index.corpora.map((entry) => (
              <div key={entry.corpus} data-testid={`memory-graph-index-corpus-${entry.corpus}`}>
                <IndexRow
                  label={CORPUS_ROWS[entry.corpus].label}
                  value={corpusValue(entry, semanticAvailable)}
                  hint={CORPUS_ROWS[entry.corpus].hint}
                />
              </div>
            ))}
            {/* Its own row once any exist: digests are written in the
                background, so the count climbs toward the finished tasks. */}
            {index.digests.written > 0 ? (
              <div data-testid="memory-graph-index-digests">
                <IndexRow
                  label="Task digests"
                  value={`${index.digests.written.toLocaleString()} of ${index.digests.finishedTasks.toLocaleString()}`}
                  hint="A sentence or two per finished task, written by the answering agent. Searched with the task's record."
                />
              </div>
            ) : null}
            <IndexRow
              label="Chunks"
              value={totalChunks}
              hint="Passages everything above was split into. Search matches a chunk, not a whole document."
            />
            {index.storageBytes > 0 ? (
              <IndexRow
                label="Size on disk"
                value={formatBytes(index.storageBytes)}
                hint="The indexed text of every corpus plus its embedding vectors."
              />
            ) : null}
            <IndexRow label="Links" value={edgeCount} />
            <IndexRow
              label="Embedded"
              value={`${embeddableChunks > 0 ? Math.floor((totalEmbedded / embeddableChunks) * 100) : 0}%`}
              tone={semanticAvailable ? 'ok' : 'problem'}
              hint={semanticAvailable ? undefined : 'The semantic layer is unavailable, so search is matching text only'}
            />
            {coverage.sourceMissingButSearchable.documents > 0 ? (
              <IndexRow
                label="Transcript deleted"
                value={coverage.sourceMissingButSearchable.documents}
                // Said plainly because it is NOT a problem: the text and the
                // embeddings are still indexed and still answer queries.
                hint="The agent's transcript file is gone, but the indexed text and its embeddings are still here and still searchable"
              />
            ) : null}
            {coverage.notYetIndexed.documents > 0 ? (
              <IndexRow
                label="Not yet indexed"
                value={coverage.notYetIndexed.documents}
                hint="The background sweep has not reached these conversations yet"
              />
            ) : null}
            {coverage.failed.documents > 0 ? (
              <IndexRow label="Failed to index" value={coverage.failed.documents} tone="problem" />
            ) : null}
            {building ? (
              <IndexRow label="Status" value="updating" />
            ) : null}
          </dl>

          <p className="mt-2 flex items-start gap-1.5 text-[11px] leading-snug text-fg-faint">
            {/* Stated rather than implied. Position is a ~33%-faithful
                reduction of 1024 dimensions; the links are exact. */}
            <span>Links are exact; position is approximate.</span>
            <InfoHint text="Links are computed in full embedding dimensionality and are exact. Position is an approximate reduction, so nearby is a hint, not a guarantee." />
          </p>
        </div>
      </OverlayPopover>
    </div>
  );
}

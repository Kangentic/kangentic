/**
 * The Memory Graph's left panel: how the map is drawn, and what is in the index.
 *
 * ONE slab, two collapsible sections. It was two floating panels pinned to the
 * top and bottom of the left edge with a screen-height void between them, which
 * read as two unrelated things and spent the whole edge to say it. Display is
 * open by default because it is what you touch; Index is closed because it is
 * reference you consult.
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

import { useState } from 'react';
import { ChevronDown, Database, Shapes, SlidersHorizontal } from 'lucide-react';
import { SegmentedControl } from '../SegmentedControl';
import { CountBadge } from '../CountBadge';
import { Select } from '../settings/shared';
import type { MemoryGraphColorMode } from './MemoryGraphCanvas';
import { clusterHue } from './memory-graph-scene';
import type { MemoryCoverageSummary, MemoryGraphGranularity } from '../../../shared/types';
import { PanelRow, InfoHint, formatBytes } from './PanelRow';

/** Which conversations are drawn. Structural rather than a facet of the data,
 *  which is why it stays its own control below the three facet rows. */
export type MemoryGraphFilter = 'all' | 'standalone';

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
 * A control that can only ever return the same set is worse than no control -
 * the rule the Standalone toggle already followed, generalized. Time is the
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

/** Phrased as what HAPPENED, not as a lane name: these read beside each other in
 *  a list, where a bare "Done" next to "Active" reads as a column picker rather
 *  than a history. */
export const OUTCOME_LABELS: Readonly<Record<MemoryGraphOutcome, string>> = {
  done: 'Reached Done',
  active: 'Still on the board',
  // "Abandoned" rather than "Archived" because archiving is how a FINISHED task
  // leaves the board, so it is not the opposite of Done - dropping the work is.
  abandoned: 'Abandoned',
};

/** Display order, independent of whatever order the corpus happened to yield. */
export const OUTCOME_ORDER: ReadonlyArray<MemoryGraphOutcome> = ['done', 'active', 'abandoned'];

export const NO_FACETS_AVAILABLE: FacetAvailability = { since: false, outcomes: [] };

const COLOR_OPTIONS: ReadonlyArray<{ value: MemoryGraphColorMode; label: string; hint: string }> = [
  { value: 'cluster', label: 'Topic', hint: 'Color by the region of the map each conversation sits in' },
  { value: 'recency', label: 'Recency', hint: 'Warm is recent, cool is old - shows where your attention has moved' },
  // These three can now be told apart, which they could not when `archived_at`
  // overrode the lane: everything finished read as archived, so this mode
  // painted a real board one flat grey.
  { value: 'outcome', label: 'Outcome', hint: 'Green reached Done, amber still on the board, grey abandoned without finishing' },
  // Renamed from "Depth", which meant conversation length and collided with the
  // depth you are now flying through.
  { value: 'size', label: 'Length', hint: 'Brighter is a longer conversation' },
];

export interface MemoryGraphControlsProps {
  colorMode: MemoryGraphColorMode;
  onColorModeChange: (mode: MemoryGraphColorMode) => void;
  showLabels: boolean;
  onShowLabelsChange: (show: boolean) => void;
  showTitles: boolean;
  onShowTitlesChange: (show: boolean) => void;
  showEdges: boolean;
  onShowEdgesChange: (show: boolean) => void;
  filter: MemoryGraphFilter;
  onFilterChange: (filter: MemoryGraphFilter) => void;
  facets: MemoryGraphFacets;
  onFacetsChange: (facets: MemoryGraphFacets) => void;
  /** Rows with nothing to offer on this corpus are not rendered at all. */
  facetAvailability: FacetAvailability;
  /** One entry per region, in cluster order, for the Regions section. */
  regions: ReadonlyArray<{ id: number; label: string; count: number }>;
  /** Hidden entirely when zero: a filter that can only ever do nothing is worse
   *  than no filter. */
  standaloneCount: number;
  granularity: MemoryGraphGranularity;
  onGranularityChange: (granularity: MemoryGraphGranularity) => void;
  coverage: MemoryCoverageSummary;
  semanticAvailable: boolean;
  edgeCount: number;
  /** Bytes the index occupies. Computed in the background pass, so it travels
   *  with the map rather than being measured on every panel open. */
  storageBytes: number;
  building: boolean;
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

function SectionHeader({
  icon,
  label,
  collapsed,
  onToggle,
  testId,
}: {
  icon: React.ReactNode;
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  testId: string;
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
      <ChevronDown
        size={13}
        aria-hidden
        className={`transition-transform ${collapsed ? '-rotate-90' : ''}`}
      />
    </button>
  );
}

export function MemoryGraphControls({
  colorMode,
  onColorModeChange,
  showLabels,
  onShowLabelsChange,
  showTitles,
  onShowTitlesChange,
  showEdges,
  onShowEdgesChange,
  filter,
  onFilterChange,
  facets,
  onFacetsChange,
  facetAvailability,
  regions,
  standaloneCount,
  granularity,
  onGranularityChange,
  coverage,
  semanticAvailable,
  edgeCount,
  storageBytes,
  building,
}: MemoryGraphControlsProps) {
  const [displayCollapsed, setDisplayCollapsed] = useState(false);
  // Closed by default: the numbers are reference, not a control.
  const [indexCollapsed, setIndexCollapsed] = useState(true);
  // Open by default, unlike Index: these are a control the user acts on, not
  // reference they consult.
  const [regionsCollapsed, setRegionsCollapsed] = useState(false);
  const shownRegionCount = regions.filter((region) => !facets.hiddenRegions.has(region.id)).length;
  const anyFacetAvailable =
    facetAvailability.since || facetAvailability.outcomes.length > 1;

  return (
    <div
      className="w-64 rounded-lg border border-edge bg-surface-raised/80 backdrop-blur-md shadow-xl"
      data-testid="memory-graph-controls"
    >
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
            {/* A Select, not a SegmentedControl. The segmented control exists
                "for a small, flat set of mutually exclusive choices where showing
                the alternatives is worth the width" - and here the width is not
                there: four labels overflowed the panel at every width tried,
                cutting the last option in half. */}
            <Select
              value={colorMode}
              onChange={(event) => onColorModeChange(event.target.value as MemoryGraphColorMode)}
              aria-label="Color conversations by"
              data-testid="memory-graph-color-mode"
            >
              {COLOR_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>{option.label}</option>
              ))}
            </Select>
          </div>

          <div>
            <GroupLabel>Show</GroupLabel>
            <div className="space-y-1.5">
              {/* "Regions", not "Labels": there are two kinds of label on this
                  map now, and the generic word stopped saying which one this
                  row governs. */}
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
                  clues - without them a scoped view is a handful of anonymous
                  points - so this is an OFF switch for a map the user finds
                  busy, not an opt-in they have to find. */}
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

          {standaloneCount > 0 || anyFacetAvailable ? (
            <div>
              <GroupLabel hint="Scope the map to part of the index. Filters combine with each other and with search, so each one narrows what the others left.">
                Filter
              </GroupLabel>

              {/* A STACK of rows rather than one control, because these are four
                  independent questions. Each option is written to be
                  self-describing ("Last 30 days", not "30d"), so the rows need no
                  labels of their own and the panel stays narrow. Selects rather
                  than segmented controls throughout: the Colour row already
                  proved four labels overflow this width. */}
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
                    aria-label="Filter by where the work ended up"
                    data-testid="memory-graph-filter-outcome"
                  >
                    <option value="any">Any outcome</option>
                    {facetAvailability.outcomes.map((outcome) => (
                      <option key={outcome} value={outcome}>{OUTCOME_LABELS[outcome]}</option>
                    ))}
                  </Select>
                ) : null}
              </div>
            </div>
          ) : null}

          <div>
            <GroupLabel hint="How finely the map is cut into regions. All three are computed with the map, so switching is instant. No measurement can pick this for you: every way of scoring a clustering prefers the fewest regions on a cloud this continuous, so it is a question of how much detail you want to read.">
              Detail
            </GroupLabel>
            <SegmentedControl
              options={[
                { value: 'coarse', label: 'Coarse', title: 'Fewer, broader regions' },
                { value: 'balanced', label: 'Balanced', title: 'The default: regions of roughly 10 to 26 conversations' },
                { value: 'fine', label: 'Fine', title: 'More, narrower regions' },
              ]}
              value={granularity}
              onChange={onGranularityChange}
              ariaLabel="Region detail"
              testId="memory-graph-granularity"
              fullWidth
            />
          </div>

          {standaloneCount > 0 ? (
            <div className={anyFacetAvailable ? '-mt-1.5' : undefined}>
              <SegmentedControl
                options={[
                  { value: 'all', label: 'All' },
                  {
                    value: 'standalone',
                    label: 'Standalone',
                    title: 'Conversations with no close relative in the index - work nothing since has built on',
                    // Attached to the option rather than sitting in the map's
                    // chrome, so the number reads as "how many this filter would
                    // show" instead of as another statistic in a row of them.
                    trailing: <CountBadge count={standaloneCount} variant="muted" />,
                  },
                ]}
                value={filter}
                onChange={onFilterChange}
                ariaLabel="Filter conversations"
                testId="memory-graph-filter"
                fullWidth
              />
            </div>
          ) : null}
        </div>
      ) : null}

      {regions.length > 1 ? (
        <div className="border-t border-edge">
          <SectionHeader
            icon={<Shapes size={13} aria-hidden />}
            label="Regions"
            collapsed={regionsCollapsed}
            onToggle={() => setRegionsCollapsed((current) => !current)}
            testId="memory-graph-regions-toggle"
          />
          {!regionsCollapsed ? (
            <div className="px-3 pb-3">
              {/* The map's domains, each independently switchable. All on by
                  default: the map means the whole index until the user says
                  otherwise. */}
              <div className="mb-1.5 flex items-center justify-between">
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
              {/* Capped and scrollable: the region count is chosen from the data
                  now and can reach the mid twenties, so an uncapped list would
                  push Index off the bottom of a short window. The count and the
                  bulk actions stay OUTSIDE the scroller, since they are how you
                  recover from a long list rather than part of it. */}
              <div className="max-h-[42vh] space-y-0.5 overflow-y-auto pr-0.5">
                {regions.map((region) => (
                  <RegionRow
                    key={region.id}
                    label={region.label}
                    count={region.count}
                    hue={clusterHue(region.id)}
                    on={!facets.hiddenRegions.has(region.id)}
                    onToggle={() => {
                      const next = new Set(facets.hiddenRegions);
                      if (next.has(region.id)) next.delete(region.id);
                      else next.add(region.id);
                      onFacetsChange({ ...facets, hiddenRegions: next });
                    }}
                  />
                ))}
              </div>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="border-t border-edge">
        <SectionHeader
          icon={<Database size={13} aria-hidden />}
          label="Index"
          collapsed={indexCollapsed}
          onToggle={() => setIndexCollapsed((current) => !current)}
          testId="memory-graph-index-toggle"
        />
        {!indexCollapsed ? (
          <div className="px-3 pb-3">
            {/* A definition list, not the coverage STRIP. The strip is a
                full-width horizontal bar - icon, big number, two-line caption -
                and squeezing that into a 256px column produced a loose pile of
                glyphs and text that also printed 150 twice under two different
                labels. Aligned label/value rows are what a narrow column of
                reference numbers wants. */}
            <dl className="divide-y divide-edge/60">
              <IndexRow
                label="Conversations"
                value={coverage.totalDocumentsWithChunks}
                // Attached to the row it qualifies rather than trailing the list
                // as a second paragraph: it is about what "Conversations" counts.
                hint="Conversations this project has indexed. Says nothing about how much of the repository is indexed."
              />
              <IndexRow
                label="Chunks"
                value={coverage.totalChunks}
                hint="Passages the conversations were split into. Search matches a chunk, not a whole conversation."
              />
              {storageBytes > 0 ? (
                <IndexRow
                  label="Size on disk"
                  value={formatBytes(storageBytes)}
                  hint="The indexed text plus its embedding vectors."
                />
              ) : null}
              <IndexRow label="Links" value={edgeCount} />
              <IndexRow
                label="Embedded"
                value={`${Math.round(coverage.embeddedFraction * 100)}%`}
                tone={semanticAvailable ? 'ok' : 'problem'}
                hint={semanticAvailable ? undefined : 'The semantic layer is unavailable, so search is matching text only'}
              />
              {coverage.sourceMissingButSearchable.documents > 0 ? (
                <IndexRow
                  label="Transcript deleted"
                  value={coverage.sourceMissingButSearchable.documents}
                  // Said plainly because it is NOT a problem: the text and the
                  // embeddings are still indexed and still answer queries. On a
                  // mature project this is most of the corpus.
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
        ) : null}
      </div>
    </div>
  );
}

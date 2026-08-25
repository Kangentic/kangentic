import { useMemo } from 'react';
import { LayoutGrid, Rows3, Table2, Search, Layers, ArrowUpDown } from 'lucide-react';
import type { MonitorSessionRow, MonitorView } from '../../../shared/types';
import { ButtonGroup } from '../ButtonGroup';
import { MultiSelectDropdown } from '../MultiSelectDropdown';

/**
 * The monitor's header, built to the same structure as the usage dashboard's.
 *
 * That dashboard splits its controls into two deliberate tiers, and copying the
 * split is most of what makes this readable:
 *
 *   Row 1 - "what am I looking at": the scope (project) and the primary lens
 *           (layout), as prominent pill controls, with the live counts anchored
 *           opposite them.
 *   Row 2 - "how is it sliced": the quieter grouping / ordering / filter
 *           controls, as muted ButtonGroups.
 *
 * The first cut put all seven controls on one line as three native <select>s, a
 * checkbox, an icon strip and a search box, which is a lot of different shapes to
 * scan through. Same controls here, same primitives as the dashboard
 * (ButtonGroup, the rounded metric-toggle pill), just sorted into tiers.
 */

const LAYOUT_OPTIONS = [
  { value: 'cards' as const, label: 'Cards', Icon: LayoutGrid },
  { value: 'table' as const, label: 'Table', Icon: Table2 },
  { value: 'list' as const, label: 'List', Icon: Rows3 },
];

/**
 * Project first, and selected by default. This is a CROSS-PROJECT view: the
 * thing a user is orienting by when they open it is "whose agents are these",
 * and grouping by project answers that before they touch a control. Status
 * grouping is the deliberate second choice, for when the question is "what needs
 * me" rather than "where is it".
 *
 * Always one or the other; see MonitorGroupBy for why there is no "none".
 */
const GROUP_OPTIONS: Array<{ value: MonitorView['groupBy']; label: string }> = [
  { value: 'project', label: 'Project' },
  { value: 'state', label: 'Status' },
];

/** Just the two time directions; see MonitorSort for why attention is not here. */
const SORT_OPTIONS: Array<{ value: MonitorView['sort']; label: string }> = [
  { value: 'longest-running', label: 'Oldest' },
  { value: 'recently-started', label: 'Newest' },
];

interface MonitorToolbarProps {
  view: MonitorView;
  rows: MonitorSessionRow[];
  visibleCount: number;
  setView: (patch: Partial<MonitorView>) => void;
}

export function MonitorToolbar({ view, rows, visibleCount, setView }: MonitorToolbarProps) {
  // Derived from the UNFILTERED rows, deliberately: built from the filtered set
  // the option list would narrow to the current selection and deselecting a
  // project could never bring the others back. Rows are also the only source of
  // (id, name) pairs that exists in BOTH hosts - the detached pop-out never
  // seeds the project store. Sorted by name to match groupRows' project order.
  const projectOptions = useMemo(() => {
    const namesById = new Map<string, string>();
    for (const row of rows) {
      if (!namesById.has(row.projectId)) namesById.set(row.projectId, row.projectName);
    }
    return [...namesById]
      .map(([projectId, projectName]) => ({ value: projectId, label: projectName }))
      .sort((left, right) => left.label.localeCompare(right.label));
  }, [rows]);

  const selectedProjects = useMemo(() => new Set(view.projectFilter), [view.projectFilter]);

  // The trigger reads as live SCOPE STATE ("All projects", "2 of 5 projects"),
  // not a static "Projects" label: sitting beside the Group control's own
  // "Project" option, a bare noun read as more grouping and the affordance went
  // unfound in dogfooding. State copy says "this narrows what you are seeing",
  // the same vocabulary as the stats dashboard's scope picker.
  //
  // The numerator counts only filter ids the option list can represent, never
  // the raw persisted filter: the two sets differ whenever a persisted filter
  // arrives before the snapshot that reconciles it (boot, or a pop-out
  // re-hydrate), and a raw count then reads "2 of 1 project" - or "1 of 0"
  // against an empty morning. Intersecting keeps numerator and denominator on
  // the same source of truth, this window's own rows.
  const representableSelectionCount = projectOptions.reduce(
    (count, option) => count + (selectedProjects.has(option.value) ? 1 : 0),
    0,
  );
  const projectTriggerText = representableSelectionCount === 0
    ? 'All projects'
    : `${representableSelectionCount} of ${projectOptions.length} ${projectOptions.length === 1 ? 'project' : 'projects'}`;

  const toggleProject = (projectId: string) => {
    const next = selectedProjects.has(projectId)
      ? view.projectFilter.filter((existingProjectId) => existingProjectId !== projectId)
      : [...view.projectFilter, projectId];
    setView({ projectFilter: next });
  };

  return (
    <div className="flex-shrink-0" data-testid="monitor-toolbar">
      {/* PRIMARY tier: what am I looking at. Given its own breathing room and
          separated from the quieter controls by the recessed band below - three
          equally-weighted rows stacked 8px apart read as one dense block of pills
          with nothing telling the eye where to start. */}
      <div className="flex items-center gap-3 flex-wrap px-4 py-3">
        {/* Still NO single-project scope picker up here: narrowing to one project
            is what the board already does, and each row names its owning project
            anyway. The Projects control in the filter bar below is a different
            affordance - a cross-project view over MANY projects needs SUBSETTING
            (keep the two being worked in, drop the noisy ones), which is slicing,
            so it lives with the other slicing controls rather than as a primary
            scope. Its absence here leaves the layout selector room to be a
            chunkier control. */}
        <div
          className="flex items-center gap-1 rounded-xl border border-edge bg-surface/60 p-1"
          role="group"
          aria-label="Layout"
        >
          {LAYOUT_OPTIONS.map(({ value, label, Icon }) => (
            <button
              key={value}
              type="button"
              onClick={() => setView({ layout: value })}
              className={`flex items-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold cursor-pointer transition-colors ${
                view.layout === value
                  ? 'bg-accent/20 text-fg shadow-sm'
                  : 'text-fg-muted hover:text-fg hover:bg-surface-hover/40'
              }`}
              aria-pressed={view.layout === value}
              data-testid={`monitor-layout-${value}`}
            >
              <Icon size={16} className={view.layout === value ? 'text-accent' : ''} aria-hidden />
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* SECONDARY tier: one recessed band holding every "how is it sliced"
          control. The inset background and rules make it read as a filter bar
          distinct from both the primary row above and the content below, instead
          of a third identical stripe. Group and Sort are near-identical shapes
          that even share an option name ("Project"), so they sit at either end of
          a wide gap rather than shoulder to shoulder. */}
      <div className="flex items-center gap-6 flex-wrap px-4 py-2 bg-surface-inset/40 border-y border-edge">
        <ButtonGroup
          options={GROUP_OPTIONS}
          value={view.groupBy}
          onChange={(groupBy) => setView({ groupBy })}
          size="sm"
          icon={<Layers size={14} />}
          label="Group"
          ariaLabel="Group sessions by"
        />

        {/* Sorting is HIDDEN in the table layout, on purpose. A table sorts by
            its own column headers, so showing this too would be two controls for
            one job - and the header click silently overrides whatever the pill
            says, leaving the control lying about the current order. The rows
            still ARRIVE in this order; the headers just take over from here. */}
        {view.layout !== 'table' && (
          <ButtonGroup
            options={SORT_OPTIONS}
            value={view.sort}
            onChange={(sort) => setView({ sort })}
            size="sm"
            icon={<ArrowUpDown size={14} />}
            label="Sort"
            ariaLabel="Sort sessions by"
          />
        )}

        {/* A SUBSET filter, not a scope switch: keep the projects being worked
            in, hide the rest. Options come from the unfiltered rows (see
            projectOptions above), and the menu portals to document.body, where
            it sits outside the monitor's dismiss scope subtree and is marked
            data-dismissable-layer by OverlayPopover, so clicking an option
            never light-dismisses a monitor detail window. Hidden when there is
            nothing to subset, but kept while a filter is active so Clear stays
            reachable - only while at least one project is listed, though: with
            zero rows (a session-less morning holding a persisted filter) the
            control has no options to show and nothing it hides, and its trigger
            would read "1 of 0 projects". */}
        {(projectOptions.length >= 2 || (view.projectFilter.length > 0 && projectOptions.length > 0)) && (
          <div data-testid="monitor-project-filter">
            <MultiSelectDropdown
              label="Projects"
              triggerText={projectTriggerText}
              align="left"
              options={projectOptions}
              selected={selectedProjects}
              onToggle={toggleProject}
              onClear={() => setView({ projectFilter: [] })}
            />
          </div>
        )}

        {/* "Live only", not "Hide inactive": this hides PAUSED and finished
            sessions, and calling those "inactive" collides with the Active/Idle
            words every other part of the view uses for something else. */}
        <button
          type="button"
          onClick={() => setView({ liveOnly: !view.liveOnly })}
          className={`rounded-full border px-3 py-1 text-xs font-medium cursor-pointer transition-colors ${
            view.liveOnly
              ? 'border-accent/60 bg-accent/10 text-fg'
              : 'border-edge bg-surface/60 text-fg-muted hover:text-fg hover:bg-surface-hover/40'
          }`}
          aria-pressed={view.liveOnly}
          data-testid="monitor-live-only"
          title="Show only sessions with a live agent, hiding paused and recently finished"
        >
          Live only
        </button>

        <div className="relative">
          <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-fg-faint pointer-events-none" aria-hidden />
          <input
            type="text"
            value={view.textFilter}
            onChange={(event) => setView({ textFilter: event.target.value })}
            placeholder="Filter sessions"
            // Twice the old width: this filter matches across title, project,
            // column, agent, model, ticket and labels, so the useful queries are
            // longer than a 44-wide box shows. The row has the space.
            className="rounded-full border border-edge bg-surface/60 pl-7 pr-3 py-1 text-xs text-fg placeholder:text-fg-disabled focus:outline-none focus:border-accent w-[22rem]"
            data-testid="monitor-text-filter"
            aria-label="Filter sessions"
          />
        </div>

        {/* Shown ONLY while a filter is actually hiding something. Unfiltered it
            just restated the tiles above, which is why it read as noise; filtered
            it is the one thing that explains where the missing sessions went. */}
        {visibleCount !== rows.length && (
          <span
            className="flex items-center gap-1.5 rounded-full border border-edge bg-surface/60 px-3 py-1 text-xs text-fg-muted flex-shrink-0"
            title={`Filters are hiding ${rows.length - visibleCount} of ${rows.length} sessions`}
            data-testid="monitor-visible-count"
          >
            <span className="tabular-nums text-fg font-medium">{visibleCount}</span>
            of
            <span className="tabular-nums">{rows.length}</span>
          </span>
        )}
      </div>
    </div>
  );
}

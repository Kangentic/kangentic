import { Bot, MessageSquare, Zap } from 'lucide-react';
import { DataTable, type DataTableColumn, type DataTableColumnGroup } from '../../DataTable';
import { Pill } from '../../Pill';
import { ToggleSwitch } from '../../settings/shared';
import { ICON_REGISTRY, ROLE_DEFAULTS } from '../../../utils/swimlane-icons';
import type { SwimlaneRole } from '../../../../shared/types';

/**
 * The board at a glance: one row per column, one cell per setting, read from the
 * live drafts so unsaved edits show. Read-only. Clicking a row opens that
 * column.
 *
 * ONE cell vocabulary, and it is the point of this file. Nothing is ever blank
 * and nothing is a bare glyph; every cell prints the REAL value, and the
 * emphasis says whether anyone changed it:
 *
 *   - changed on this column: the value in a low-contrast chip
 *   - still what the column came with: the same word, muted, no chip
 *   - does not apply here: a muted dash with the reason in its `title`
 *
 * The word is always the actual value, never a stand-in. Agent, Model, Effort
 * and Permissions read "Default" because that is literally the option their
 * select sits on; an automation count reads "0". That rule is what caught the
 * old Session cells, which printed "Default" for two selects that had no
 * project-default option to sit on.
 *
 * A boolean shows the CONTROL that sets it, not a word: a disabled, read-only
 * `ToggleSwitch` at its value, so the row reads like the card the user set it
 * on. A column that has no such setting at all renders the same muted dash and
 * NOT a ghost switch, because a switch in the off position would claim the
 * setting exists and is off.
 */

/** One value cell: what it says, and whether anyone chose it. */
export interface OverviewValue {
  /** The real value's own wording. Never a stand-in. */
  label: string;
  /** Someone set this on this column, as opposed to it being what the column came with. */
  changed: boolean;
  /** False when the setting does not exist for this column at all. */
  applicable: boolean;
  /** Why it does not apply. Required when `applicable` is false; becomes the cell's `title`. */
  reason?: string;
}

/** One boolean cell, rendered as the read-only control that sets it. */
export interface OverviewFlag {
  on: boolean;
  applicable: boolean;
  reason?: string;
  /** Announced name, since a disabled switch has no label beside it. */
  ariaLabel: string;
}

/** One precomputed row for the overview grid (derived from the dialog's drafts). */
export interface OverviewRow {
  id: string;
  name: string;
  color: string;
  icon: string | null;
  role: SwimlaneRole | null;
  dirty: boolean;
  autoSpawn: OverviewFlag;
  agent: OverviewValue;
  model: OverviewValue;
  effort: OverviewValue;
  permission: OverviewValue;
  handoff: OverviewFlag;
  session: OverviewValue;
  onEnter: OverviewValue;
  onExit: OverviewValue;
}

interface ColumnsOverviewProps {
  rows: OverviewRow[];
  onSelect: (id: string) => void;
}

/**
 * Humanize a model id for display (e.g. `claude-fable-5` -> "Fable 5",
 * `claude-opus-4-8` -> "Opus 4.8"). A generic display formatter (not agent-name
 * branching): strips a vendor prefix, title-cases the name parts, and joins the
 * numeric version parts with dots. Mirrors the Claude adapter's
 * `humanizeClaudeModelId`; falls back to the raw id when nothing is derivable.
 */
export function formatModelName(modelId: string): string {
  const trimmed = modelId.trim();
  if (!trimmed) return trimmed;
  const bracketMatch = trimmed.match(/\[([^\]]+)\]/);
  const base = trimmed.replace(/\[[^\]]*\]/, '');
  const segments = base.replace(/^claude-/i, '').split('-').filter(Boolean);
  if (segments.length === 0) return trimmed;
  const nameParts: string[] = [];
  const versionParts: string[] = [];
  for (const segment of segments) {
    if (/^\d+$/.test(segment)) {
      if (segment.length < 6) versionParts.push(segment); // drop date stamps
    } else {
      nameParts.push(segment.charAt(0).toUpperCase() + segment.slice(1));
    }
  }
  const label = [nameParts.join(' '), versionParts.join('.')].filter(Boolean).join(' ');
  if (!label) return trimmed;
  return bracketMatch ? `${label} (${bracketMatch[1].toUpperCase()})` : label;
}

/**
 * The one renderer for every value cell, so the three states cannot drift column
 * by column. `data-state` is what a spec asserts against.
 */
function OverviewCell({ value }: { value: OverviewValue }) {
  if (!value.applicable) {
    // A dash, not an empty cell: an empty cell is indistinguishable from a value
    // that failed to load, and there would be nothing to hover for the reason.
    return (
      <span data-state="not-applicable" title={value.reason} className="text-fg-disabled">
        -
      </span>
    );
  }
  if (value.changed) {
    return (
      <span
        data-state="changed"
        className="inline-flex h-[22px] items-center whitespace-nowrap rounded bg-surface-hover/50 px-2 font-medium text-fg"
      >
        {value.label}
      </span>
    );
  }
  return (
    <span data-state="unchanged" className="whitespace-nowrap text-fg-faint">
      {value.label}
    </span>
  );
}

/** A boolean cell: the same switch the column page uses, read-only. */
function OverviewToggle({ flag }: { flag: OverviewFlag }) {
  if (!flag.applicable) {
    return (
      <span data-state="not-applicable" title={flag.reason} className="text-fg-disabled">
        -
      </span>
    );
  }
  return (
    <span data-state={flag.on ? 'changed' : 'unchanged'}>
      {/* BOTH `disabled` and `readOnly`, and they say different things. This is
          a read-only view, and the user's rule for one is that it carries no
          edit affordances, so a switch that takes a click and silently does
          nothing is the exact thing to avoid: `disabled` is what actually makes
          it inert and skips it in the tab order. `aria-readonly` is then what
          tells a screen reader the value is REAL and worth reading rather than
          unavailable, which is the honest reading of a mirrored setting. */}
      <ToggleSwitch
        checked={flag.on}
        onChange={() => { /* read-only: the column page is the one editing home */ }}
        disabled
        readOnly
        ariaLabel={flag.ariaLabel}
      />
    </span>
  );
}

export function ColumnsOverview({ rows, onSelect }: ColumnsOverviewProps) {
  // The bands mirror the column page's cards and their order exactly, so "On
  // enter" appears once on the screen and means one thing. Their icons are the
  // same glyphs the SectionCard headers and the rail count use, and they are the
  // only icons in the table.
  const columnGroups: DataTableColumnGroup[] = [
    { label: '', span: 1 },
    { label: 'Agent', span: 5, icon: <Bot size={12} strokeWidth={1.75} /> },
    { label: 'Conversation', span: 2, icon: <MessageSquare size={12} strokeWidth={1.75} /> },
    { label: 'Automations', span: 2, icon: <Zap size={12} strokeWidth={1.75} /> },
  ];

  const columns: DataTableColumn<OverviewRow>[] = [
    {
      key: 'name',
      label: 'Column',
      width: 'w-[17%]',
      render: (row) => {
        const Icon = row.icon ? ICON_REGISTRY.get(row.icon) : (row.role ? ROLE_DEFAULTS[row.role] : null);
        return (
          <span className="flex items-center gap-2 min-w-0">
            {Icon ? (
              <Icon size={14} strokeWidth={1.75} style={{ color: row.color }} className="flex-shrink-0" />
            ) : (
              <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ backgroundColor: row.color }} />
            )}
            <span className="truncate text-fg">{row.name || 'Untitled'}</span>
            {row.role && (
              <Pill size="sm" className="bg-surface-hover/60 text-fg-faint flex-shrink-0">
                {row.role === 'todo' ? 'To Do' : 'Done'}
              </Pill>
            )}
            {row.dirty && (
              <span aria-label="unsaved changes" className="w-1.5 h-1.5 rounded-full bg-accent flex-shrink-0" />
            )}
          </span>
        );
      },
    },
    { key: 'autoSpawn', label: 'Start', width: 'w-[7%]', render: (row) => <OverviewToggle flag={row.autoSpawn} /> },
    { key: 'agent', label: 'Agent', width: 'w-[12%]', render: (row) => <OverviewCell value={row.agent} /> },
    { key: 'model', label: 'Model', width: 'w-[10%]', render: (row) => <OverviewCell value={row.model} /> },
    { key: 'effort', label: 'Effort', width: 'w-[8%]', render: (row) => <OverviewCell value={row.effort} /> },
    { key: 'permission', label: 'Permissions', width: 'w-[14%]', render: (row) => <OverviewCell value={row.permission} /> },
    { key: 'handoff', label: 'Handoff', width: 'w-[8%]', render: (row) => <OverviewToggle flag={row.handoff} /> },
    { key: 'session', label: 'Session', width: 'w-[9%]', render: (row) => <OverviewCell value={row.session} /> },
    {
      key: 'onEnter',
      label: 'On enter',
      width: 'w-[7%]',
      render: (row) => <span data-enter={row.onEnter.label}><OverviewCell value={row.onEnter} /></span>,
    },
    {
      key: 'onExit',
      label: 'On exit',
      width: 'w-[8%]',
      render: (row) => <span data-exit={row.onExit.label}><OverviewCell value={row.onExit} /></span>,
    },
  ];

  return (
    <div className="flex-1 min-w-0 flex flex-col">
      <DataTable
        columns={columns}
        columnGroups={columnGroups}
        data={rows}
        rowKey={(row) => row.id}
        onRowClick={(row) => onSelect(row.id)}
        rowTestId="board-manager-overview-row"
      />
    </div>
  );
}

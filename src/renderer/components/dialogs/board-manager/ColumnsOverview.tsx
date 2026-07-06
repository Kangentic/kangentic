import { Check } from 'lucide-react';
import { DataTable, type DataTableColumn } from '../../DataTable';
import { Pill } from '../../Pill';
import { ICON_REGISTRY, ROLE_DEFAULTS } from '../../../utils/swimlane-icons';
import type { SwimlaneRole } from '../../../../shared/types';

/** One precomputed row for the overview grid (derived from the dialog's drafts). */
export interface OverviewRow {
  id: string;
  name: string;
  color: string;
  icon: string | null;
  role: SwimlaneRole | null;
  dirty: boolean;
  autoSpawn: boolean;
  /** Effective agent display name (the override's, or the project default's). */
  agentLabel: string;
  /** True when the column uses the project default agent (no override) - shown muted. */
  agentIsDefault: boolean;
  /** Model override (friendly-formatted), or 'Default' when none. */
  modelLabel: string;
  /** Effort override, or 'Default' when none. */
  effortLabel: string;
  /** Permission-mode label, or 'Default' when none. */
  permissionLabel: string;
  isolated: boolean;
  hasAutoCommand: boolean;
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

/** Muted em-dash-free placeholder for cells that do not apply to a row. */
function NotApplicable() {
  return <span className="text-fg-disabled">-</span>;
}

function BoolCell({ on }: { on: boolean }) {
  return on ? <Check size={14} className="text-accent-fg" /> : <NotApplicable />;
}

function MutedCell({ value, muted }: { value: string; muted: boolean }) {
  return <span className={`whitespace-nowrap ${muted ? 'text-fg-faint' : 'text-fg-secondary'}`}>{value}</span>;
}

/**
 * At-a-glance audit grid: one row per column, one cell per key setting. Values
 * are read from the live drafts so unsaved edits show. Clicking a row opens that
 * column's detail. Reuses the shared DataTable (non-virtualized, no header sort
 * so rows stay in board order).
 */
export function ColumnsOverview({ rows, onSelect }: ColumnsOverviewProps) {
  const columns: DataTableColumn<OverviewRow>[] = [
    {
      key: 'name',
      label: 'Column',
      width: 'w-[18%]',
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
    {
      key: 'autoSpawn',
      label: 'Spawn',
      width: 'w-[8%]',
      render: (row) => (row.role ? <NotApplicable /> : <BoolCell on={row.autoSpawn} />),
    },
    {
      key: 'agentLabel',
      label: 'Agent',
      width: 'w-[13%]',
      render: (row) => (row.role ? <NotApplicable /> : <MutedCell value={row.agentLabel} muted={row.agentIsDefault} />),
    },
    {
      key: 'modelLabel',
      label: 'Model',
      width: 'w-[11%]',
      render: (row) => (row.role ? <NotApplicable /> : <MutedCell value={row.modelLabel} muted={row.modelLabel === 'Default'} />),
    },
    {
      key: 'effortLabel',
      label: 'Effort',
      width: 'w-[9%]',
      render: (row) => (row.role ? <NotApplicable /> : <MutedCell value={row.effortLabel} muted={row.effortLabel === 'Default'} />),
    },
    {
      key: 'permissionLabel',
      label: 'Permissions',
      width: 'w-[19%]',
      render: (row) => (row.role ? <NotApplicable /> : <MutedCell value={row.permissionLabel} muted={row.permissionLabel === 'Default'} />),
    },
    {
      key: 'isolated',
      label: 'Session',
      width: 'w-[11%]',
      render: (row) => (row.role ? <NotApplicable /> : <MutedCell value={row.isolated ? 'Isolated' : 'Main'} muted={!row.isolated} />),
    },
    {
      key: 'hasAutoCommand',
      label: 'Auto-cmd',
      width: 'w-[11%]',
      render: (row) => (row.role ? <NotApplicable /> : <BoolCell on={row.hasAutoCommand} />),
    },
  ];

  return (
    <div className="flex-1 min-w-0 flex flex-col">
      <DataTable
        columns={columns}
        data={rows}
        rowKey={(row) => row.id}
        onRowClick={(row) => onSelect(row.id)}
        rowTestId="board-manager-overview-row"
      />
    </div>
  );
}

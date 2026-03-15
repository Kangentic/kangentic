import React, { useState, useMemo, useCallback, useEffect, useRef } from 'react';
import { useDroppable } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { Search, Pencil, ArrowDownToLine, ArrowUpDown } from 'lucide-react';
import { TaskCard } from './TaskCard';
import { EditColumnDialog } from '../dialogs/EditColumnDialog';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { getSwimlaneIcon } from '../../utils/swimlane-icons';
import { useBoardStore } from '../../stores/board-store';
import { useConfigStore } from '../../stores/config-store';
import { Pill } from '../Pill';
import type { Swimlane as SwimlaneType, Task, SessionSummary } from '../../../shared/types';

type SortKey = 'date' | 'cost' | 'tokens' | 'duration';
const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: 'date', label: 'Date' },
  { key: 'cost', label: 'Cost' },
  { key: 'tokens', label: 'Tokens' },
  { key: 'duration', label: 'Duration' },
];

export interface DoneSwimlaneProps {
  swimlane: SwimlaneType;
  tasks: Task[];
  dragHandleProps?: Record<string, unknown>;
}

export function DoneSwimlane({ swimlane, tasks }: DoneSwimlaneProps) {
  const [search, setSearch] = useState('');
  const [showEditColumn, setShowEditColumn] = useState(false);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [sortKey, setSortKey] = useState<SortKey>('date');
  const [showSortDropdown, setShowSortDropdown] = useState(false);
  const sortDropdownRef = useRef<HTMLDivElement>(null);
  const [summaries, setSummaries] = useState<Record<string, SessionSummary>>({});

  const archivedTasks = useBoardStore((s) => s.archivedTasks);
  const deleteArchivedTask = useBoardStore((s) => s.deleteArchivedTask);
  const recentlyArchivedId = useBoardStore((s) => s.recentlyArchivedId);
  const clearRecentlyArchived = useBoardStore((s) => s.clearRecentlyArchived);
  const skipDeleteConfirm = useConfigStore((s) => s.config.skipDeleteConfirm);
  const updateConfig = useConfigStore((s) => s.updateConfig);

  // Fetch batch summaries (always, not gated on expand)
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const result = await window.electronAPI.sessions.listSummaries();
        if (!cancelled) setSummaries(result);
      } catch {
        // Ignore errors (e.g. in tests)
      }
    })();
    return () => { cancelled = true; };
  }, [archivedTasks.length]);

  // Close sort dropdown on click outside
  useEffect(() => {
    if (!showSortDropdown) return;
    const handleClick = (event: MouseEvent) => {
      if (sortDropdownRef.current && !sortDropdownRef.current.contains(event.target as Node)) {
        setShowSortDropdown(false);
      }
    };
    document.addEventListener('mousedown', handleClick, true);
    return () => document.removeEventListener('mousedown', handleClick, true);
  }, [showSortDropdown]);

  const handleDeleteRequest = useCallback((taskId: string) => {
    if (skipDeleteConfirm) {
      deleteArchivedTask(taskId);
    } else {
      setPendingDeleteId(taskId);
    }
  }, [skipDeleteConfirm, deleteArchivedTask]);

  const handleConfirmDelete = useCallback((dontAskAgain: boolean) => {
    if (pendingDeleteId) {
      deleteArchivedTask(pendingDeleteId);
      if (dontAskAgain) updateConfig({ skipDeleteConfirm: true });
    }
    setPendingDeleteId(null);
  }, [pendingDeleteId, deleteArchivedTask, updateConfig]);

  const taskIds = useMemo(() => tasks.map((t) => t.id), [tasks]);

  const { setNodeRef, isOver } = useDroppable({
    id: swimlane.id,
    data: { type: 'swimlane' },
  });

  const filteredArchived = useMemo(() => {
    let filtered = archivedTasks;
    if (search.trim()) {
      const query = search.toLowerCase();
      filtered = filtered.filter(
        (t) => t.title.toLowerCase().includes(query) || t.description.toLowerCase().includes(query),
      );
    }
    if (sortKey === 'date') return filtered; // default order (archived_at DESC)
    return [...filtered].sort((taskA, taskB) => {
      const summaryA = summaries[taskA.id];
      const summaryB = summaries[taskB.id];
      // Tasks without summaries sort to bottom
      if (!summaryA && !summaryB) return 0;
      if (!summaryA) return 1;
      if (!summaryB) return -1;
      switch (sortKey) {
        case 'cost': return summaryB.totalCostUsd - summaryA.totalCostUsd;
        case 'tokens': return (summaryB.totalInputTokens + summaryB.totalOutputTokens) - (summaryA.totalInputTokens + summaryA.totalOutputTokens);
        case 'duration': {
          const durationA = summaryA.exitedAt ? new Date(summaryA.exitedAt).getTime() - new Date(summaryA.taskCreatedAt).getTime() : 0;
          const durationB = summaryB.exitedAt ? new Date(summaryB.exitedAt).getTime() - new Date(summaryB.taskCreatedAt).getTime() : 0;
          return durationB - durationA;
        }
        default: return 0;
      }
    });
  }, [archivedTasks, search, sortKey, summaries]);

  return (
    <div
      data-testid="swimlane"
      data-swimlane-name={swimlane.name}
      className="flex-shrink-0 w-72 h-full flex flex-col rounded-lg bg-surface-raised/70 ring-1 ring-edge/50"
    >
      {/* Accent bar */}
      <div
        className="h-0.5 rounded-t-lg"
        style={{ backgroundColor: swimlane.color }}
      />

      {/* Column header */}
      <div className="px-3 py-2 flex items-center gap-2 border-b border-edge/50 w-full text-left hover:bg-surface-hover/30 transition-colors">
        {(() => {
          const Icon = getSwimlaneIcon(swimlane);
          return Icon ? (
            <span style={{ color: swimlane.color }}><Icon size={14} strokeWidth={1.75} /></span>
          ) : (
            <div
              className="w-2.5 h-2.5 rounded-full flex-shrink-0"
              style={{ backgroundColor: swimlane.color }}
            />
          );
        })()}

        <button
          type="button"
          onClick={() => setShowEditColumn(true)}
          className="flex items-center gap-2 flex-1 min-w-0"
        >
          <span className="text-sm font-medium truncate text-fg">
            {swimlane.name}
          </span>
        </button>

        <Pill size="sm" className="bg-surface-hover/40 text-fg-faint tabular-nums leading-5">{tasks.length}</Pill>

        <button
          type="button"
          data-testid="edit-column-btn"
          aria-label={`Edit ${swimlane.name} column`}
          onClick={(e: React.MouseEvent) => {
            e.stopPropagation();
            setShowEditColumn(true);
          }}
          className="flex-shrink-0 p-0.5 text-fg-disabled hover:text-fg-muted transition-colors"
        >
          <Pencil size={12} />
        </button>
      </div>

      {/* Drop zone */}
      <div className="p-2 flex-shrink-0">
        <div
          ref={setNodeRef}
          data-done-drop-zone
          className={`rounded-lg p-4 text-center min-h-[180px] flex items-center justify-center ${
            isOver
              ? 'drop-zone-active'
              : 'border-2 border-dashed border-edge/50 text-fg-disabled'
          }`}
          style={isOver ? { '--drop-color': swimlane.color, color: swimlane.color } as React.CSSProperties : undefined}
        >
          <div className="relative z-10 w-full">
            <SortableContext items={taskIds} strategy={verticalListSortingStrategy}>
              {tasks.length > 0 ? (
                <div className="space-y-2 w-full">
                  {tasks.map((task) => (
                    <TaskCard key={task.id} task={task} />
                  ))}
                </div>
              ) : (
                <div className="flex flex-col items-center gap-1.5">
                  <ArrowDownToLine size={20} className="opacity-50" />
                  <span className="text-xs">Drop here to complete</span>
                </div>
              )}
            </SortableContext>
          </div>
        </div>
      </div>

      {/* Completed tasks section -- always visible */}
      <div className="flex-1 min-h-0 flex flex-col px-2 pb-2 border-t border-edge/50">
        {/* Section header */}
        <div className="pt-2.5 pb-1 px-0.5 flex-shrink-0">
          <span className="text-sm font-medium text-fg-muted">
            Completed ({archivedTasks.length})
          </span>
        </div>

        {/* Search + Sort row (only when 3+ archived tasks) */}
        {archivedTasks.length > 0 && (
          <div className="flex items-center gap-1.5 pb-1.5 flex-shrink-0">
            <div className="relative flex-1">
              <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-disabled" />
              <input
                type="text"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search..."
                className="w-full bg-surface/50 border border-edge/50 rounded text-xs text-fg-tertiary placeholder-fg-disabled pl-7 pr-2 py-1.5 outline-none focus:border-edge-input"
              />
            </div>
            <div className="relative" ref={sortDropdownRef}>
              <button
                type="button"
                onClick={() => setShowSortDropdown(!showSortDropdown)}
                className="flex items-center gap-1 px-1.5 py-1.5 text-fg-disabled hover:text-fg-muted bg-surface/50 border border-edge/50 rounded text-xs transition-colors"
                title={`Sort by ${SORT_OPTIONS.find((option) => option.key === sortKey)?.label}`}
                data-testid="sort-dropdown-trigger"
              >
                <ArrowUpDown size={12} />
              </button>
              {showSortDropdown && (
                <div className="absolute right-0 top-full mt-1 min-w-[100px] bg-surface-raised border border-edge-input rounded-md shadow-xl z-50 py-1">
                  {SORT_OPTIONS.map((option) => (
                    <button
                      key={option.key}
                      type="button"
                      onClick={() => { setSortKey(option.key); setShowSortDropdown(false); }}
                      className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                        sortKey === option.key
                          ? 'text-accent-fg bg-accent/10'
                          : 'text-fg-tertiary hover:bg-surface-hover hover:text-fg'
                      }`}
                      data-testid={`sort-option-${option.key}`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Archived task list -- scrollable */}
        <div className="flex-1 min-h-0 overflow-y-auto space-y-1">
          {filteredArchived.map((task) => {
            const isGrowingIn = recentlyArchivedId === task.id;
            return isGrowingIn ? (
              <div
                key={task.id}
                className="grow-in"
                onAnimationEnd={clearRecentlyArchived}
              >
                <TaskCard task={task} compact onDelete={handleDeleteRequest} summary={summaries[task.id]} />
              </div>
            ) : (
              <TaskCard
                key={task.id}
                task={task}
                compact
                onDelete={handleDeleteRequest}
                summary={summaries[task.id]}
              />
            );
          })}
          {filteredArchived.length === 0 && search && (
            <div className="text-xs text-fg-disabled text-center py-2">No matches</div>
          )}
          {filteredArchived.length === 0 && !search && (
            <div className="text-xs text-fg-disabled text-center py-3">No completed tasks yet</div>
          )}
        </div>
      </div>

      {pendingDeleteId && (
        <ConfirmDialog
          title="Delete completed task"
          message={<>
            <p>This will permanently delete the task, its session history, and any associated worktree.</p>
            <p className="text-red-400 font-medium">This action cannot be undone.</p>
          </>}
          confirmLabel="Delete"
          variant="danger"
          showDontAskAgain
          onConfirm={handleConfirmDelete}
          onCancel={() => setPendingDeleteId(null)}
        />
      )}

      {showEditColumn && (
        <EditColumnDialog
          swimlane={swimlane}
          onClose={() => setShowEditColumn(false)}
        />
      )}
    </div>
  );
}

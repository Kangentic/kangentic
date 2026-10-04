/**
 * The Knowledge Graph's Projects picker: which projects the map shows and a
 * question is asked across.
 *
 * ONE ROW in the Filter card, however many projects there are, opening a
 * searchable checklist. An inline list was the first design and it stopped
 * working at a real machine's count: nineteen rows pushed Regions below the fold
 * for a choice made once per visit.
 *
 * The scope is never empty. An empty map would have nothing to draw and nothing
 * to pick from again, so None returns to the open project alone, and the last
 * checked project cannot be unchecked.
 *
 * A choice-presenting popover, so it portals out of the panel, which scrolls
 * (`.claude/rules/popover-escapes-clipping.md`).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';
import type { KnowledgeGraphProjectSummary } from '../../../shared/types';
import { isIndexedProject } from '../../../shared/index-summary';
import { OverlayPopover } from '../OverlayPopover';
import { usePopoverPosition } from '../../hooks/usePopoverPosition';

export interface KnowledgeGraphProjectsPickerProps {
  projects: ReadonlyArray<KnowledgeGraphProjectSummary>;
  openProjectId: string | null;
  /** The projects in scope now: the open one when no scope is set. */
  selectedIds: ReadonlyArray<string>;
  /** Selected projects whose map cannot be drawn yet (loading or building). */
  pendingIds: ReadonlyArray<string>;
  onChange: (projectIds: string[]) => void;
}

/** The open project first, then by most recent work, then by name. */
export function orderProjects(
  projects: ReadonlyArray<KnowledgeGraphProjectSummary>,
  openProjectId: string | null,
): KnowledgeGraphProjectSummary[] {
  return [...projects].sort((left, right) => {
    if (left.id === openProjectId) return -1;
    if (right.id === openProjectId) return 1;
    const byRecency = (right.lastActivityMs ?? 0) - (left.lastActivityMs ?? 0);
    return byRecency !== 0 ? byRecency : left.name.localeCompare(right.name);
  });
}

/** What the row says about the scope: the project, "3 projects", or "All projects". */
export function scopeLabel(
  selectedIds: ReadonlyArray<string>,
  indexed: ReadonlyArray<KnowledgeGraphProjectSummary>,
): string {
  if (selectedIds.length === 1) return indexed.find((project) => project.id === selectedIds[0])?.name ?? '1 project';
  if (indexed.length > 1 && indexed.every((project) => selectedIds.includes(project.id))) return 'All projects';
  return `${selectedIds.length} projects`;
}

export function KnowledgeGraphProjectsPicker({
  projects,
  openProjectId,
  selectedIds,
  pendingIds,
  onChange,
}: KnowledgeGraphProjectsPickerProps) {
  const [open, setOpenState] = useState(false);
  const [query, setQuery] = useState('');
  // The search clears as the menu closes, so the next open lists every project.
  const setOpen = (next: boolean): void => {
    setOpenState(next);
    if (!next) setQuery('');
  };
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const { style } = usePopoverPosition(triggerRef, menuRef, open, { mode: 'dropdown', strategy: 'fixed' });

  const ordered = useMemo(() => orderProjects(projects, openProjectId), [projects, openProjectId]);
  // The same set the Settings Index card sums, so All projects reads the same there.
  const indexed = useMemo(() => ordered.filter((project) => isIndexedProject(project.conversations)), [ordered]);
  const notIndexed = useMemo(() => ordered.filter((project) => !isIndexedProject(project.conversations)), [ordered]);
  const matches = (project: KnowledgeGraphProjectSummary): boolean =>
    project.name.toLowerCase().includes(query.trim().toLowerCase());
  const selected = new Set(selectedIds);

  // Outside click checks BOTH refs: the menu is portaled out of the trigger's
  // subtree, so a click inside it would otherwise read as outside.
  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePress = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpenState(false);
      setQuery('');
    };
    // Escape closes the picker, not the graph under it: a capture-phase
    // listener registered only while open, as the comboboxes do.
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpenState(false);
      setQuery('');
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', closeOnOutsidePress, true);
    document.addEventListener('keydown', closeOnEscape, true);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsidePress, true);
      document.removeEventListener('keydown', closeOnEscape, true);
    };
  }, [open]);

  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  const toggle = (projectId: string): void => {
    if (selected.has(projectId)) {
      // Never below one: the last checked project stays.
      if (selected.size === 1) return;
      onChange(selectedIds.filter((id) => id !== projectId));
    } else {
      onChange([...selectedIds, projectId]);
    }
  };

  /** Arrow keys move between rows, queried off the MENU, since it is portaled. */
  const moveFocus = (from: HTMLElement | null, step: 1 | -1): void => {
    const rows = Array.from(menuRef.current?.querySelectorAll<HTMLButtonElement>('[data-picker-row]:not(:disabled)') ?? []);
    if (rows.length === 0) return;
    const at = from ? rows.indexOf(from as HTMLButtonElement) : -1;
    const next = at < 0 ? (step === 1 ? 0 : rows.length - 1) : Math.min(rows.length - 1, Math.max(0, at + step));
    rows[next].focus();
  };

  const label = scopeLabel(selectedIds, indexed);
  const shownIndexed = indexed.filter(matches);
  const shownNotIndexed = notIndexed.filter(matches);

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(!open)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`flex w-full items-center gap-2 rounded border bg-surface-control py-1.5 pl-3 pr-2.5 text-left text-sm text-fg-tertiary cursor-pointer focus:outline-none ${open ? 'border-accent' : 'border-edge-input focus:border-accent'}`}
        data-testid="knowledge-graph-projects"
      >
        <span className="min-w-0 flex-1 truncate">{label}</span>
        <span className="flex-shrink-0 text-[11px] tabular-nums text-fg-faint">
          {selectedIds.length} of {indexed.length}
        </span>
        <ChevronDown size={14} className="flex-shrink-0 text-fg-muted" aria-hidden />
      </button>

      <OverlayPopover
        open={open}
        popoverRef={menuRef}
        style={style}
        portal
        transformOrigin="top center"
        className="fixed z-[2147483646] flex max-h-[26rem] w-72 flex-col overflow-hidden rounded-lg border border-edge bg-surface-raised shadow-xl"
        data-testid="knowledge-graph-projects-menu"
      >
        <div className="relative m-2 mb-1.5">
          <Search size={12} className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-fg-muted" aria-hidden />
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'ArrowDown') {
                event.preventDefault();
                moveFocus(null, 1);
              }
            }}
            placeholder="Find a project"
            aria-label="Find a project"
            className="w-full rounded border border-edge-input bg-surface py-1 pl-7 pr-2 text-xs text-fg placeholder:text-fg-muted outline-none focus:border-accent"
            data-testid="knowledge-graph-projects-search"
          />
        </div>
        <div className="flex items-center gap-1 px-3 pb-1.5 text-[11px] text-fg-muted">
          <span className="flex-1">{selectedIds.length} of {indexed.length} shown</span>
          <button
            type="button"
            onClick={() => onChange(indexed.map((project) => project.id))}
            disabled={indexed.every((project) => selected.has(project.id))}
            className="rounded px-1.5 py-0.5 hover:bg-surface-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent cursor-pointer disabled:cursor-default"
            data-testid="knowledge-graph-projects-all"
          >
            All
          </button>
          <button
            type="button"
            // The scope is never empty, so None is the open project alone.
            onClick={() => onChange(openProjectId ? [openProjectId] : indexed.slice(0, 1).map((project) => project.id))}
            disabled={selectedIds.length === 1}
            title="Just the open project"
            className="rounded px-1.5 py-0.5 hover:bg-surface-hover hover:text-fg disabled:opacity-40 disabled:hover:bg-transparent cursor-pointer disabled:cursor-default"
            data-testid="knowledge-graph-projects-none"
          >
            None
          </button>
        </div>
        <div
          className="min-h-0 flex-1 overflow-y-auto pb-1.5"
          role="listbox"
          aria-multiselectable="true"
          aria-label="Projects"
          onKeyDown={(event) => {
            if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
              event.preventDefault();
              moveFocus(document.activeElement as HTMLElement | null, event.key === 'ArrowDown' ? 1 : -1);
            }
          }}
        >
          {shownIndexed.length === 0 && shownNotIndexed.length === 0 ? (
            <p className="px-3 py-2 text-xs text-fg-muted">No project matches that.</p>
          ) : null}
          {shownIndexed.map((project) => {
            const isOn = selected.has(project.id);
            const isPending = isOn && pendingIds.includes(project.id);
            return (
              <button
                key={project.id}
                type="button"
                role="option"
                aria-selected={isOn}
                data-picker-row
                onClick={() => toggle(project.id)}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-fg hover:bg-surface-hover focus:bg-surface-hover focus:outline-none cursor-pointer"
                data-testid="knowledge-graph-projects-row"
                data-project-id={project.id}
              >
                <span
                  className={`flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center rounded-[3px] border ${isOn ? 'border-accent bg-accent text-accent-on' : 'border-edge-input'}`}
                  aria-hidden
                >
                  {isOn ? <Check size={10} strokeWidth={3} /> : null}
                </span>
                <span className="min-w-0 flex-1 truncate">{project.name}</span>
                {isPending ? <span className="flex-shrink-0 text-[11px] text-fg-muted">Building</span> : null}
                {/* The count is what the map draws; the task records it also
                    searches are named on hover. */}
                <span
                  className="flex-shrink-0 text-[11px] tabular-nums text-fg-faint"
                  title={`${project.conversations.toLocaleString()} conversations, ${project.taskRecords.toLocaleString()} task records`}
                >
                  {project.conversations}
                </span>
              </button>
            );
          })}
          {shownNotIndexed.length > 0 ? (
            <>
              <div className="mx-3 mb-1 mt-1.5 border-t border-edge pt-2 text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
                Not indexed
              </div>
              {shownNotIndexed.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  role="option"
                  aria-selected={false}
                  aria-disabled
                  disabled
                  data-picker-row
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-fg-muted cursor-default"
                  data-testid="knowledge-graph-projects-row-unindexed"
                  title="Nothing indexed yet, so there is no map to draw"
                >
                  <span className="h-3.5 w-3.5 flex-shrink-0 rounded-[3px] border border-edge" aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{project.name}</span>
                  <span className="flex-shrink-0 text-[11px] tabular-nums">0</span>
                </button>
              ))}
            </>
          ) : null}
        </div>
      </OverlayPopover>
    </div>
  );
}

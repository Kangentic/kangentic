import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { OverlayPopover } from '../OverlayPopover';
import { usePopoverPosition } from '../../hooks/usePopoverPosition';
import type { Project } from '../../../shared/types';

interface StatsScopePickerProps {
  /** Every registered project (viewable without switching the app). */
  projects: Project[];
  /** The effectively-viewed project id; null = All Projects. */
  activeProjectId: string | null;
  onSelectAll: () => void;
  onSelectProject: (projectId: string) => void;
}

/**
 * The dashboard's "what am I looking at" control: an accent pill in the title
 * row opening a custom popover with the app-wide rollup pinned at the top,
 * a divider, then the project list - separating the aggregation MODE from the
 * entity choice instead of flattening both into one native select (whose
 * OS-rendered popup also cannot be themed). A checkmark marks the active row.
 * Built on the same OverlayPopover pattern as the app's other pickers; rows
 * can grow into multi-project checkboxes later without changing the shell.
 */
export function StatsScopePicker({ projects, activeProjectId, onSelectAll, onSelectProject }: StatsScopePickerProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const { style: popoverStyle } = usePopoverPosition(triggerRef, popoverRef, open, { mode: 'dropdown' });

  // Close on click outside (capture so it wins over other handlers).
  useEffect(() => {
    if (!open) return;
    function handleClickOutside(event: MouseEvent) {
      if (
        popoverRef.current && !popoverRef.current.contains(event.target as Node) &&
        triggerRef.current && !triggerRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside, true);
    return () => document.removeEventListener('mousedown', handleClickOutside, true);
  }, [open]);

  // Close on Escape - capture phase with stopPropagation so the page's own
  // bubble-phase Escape (which closes the whole dashboard) does not fire for
  // the same keypress.
  useEffect(() => {
    if (!open) return;
    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    }
    document.addEventListener('keydown', handleEscape, true);
    return () => document.removeEventListener('keydown', handleEscape, true);
  }, [open]);

  const activeProject = activeProjectId
    ? projects.find((project) => project.id === activeProjectId)
    : null;
  const label = activeProjectId ? activeProject?.name ?? 'Project' : 'All Projects';

  const select = (apply: () => void) => {
    apply();
    setOpen(false);
  };

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(!open)}
        className="flex items-center gap-1.5 bg-accent/15 border border-accent/40 rounded-full pl-3 pr-2.5 py-1 text-sm font-semibold text-fg cursor-pointer hover:bg-accent/25 focus:outline-none focus:border-accent transition-colors"
        title="Choose which project's usage to view"
        aria-label="Project scope"
        data-testid="stats-scope-trigger"
      >
        {label}
        <ChevronDown size={14} className="text-fg-muted" />
      </button>
      <OverlayPopover
        open={open}
        popoverRef={popoverRef}
        style={popoverStyle}
        className="absolute z-50 bg-surface-raised border border-edge rounded-lg shadow-xl py-1 min-w-[180px]"
      >
        <button
          type="button"
          onClick={() => select(onSelectAll)}
          className="w-full px-3 py-1.5 text-xs text-fg-secondary text-left hover:bg-surface-hover/40 flex items-center justify-between gap-3"
          data-testid="stats-scope-option-all"
        >
          All Projects
          {activeProjectId === null && <Check size={12} className="text-accent flex-shrink-0" />}
        </button>
        <div className="h-px bg-edge/60 my-1" aria-hidden />
        {projects.map((project) => (
          <button
            key={project.id}
            type="button"
            onClick={() => select(() => onSelectProject(project.id))}
            className="w-full px-3 py-1.5 text-xs text-fg-secondary text-left hover:bg-surface-hover/40 flex items-center justify-between gap-3"
            data-testid="stats-scope-option-project"
          >
            <span className="truncate">{project.name}</span>
            {activeProjectId === project.id && <Check size={12} className="text-accent flex-shrink-0" />}
          </button>
        ))}
      </OverlayPopover>
    </div>
  );
}

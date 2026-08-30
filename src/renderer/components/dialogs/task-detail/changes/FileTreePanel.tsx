import { useMemo, useState, useRef, useCallback, useEffect, memo, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import { Search, Plus, Pencil, Minus, ArrowRight, Copy, ChevronRight, ChevronDown, FileQuestion, GitBranch, ArrowUp, ArrowDown, ArrowDownUp, ListTree, List, FoldVertical, UnfoldVertical, FolderOpen, ExternalLink, Check, History, Loader2, AppWindow } from 'lucide-react';
import { useConfigStore } from '../../../../stores/config-store';
import type { AppConfig, GitBranchSummaryResult, GitDiffFileEntry, GitDiffScope, GitDiffStatus, GitFileHistoryCommit, PRState } from '../../../../../shared/types';
import { formatRelativeTime } from '../../../../lib/datetime';
import { useToastStore } from '../../../../stores/toast-store';
import { PrLink } from '../../../PrLink';
import { OverlayPopover } from '../../../OverlayPopover';
import { usePopoverPosition } from '../../../../hooks/usePopoverPosition';
import { CountBadge } from '../../../CountBadge';

/** Diff scope options for the segmented control (single-select among 3 fixed values). */
const SCOPE_OPTIONS: { value: GitDiffScope; label: string }[] = [
  { value: 'working', label: 'Working' },
  { value: 'staged', label: 'Staged' },
  { value: 'branch', label: 'Branch' },
];

interface FileTreePanelProps {
  files: GitDiffFileEntry[];
  selectedFile: string | null;
  onSelect: (filePath: string) => void;
  totalInsertions: number;
  totalDeletions: number;
  /** Live branch context (name, ahead/behind, last commit) shown in the header. */
  branchSummary?: GitBranchSummaryResult | null;
  /** Whether to render the built-in branch header (branch + base + ahead/behind +
   *  last commit). The task-detail embed shows this context in the shared surface
   *  header instead, so it passes false to avoid duplicating the row. Default true
   *  (standalone dialog / command-terminal embed, which have no surface header). */
  showBranchHeader?: boolean;
  /** Paths the user has marked "viewed" (their rows dim). */
  viewedFiles: Set<string>;
  /** Toggle a file's "viewed" mark. */
  onToggleViewed: (filePath: string) => void;
  /** Current diff scope (working / staged / branch). */
  scope?: GitDiffScope;
  /** Change the diff scope. */
  onScopeChange?: (scope: GitDiffScope) => void;
  /** Base branch name, shown beside the branch name as a badge (the full
   *  "based on" / "off" sentence lives in the badge's hover tooltip, not the
   *  visible text). Only meaningful alongside `branchSummary`. */
  baseLabel?: string;
  /** Whether `baseLabel` reflects a custom (non-default) base branch - the
   *  more surprising case, rendered with a stronger accent tone than the
   *  default-base case so it actually draws the eye. */
  baseLabelCustom?: boolean;
  /** Linked-PR chip data for the branch header, so every mount that shows the
   *  built-in header (standalone dialog, whole-panel pop-out) gets the same PR
   *  affordance the task-detail embed shows in its surface header. */
  prLink?: { url: string; number: number | null; state: PRState | null | undefined };
  /** Whether the first file-list fetch has settled. Before it has, an empty
   *  list renders skeleton rows rather than the settled "0 files" empty shape
   *  (which would otherwise flash a false negative during the initial load).
   *  Default true so mounts that manage no loading state are unaffected. */
  loaded?: boolean;
  /** Worktree directory, used to resolve a file's absolute path for OS actions. */
  worktreePath?: string;
  /** Project directory, the fallback base when there is no worktree. */
  projectPath?: string;
  /** Fires when the user picks a commit from a file's "View history" popover -
   *  jumps the Changes panel to that file's diff at that commit. */
  onSelectHistoryCommit?: (filePath: string, commit: GitFileHistoryCommit) => void;
  /** When provided, a file row can detach its diff into a dedicated OS window
   *  (double-click, and the context menu's "Open in new window"). Absent for
   *  hosts with no task identity (the command-terminal embed). */
  onOpenInNewWindow?: (filePath: string) => void;
}

const STATUS_CONFIG: Record<GitDiffStatus, { icon: typeof Plus; colorClass: string; label: string }> = {
  A: { icon: Plus, colorClass: 'text-green-400', label: 'Added' },
  M: { icon: Pencil, colorClass: 'text-yellow-400', label: 'Modified' },
  D: { icon: Minus, colorClass: 'text-red-400', label: 'Deleted' },
  R: { icon: ArrowRight, colorClass: 'text-blue-400', label: 'Renamed' },
  C: { icon: Copy, colorClass: 'text-blue-400', label: 'Copied' },
  U: { icon: FileQuestion, colorClass: 'text-green-300', label: 'Untracked' },
};

// Row height in px for the virtualized list
const ROW_HEIGHT = 26;
// Extra rows rendered above/below the viewport for smooth scrolling
const OVERSCAN = 5;

// ---------------------------------------------------------------------------
// Directory tree building
// ---------------------------------------------------------------------------

interface DirectoryNode {
  name: string;
  fullPath: string;
  children: DirectoryNode[];
  files: GitDiffFileEntry[];
}

function buildDirectoryTree(files: GitDiffFileEntry[]): DirectoryNode {
  const root: DirectoryNode = { name: '', fullPath: '', children: [], files: [] };

  for (const file of files) {
    const parts = file.path.split('/');
    let current = root;

    for (let index = 0; index < parts.length - 1; index++) {
      const dirName = parts[index];
      let child = current.children.find((existingChild) => existingChild.name === dirName);
      if (!child) {
        child = {
          name: dirName,
          fullPath: parts.slice(0, index + 1).join('/'),
          children: [],
          files: [],
        };
        current.children.push(child);
      }
      current = child;
    }

    current.files.push(file);
  }

  return compactTree(root);
}

/** Compact single-child directories (like VS Code) */
function compactTree(node: DirectoryNode): DirectoryNode {
  node.children = node.children.map(compactTree);

  while (node.children.length === 1 && node.files.length === 0) {
    const child = node.children[0];
    node.name = node.name ? `${node.name}/${child.name}` : child.name;
    node.fullPath = child.fullPath;
    node.children = child.children;
    node.files = child.files;
  }

  return node;
}

// ---------------------------------------------------------------------------
// File sorting
// ---------------------------------------------------------------------------

// Derived, not restated: a future widening of the config union is then a type
// error here instead of a silently missing sort option.
type FileSortMode = AppConfig['diffFileSort'];

/** The sort menu's options (single-select; the current mode gets a check). */
const SORT_OPTIONS: { value: FileSortMode; label: string }[] = [
  { value: 'name', label: 'Name' },
  { value: 'status', label: 'Status' },
  { value: 'size', label: 'Size' },
  { value: 'ext', label: 'Extension' },
];

// Status grouping order for "by status": additions, then untracked, modified,
// renamed, copied, and deletions last.
const STATUS_SORT_RANK: Record<GitDiffStatus, number> = { A: 0, U: 1, M: 2, R: 3, C: 4, D: 5 };

/** A file's extension for the 'ext' sort ('' for no dot, so extensionless files group first). */
function fileExtension(filePath: string): string {
  const basename = filePath.split('/').pop() ?? filePath;
  const dotIndex = basename.lastIndexOf('.');
  return dotIndex > 0 ? basename.slice(dotIndex + 1).toLowerCase() : '';
}

function compareFiles(a: GitDiffFileEntry, b: GitDiffFileEntry, sort: FileSortMode): number {
  if (sort === 'status') {
    const byStatus = STATUS_SORT_RANK[a.status] - STATUS_SORT_RANK[b.status];
    if (byStatus !== 0) return byStatus;
  } else if (sort === 'size') {
    const bySize = (b.insertions + b.deletions) - (a.insertions + a.deletions); // largest first
    if (bySize !== 0) return bySize;
  } else if (sort === 'ext') {
    const byExtension = fileExtension(a.path).localeCompare(fileExtension(b.path));
    if (byExtension !== 0) return byExtension;
  }
  return a.path.localeCompare(b.path); // name sort, and the tiebreak for the others
}

/** Sort a directory tree in place: files by the chosen mode, directories by name. */
function sortDirectoryTree(node: DirectoryNode, sort: FileSortMode): DirectoryNode {
  node.files.sort((a, b) => compareFiles(a, b, sort));
  node.children.sort((a, b) => a.name.localeCompare(b.name));
  node.children.forEach((child) => sortDirectoryTree(child, sort));
  return node;
}

// ---------------------------------------------------------------------------
// Flatten tree into virtualized rows
// ---------------------------------------------------------------------------

interface FlatDirectoryRow {
  kind: 'directory';
  key: string;
  name: string;
  fullPath: string;
  depth: number;
  hasChildren: boolean;
}

interface FlatFileRow {
  kind: 'file';
  key: string;
  file: GitDiffFileEntry;
  depth: number;
}

/** Status group header (flat mode + status sort only): "Modified (12)" section
 *  rows carrying the scanning value of a status column without table machinery. */
interface FlatGroupRow {
  kind: 'group';
  key: string;
  status: GitDiffStatus;
  count: number;
}

type FlatRow = FlatDirectoryRow | FlatFileRow | FlatGroupRow;

function flattenTree(
  node: DirectoryNode,
  depth: number,
  expandedPaths: Set<string>,
  result: FlatRow[],
): void {
  // Render directory header (skip root which has no name)
  if (node.name) {
    result.push({
      kind: 'directory',
      key: `dir:${node.fullPath}`,
      name: node.name,
      fullPath: node.fullPath,
      depth,
      hasChildren: node.children.length > 0 || node.files.length > 0,
    });

    // If not expanded, skip children
    if (!expandedPaths.has(node.fullPath)) return;
  }

  const childDepth = node.name ? depth + 1 : depth;

  for (const file of node.files) {
    result.push({
      kind: 'file',
      key: `file:${file.path}`,
      file,
      depth: childDepth,
    });
  }

  for (const child of node.children) {
    flattenTree(child, childDepth, expandedPaths, result);
  }
}

// ---------------------------------------------------------------------------
// Memoized row components
// ---------------------------------------------------------------------------

/** Status section header (flat + status sort). GitHub's section-boundary
 *  treatment: the header is a LABEL, not an item - small uppercase muted text
 *  with no leading icon (the icon is what made it read as a file row), a
 *  hairline rule at the section's top edge, and the label bottom-aligned so
 *  the air above it belongs to the boundary. Status color stays on the file
 *  rows below, which keep the interactive styling (hover, selection). */
const GroupRowView = memo(function GroupRowView({ row, first }: { row: FlatGroupRow; first: boolean }) {
  const statusConfig = STATUS_CONFIG[row.status];
  return (
    <div
      className={`flex w-full items-end gap-1.5 px-2 pb-1 select-none ${first ? '' : 'border-t border-edge-subtle'}`}
      style={{ height: ROW_HEIGHT }}
      data-testid="changes-group-row"
      data-status={row.status}
    >
      <span className="text-[11px] font-semibold uppercase tracking-wider leading-none text-fg-faint">
        {statusConfig.label}
      </span>
      <CountBadge count={row.count} variant="muted" size="xs" />
    </div>
  );
});

const DirectoryRowView = memo(function DirectoryRowView({
  row,
  expanded,
  onToggle,
}: {
  row: FlatDirectoryRow;
  expanded: boolean;
  onToggle: (fullPath: string) => void;
}) {
  return (
    <button
      onClick={() => onToggle(row.fullPath)}
      className="flex items-center gap-1 w-full px-2 text-xs text-fg-muted hover:bg-surface-raised/50 transition-colors"
      style={{ paddingLeft: `${row.depth * 12 + 8}px`, height: ROW_HEIGHT }}
    >
      {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
      <span className="font-medium truncate">{row.name}/</span>
    </button>
  );
});

const FileRowView = memo(function FileRowView({
  row,
  isSelected,
  viewed,
  flat,
  onSelect,
  onToggleViewed,
  onContextMenu,
  onOpenInNewWindow,
}: {
  row: FlatFileRow;
  isSelected: boolean;
  viewed: boolean;
  flat: boolean;
  onSelect: (filePath: string) => void;
  onToggleViewed: (filePath: string) => void;
  onContextMenu: (file: GitDiffFileEntry, event: ReactMouseEvent) => void;
  onOpenInNewWindow?: (filePath: string) => void;
}) {
  const statusConfig = STATUS_CONFIG[row.file.status];
  const StatusIcon = statusConfig.icon;
  // Flat mode shows the full repo-relative path (no directory rows for context);
  // tree mode shows just the basename since the directory rows supply the path.
  const displayName = flat ? row.file.path : (row.file.path.split('/').pop() ?? row.file.path);

  return (
    <div
      className={`group flex items-stretch w-full transition-colors ${
        isSelected ? 'bg-accent/15' : 'hover:bg-surface-raised/50'
      }`}
      style={{ height: ROW_HEIGHT }}
      data-testid="changes-file-row"
      data-path={row.file.path}
      data-selected={isSelected}
    >
      <button
        onClick={() => onSelect(row.file.path)}
        // Detach this one file's diff into its own OS window. Both clicks of the
        // double fire onSelect first - selection is idempotent, so that is fine.
        // On the file button only, never the row div (the viewed toggle beside it
        // must not detach).
        onDoubleClick={onOpenInNewWindow ? () => onOpenInNewWindow(row.file.path) : undefined}
        onContextMenu={(event) => onContextMenu(row.file, event)}
        className={`flex items-center gap-1.5 min-w-0 flex-1 px-2 text-xs transition-opacity duration-150 outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent ${
          isSelected ? 'text-fg' : 'text-fg-secondary'
        } ${viewed ? 'opacity-45' : ''}`}
        style={{ paddingLeft: `${row.depth * 12 + 8}px` }}
        title={`${statusConfig.label}: ${row.file.path}`}
      >
        <StatusIcon size={12} className={`flex-shrink-0 ${statusConfig.colorClass}`} />
        <span className="truncate">{displayName}</span>
        {!row.file.binary && (row.file.insertions > 0 || row.file.deletions > 0) && (
          // Right-aligned into a fixed-min-width tabular column so the numbers
          // stack scannably down the list (table feel, no table machinery).
          <span className="ml-auto flex-shrink-0 flex items-center justify-end gap-1 min-w-[52px] text-[11px] tabular-nums">
            {row.file.insertions > 0 && <span className="text-green-400">+{row.file.insertions}</span>}
            {row.file.deletions > 0 && <span className="text-red-400">-{row.file.deletions}</span>}
          </span>
        )}
      </button>
      {/* "Viewed" toggle: a reviewed file's row dims. Always visible (not
          hover-only) so the review state is discoverable; subtle until checked. */}
      <button
        type="button"
        onClick={() => onToggleViewed(row.file.path)}
        title={viewed ? 'Mark as not viewed' : 'Mark as viewed'}
        aria-pressed={viewed}
        data-testid="changes-viewed-toggle"
        data-path={row.file.path}
        className="flex-shrink-0 flex items-center px-2"
      >
        <span
          className={`flex items-center justify-center w-3.5 h-3.5 rounded border transition-colors ${
            viewed
              ? 'bg-accent-emphasis border-accent-emphasis text-accent-on'
              : 'border-edge-input text-transparent group-hover:border-fg-muted'
          }`}
        >
          <Check size={10} strokeWidth={3} />
        </span>
      </button>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Virtualized file tree
// ---------------------------------------------------------------------------

function VirtualizedFileTree({
  files,
  selectedFile,
  viewedFiles,
  sort,
  flat,
  expansionCommand,
  onSelect,
  onToggleViewed,
  onContextMenu,
  onOpenInNewWindow,
  defaultExpanded,
}: {
  files: GitDiffFileEntry[];
  selectedFile: string | null;
  viewedFiles: Set<string>;
  sort: FileSortMode;
  flat: boolean;
  /** Bump `nonce` to expand (expand: true) or collapse (false) every directory. */
  expansionCommand: { expand: boolean; nonce: number };
  onSelect: (filePath: string) => void;
  onToggleViewed: (filePath: string) => void;
  onContextMenu: (file: GitDiffFileEntry, event: ReactMouseEvent) => void;
  onOpenInNewWindow?: (filePath: string) => void;
  defaultExpanded: boolean;
}) {
  const tree = useMemo(() => sortDirectoryTree(buildDirectoryTree(files), sort), [files, sort]);

  // Collect all directory paths for default expansion
  const allDirectoryPaths = useMemo(() => {
    const paths = new Set<string>();
    function collect(node: DirectoryNode) {
      if (node.fullPath) paths.add(node.fullPath);
      node.children.forEach(collect);
    }
    collect(tree);
    return paths;
  }, [tree]);

  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    () => defaultExpanded ? new Set(allDirectoryPaths) : new Set<string>(),
  );

  // Expand new directories when the tree changes (new files added by the agent)
  useEffect(() => {
    if (defaultExpanded) {
      setExpandedPaths((previous) => {
        const merged = new Set(previous);
        let changed = false;
        for (const directoryPath of allDirectoryPaths) {
          if (!merged.has(directoryPath)) {
            merged.add(directoryPath);
            changed = true;
          }
        }
        return changed ? merged : previous;
      });
    }
  }, [allDirectoryPaths, defaultExpanded]);

  // Collapse-all / expand-all: apply when the command nonce changes (not on mount,
  // and not on an unrelated allDirectoryPaths change).
  const expansionNonceRef = useRef(expansionCommand.nonce);
  useEffect(() => {
    if (expansionCommand.nonce === expansionNonceRef.current) return;
    expansionNonceRef.current = expansionCommand.nonce;
    setExpandedPaths(expansionCommand.expand ? new Set(allDirectoryPaths) : new Set<string>());
  }, [expansionCommand, allDirectoryPaths]);

  const toggleDirectory = useCallback((fullPath: string) => {
    setExpandedPaths((previous) => {
      const next = new Set(previous);
      if (next.has(fullPath)) {
        next.delete(fullPath);
      } else {
        next.add(fullPath);
      }
      return next;
    });
  }, []);

  const flatRows = useMemo(() => {
    if (flat) {
      const sorted = [...files].sort((a, b) => compareFiles(a, b, sort));
      // Flat + status sort: interleave "Modified (12)"-style group headers at
      // each status boundary - the scanning value of TortoiseGit's status
      // column without a table.
      if (sort === 'status') {
        const grouped: FlatRow[] = [];
        let lastStatus: GitDiffStatus | null = null;
        for (const file of sorted) {
          if (file.status !== lastStatus) {
            lastStatus = file.status;
            grouped.push({
              kind: 'group',
              key: `group:${file.status}`,
              status: file.status,
              count: sorted.filter((candidate) => candidate.status === file.status).length,
            });
          }
          grouped.push({ kind: 'file', key: `file:${file.path}`, file, depth: 0 });
        }
        return grouped;
      }
      return sorted.map((file): FlatRow => ({ kind: 'file', key: `file:${file.path}`, file, depth: 0 }));
    }
    const result: FlatRow[] = [];
    flattenTree(tree, 0, expandedPaths, result);
    return result;
  }, [flat, files, sort, tree, expandedPaths]);

  // Virtualization state
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);

  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) return;

    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setContainerHeight(entry.contentRect.height);
      }
    });
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  const handleScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (container) setScrollTop(container.scrollTop);
  }, []);

  // Calculate visible range with overscan
  const totalHeight = flatRows.length * ROW_HEIGHT;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const endIndex = Math.min(flatRows.length, Math.ceil((scrollTop + containerHeight) / ROW_HEIGHT) + OVERSCAN);
  const visibleRows = flatRows.slice(startIndex, endIndex);

  return (
    <div
      ref={scrollContainerRef}
      className="flex-1 overflow-y-auto"
      onScroll={handleScroll}
    >
      <div style={{ height: totalHeight, position: 'relative' }}>
        <div style={{ position: 'absolute', top: startIndex * ROW_HEIGHT, left: 0, right: 0 }}>
          {visibleRows.map((row, index) =>
            row.kind === 'directory' ? (
              <DirectoryRowView
                key={row.key}
                row={row}
                expanded={expandedPaths.has(row.fullPath)}
                onToggle={toggleDirectory}
              />
            ) : row.kind === 'group' ? (
              <GroupRowView key={row.key} row={row} first={startIndex + index === 0} />
            ) : (
              <FileRowView
                key={row.key}
                row={row}
                isSelected={selectedFile === row.file.path}
                viewed={viewedFiles.has(row.file.path)}
                flat={flat}
                onSelect={onSelect}
                onToggleViewed={onToggleViewed}
                onContextMenu={onContextMenu}
                onOpenInNewWindow={onOpenInNewWindow}
              />
            ),
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// File context menu
// ---------------------------------------------------------------------------

interface FileContextMenuState {
  file: GitDiffFileEntry;
  x: number;
  y: number;
}

/** Right-click menu for a changed file: open in the OS default app, reveal in
 *  the file manager, copy the repo-relative path, or detach the file's diff
 *  into its own OS window. Positioned at the cursor, clamped to the viewport;
 *  closes on outside click or Escape. */
function FileContextMenu({
  state,
  worktreePath,
  projectPath,
  onOpenInNewWindow,
  onViewHistory,
  onClose,
}: {
  state: FileContextMenuState;
  worktreePath?: string;
  projectPath?: string;
  onOpenInNewWindow?: () => void;
  onViewHistory?: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const { file } = state;

  useEffect(() => {
    const handleClick = (event: globalThis.MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) onClose();
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClick, true);
    document.addEventListener('keydown', handleEscape, true);
    return () => {
      document.removeEventListener('mousedown', handleClick, true);
      document.removeEventListener('keydown', handleEscape, true);
    };
  }, [onClose]);

  // git paths use '/'; the main process normalizes separators for the OS.
  const base = worktreePath ?? projectPath;
  const absolutePath = base ? `${base}/${file.path}` : file.path;
  // A deleted file no longer exists on disk, so open / reveal are unavailable.
  const existsOnDisk = base !== undefined && file.status !== 'D';

  const menuStyle: CSSProperties = {
    left: Math.min(state.x, window.innerWidth - 220),
    top: Math.min(state.y, window.innerHeight - 200),
  };

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-surface-raised border border-edge rounded-lg shadow-xl py-1 min-w-[200px] overlay-popover-in"
      style={{ ...menuStyle, transformOrigin: 'top left' }}
      data-dismissable-layer
      data-testid="changes-file-context-menu"
    >
      <button
        type="button"
        disabled={!existsOnDisk}
        onClick={() => { window.electronAPI.shell.openPath(absolutePath); onClose(); }}
        className="w-full px-3 py-1.5 text-sm text-fg-secondary text-left hover:bg-surface-hover/40 disabled:opacity-40 disabled:hover:bg-transparent flex items-center gap-2"
        data-testid="context-open-file"
      >
        <ExternalLink size={14} className="text-fg-faint" />
        Open in editor
      </button>
      <button
        type="button"
        disabled={!existsOnDisk}
        onClick={() => { window.electronAPI.shell.showItemInFolder(absolutePath); onClose(); }}
        className="w-full px-3 py-1.5 text-sm text-fg-secondary text-left hover:bg-surface-hover/40 disabled:opacity-40 disabled:hover:bg-transparent flex items-center gap-2"
        data-testid="context-reveal-file"
      >
        <FolderOpen size={14} className="text-fg-faint" />
        Reveal in file manager
      </button>
      <button
        type="button"
        onClick={() => {
          navigator.clipboard.writeText(file.path);
          useToastStore.getState().addToast({ message: 'Copied file path' });
          onClose();
        }}
        className="w-full px-3 py-1.5 text-sm text-fg-secondary text-left hover:bg-surface-hover/40 flex items-center gap-2"
        data-testid="context-copy-path"
      >
        <Copy size={14} className="text-fg-faint" />
        Copy path
      </button>
      {onOpenInNewWindow && (
        <button
          type="button"
          onClick={onOpenInNewWindow}
          className="w-full px-3 py-1.5 text-sm text-fg-secondary text-left hover:bg-surface-hover/40 flex items-center gap-2"
          data-testid="context-open-new-window"
        >
          <AppWindow size={14} className="text-fg-faint" />
          Open in new window
        </button>
      )}
      {onViewHistory && (
        <button
          type="button"
          onClick={onViewHistory}
          className="w-full px-3 py-1.5 text-sm text-fg-secondary text-left hover:bg-surface-hover/40 flex items-center gap-2"
          data-testid="context-file-history"
        >
          <History size={14} className="text-fg-faint" />
          View history
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// File history popover
// ---------------------------------------------------------------------------

interface FileHistoryPopoverState {
  file: GitDiffFileEntry;
  x: number;
  y: number;
}

/** Per-file commit history popover, triggered from the file context menu's
 *  "View history" item. Fetches directly (mirrors CommitGraphPanel's own
 *  fetch, since this is a lazily-triggered, self-contained widget rather than
 *  part of the panel's main render-loop data flow). Selecting a row jumps the
 *  Changes panel to that file's diff at that commit. */
function FileHistoryPopover({
  state,
  worktreePath,
  projectPath,
  onSelectCommit,
  onClose,
}: {
  state: FileHistoryPopoverState;
  worktreePath?: string;
  projectPath?: string;
  onSelectCommit: (commit: GitFileHistoryCommit) => void;
  onClose: () => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [commits, setCommits] = useState<GitFileHistoryCommit[] | null>(null);
  const { file } = state;

  useEffect(() => {
    let cancelled = false;
    setCommits(null);
    window.electronAPI.git.fileHistory({ worktreePath, projectPath: projectPath ?? '', filePath: file.path })
      .then((result) => {
        if (!cancelled) setCommits(result.commits);
      })
      .catch(() => {
        if (!cancelled) setCommits([]);
      });
    return () => {
      cancelled = true;
    };
  }, [file.path, worktreePath, projectPath]);

  useEffect(() => {
    const handleClick = (event: globalThis.MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(event.target as Node)) onClose();
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', handleClick, true);
    document.addEventListener('keydown', handleEscape, true);
    return () => {
      document.removeEventListener('mousedown', handleClick, true);
      document.removeEventListener('keydown', handleEscape, true);
    };
  }, [onClose]);

  const popoverStyle: CSSProperties = {
    left: Math.min(state.x, window.innerWidth - 280),
    top: Math.min(state.y, window.innerHeight - 320),
  };

  return (
    <div
      ref={popoverRef}
      className="fixed z-50 bg-surface-raised border border-edge rounded-lg shadow-xl py-1 w-[280px] max-h-80 overflow-y-auto overlay-popover-in"
      style={{ ...popoverStyle, transformOrigin: 'top left' }}
      data-dismissable-layer
      data-testid="changes-file-history"
    >
      <div
        className="px-3 py-1.5 text-[11px] font-medium text-fg-faint truncate border-b border-edge-subtle"
        title={file.path}
      >
        History: {file.path.split('/').pop() ?? file.path}
      </div>
      {commits === null ? (
        <div className="flex items-center justify-center py-4">
          <Loader2 size={14} className="animate-spin text-fg-faint" />
        </div>
      ) : commits.length === 0 ? (
        <div className="px-3 py-3 text-xs text-fg-disabled text-center">No history found</div>
      ) : (
        commits.map((commit) => (
          <button
            key={commit.hash}
            type="button"
            onClick={() => onSelectCommit(commit)}
            className="w-full px-3 py-1.5 text-left hover:bg-surface-hover/40 transition-colors"
            data-testid="changes-file-history-row"
          >
            <div className="flex items-center gap-2">
              <span className="font-mono text-[11px] text-fg-faint flex-shrink-0">{commit.shortHash}</span>
              <span className="truncate text-xs text-fg">{commit.subject}</span>
            </div>
            <div className="text-[11px] text-fg-faint truncate">
              {commit.authorName}
              {commit.authorTimestamp && ` · ${formatRelativeTime(commit.authorTimestamp)}`}
            </div>
          </button>
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Branch header
// ---------------------------------------------------------------------------

/**
 * Current branch, ahead/behind vs base, and the tip commit. The panel refreshes
 * automatically (working-tree + git-metadata watch), so there is no manual button.
 */
function BranchHeader({
  branchSummary,
  baseLabel,
  baseLabelCustom,
  prLink,
}: {
  branchSummary?: GitBranchSummaryResult | null;
  baseLabel?: string;
  baseLabelCustom?: boolean;
  prLink?: { url: string; number: number | null; state: PRState | null | undefined };
}) {
  const branch = branchSummary?.currentBranch;
  const ahead = branchSummary?.ahead ?? 0;
  const behind = branchSummary?.behind ?? 0;
  const lastCommit = branchSummary?.lastCommit ?? null;

  // Nothing useful to show - render nothing.
  if (!branch && !lastCommit) return null;

  return (
    <div className="border-b border-edge flex-shrink-0">
      <div className="flex items-center gap-1.5 px-3 py-2 text-xs">
        <GitBranch size={12} className="text-fg-muted flex-shrink-0" />
        <span className="text-fg-secondary font-medium truncate" title={branch ?? undefined} data-testid="changes-branch-name">
          {branch ?? 'Detached HEAD'}
        </span>
        {baseLabel && (
          <span
            className={`shrink-0 rounded border px-1 py-px text-[11px] font-medium leading-none truncate ${
              baseLabelCustom ? 'border-accent/50 text-accent-fg' : 'border-edge-subtle text-fg-faint'
            }`}
            data-testid="changes-base-label"
            title={baseLabelCustom ? `Based on ${baseLabel}, not the project default` : `Based on ${baseLabel}, the project default`}
          >
            {baseLabel}
          </span>
        )}
        {(ahead > 0 || behind > 0) && (
          <span className="flex items-center gap-1.5 text-fg-muted flex-shrink-0" title={`${ahead} ahead, ${behind} behind base branch`}>
            {ahead > 0 && (
              <span className="flex items-center gap-0.5 tabular-nums">
                <ArrowUp size={11} className="text-green-400" />
                {ahead}
              </span>
            )}
            {behind > 0 && (
              <span className="flex items-center gap-0.5 tabular-nums">
                <ArrowDown size={11} className="text-red-400" />
                {behind}
              </span>
            )}
          </span>
        )}
        {prLink && (
          <PrLink prUrl={prLink.url} prNumber={prLink.number} prState={prLink.state} testId="changes-pr-link" className="shrink-0" />
        )}
      </div>
      {lastCommit && (
        <div
          className="px-3 pb-2 -mt-1 text-[11px] text-fg-muted truncate"
          title={`${lastCommit.hash} ${lastCommit.subject}`}
          data-testid="changes-last-commit"
        >
          <span className="font-mono text-fg-faint">{lastCommit.hash}</span>{' '}
          {lastCommit.subject}
          {lastCommit.timestamp && <span className="text-fg-faint"> {'·'} {formatRelativeTime(lastCommit.timestamp)}</span>}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main panel
// ---------------------------------------------------------------------------

export function FileTreePanel({
  files,
  selectedFile,
  onSelect,
  totalInsertions,
  totalDeletions,
  branchSummary,
  showBranchHeader = true,
  viewedFiles,
  onToggleViewed,
  scope,
  onScopeChange,
  baseLabel,
  baseLabelCustom,
  prLink,
  loaded = true,
  worktreePath,
  projectPath,
  onSelectHistoryCommit,
  onOpenInNewWindow,
}: FileTreePanelProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [contextMenu, setContextMenu] = useState<FileContextMenuState | null>(null);
  const [historyPopover, setHistoryPopover] = useState<FileHistoryPopoverState | null>(null);

  const sort = useConfigStore((state) => state.config.diffFileSort);
  const flat = useConfigStore((state) => state.config.diffFlatList);
  const updateConfig = useConfigStore((state) => state.updateConfig);

  // Sort mode menu (replaces the old blind 3-cycle button: a 4-mode cycle with
  // no visible state was unlearnable). Portal + fixed per
  // .claude/rules/popover-escapes-clipping.md - the rail is an overflow-hidden
  // column, so an in-flow menu would clip.
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const sortButtonRef = useRef<HTMLDivElement>(null);
  const sortMenuRef = useRef<HTMLDivElement>(null);
  const { style: sortMenuStyle, placement: sortMenuPlacement } = usePopoverPosition(
    sortButtonRef,
    sortMenuRef,
    sortMenuOpen,
    { mode: 'dropdown', strategy: 'fixed', preferRight: false },
  );
  useEffect(() => {
    if (!sortMenuOpen) return;
    // The menu is portaled OUT of the trigger's subtree, so a click inside it
    // must also count as "inside" (capture phase to beat scroll containers).
    const handleClickOutside = (event: PointerEvent) => {
      if (
        sortButtonRef.current && !sortButtonRef.current.contains(event.target as Node) &&
        (!sortMenuRef.current || !sortMenuRef.current.contains(event.target as Node))
      ) {
        setSortMenuOpen(false);
      }
    };
    // Escape closes the MENU, not the window behind it. The host dialog /
    // pop-out dismisses itself on a bubble-phase document Escape, so without
    // this capture-phase intercept the first Escape over an open menu also
    // closes the user's whole task window. Same guard KebabMenu carries.
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setSortMenuOpen(false);
    };
    document.addEventListener('pointerdown', handleClickOutside, true);
    document.addEventListener('keydown', handleEscape, true);
    return () => {
      document.removeEventListener('pointerdown', handleClickOutside, true);
      document.removeEventListener('keydown', handleEscape, true);
    };
  }, [sortMenuOpen]);

  // Collapse-all / expand-all command for the tree. `expand` is the last-applied
  // direction (drives the button icon); bumping `nonce` re-applies it.
  const [expansion, setExpansion] = useState({ expand: true, nonce: 0 });
  const toggleCollapseAll = useCallback(() => {
    setExpansion((previous) => ({ expand: !previous.expand, nonce: previous.nonce + 1 }));
  }, []);

  const viewedCount = useMemo(
    () => files.reduce((count, file) => (viewedFiles.has(file.path) ? count + 1 : count), 0),
    [files, viewedFiles],
  );

  const filteredFiles = useMemo(() => {
    if (!searchQuery) return files;
    const query = searchQuery.toLowerCase();
    return files.filter((file) => file.path.toLowerCase().includes(query));
  }, [files, searchQuery]);

  const handleFileContextMenu = useCallback((file: GitDiffFileEntry, event: ReactMouseEvent) => {
    event.preventDefault();
    setContextMenu({ file, x: event.clientX, y: event.clientY });
  }, []);

  const handleViewHistory = useCallback(() => {
    if (!contextMenu) return;
    setHistoryPopover({ file: contextMenu.file, x: contextMenu.x, y: contextMenu.y });
    setContextMenu(null);
  }, [contextMenu]);

  return (
    <div className="flex flex-col h-full" data-testid="changes-file-tree">
      {/* Branch context + refresh. Suppressed in the task-detail embed, where the
          shared surface header owns this context (see showBranchHeader). */}
      {showBranchHeader && (
        <BranchHeader branchSummary={branchSummary} baseLabel={baseLabel} baseLabelCustom={baseLabelCustom} prLink={prLink} />
      )}

      {/* Diff scope: working changes / staged / full branch. A segmented control
          (single-select among 3 fixed options) rather than a dropdown. */}
      {scope && onScopeChange && (
        <div className="px-2 py-1.5 border-b border-edge flex-shrink-0">
          <div
            role="radiogroup"
            aria-label="Diff scope"
            data-testid="changes-scope-select"
            className="flex gap-0.5 rounded border border-edge-input bg-surface-hover p-0.5"
          >
            {SCOPE_OPTIONS.map((option) => {
              const active = scope === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  onClick={() => onScopeChange(option.value)}
                  data-testid={`changes-scope-${option.value}`}
                  className={`flex-1 rounded px-2 py-1 text-xs transition-colors ${
                    active
                      ? 'bg-accent-emphasis text-accent-on font-medium'
                      : 'text-fg-muted hover:text-fg hover:bg-surface-raised/60'
                  }`}
                >
                  {option.label}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* List header: file count + view controls (sort, tree/flat, collapse-all),
          right-aligned. The filter search gets its own full-width row below. A
          2px review-progress fill rides the header's bottom edge, growing with
          the viewed count (its width transition is the live feedback; a restore
          paints once at the final width, so nothing replays). */}
      {/* Small-layout discipline: this row must hold ONE line at the rail's
          220px minimum - every text span is nowrap, the counts are compact
          numerals with the full sentences in tooltips, and the row clips
          (overflow-hidden) rather than wraps if extreme numbers exceed it.
          Rhythm: the +/- diffstat is a tight PAIR (gap-1, like the file rows)
          set off from the file count by the row gap, so the cluster reads as
          "count, then stats" instead of one condensed token string. */}
      <div
        className="relative flex items-center gap-2 overflow-hidden px-2 py-1.5 border-b border-edge text-xs text-fg-muted flex-shrink-0"
        data-testid="changes-list-header"
      >
        <span className="whitespace-nowrap">{files.length} file{files.length !== 1 ? 's' : ''}</span>
        {(totalInsertions > 0 || totalDeletions > 0) && (
          <span className="flex items-center gap-1 whitespace-nowrap tabular-nums">
            {totalInsertions > 0 && <span className="text-green-400">+{totalInsertions}</span>}
            {totalDeletions > 0 && <span className="text-red-400">-{totalDeletions}</span>}
          </span>
        )}
        {/* Full-width bar scaled from its left edge, rather than a width
            transition: Chromium composites only transform and opacity, so a
            width animation stops producing frames for exactly as long as the
            renderer's main thread is blocked - which, beside a live agent, is
            often. Same reasoning as the activity marks. */}
        {viewedCount > 0 && (
          <span
            aria-hidden
            data-testid="changes-viewed-progress"
            className="absolute left-0 bottom-0 h-[2px] w-full origin-left bg-accent/60 transition-transform duration-300 motion-reduce:transition-none"
            style={{ transform: `scaleX(${viewedCount / Math.max(files.length, 1)})` }}
          />
        )}
        <div className="ml-auto flex items-center gap-1.5">
          {files.length > 0 && (
            // Always visible once there are files (0/n included), so the
            // review-marks feature is discoverable before the first mark.
            // Bare n/m - the word lives in the tooltip; the rail cannot
            // afford it at 220px (matches the surface header's chip).
            <span
              className="flex items-center gap-1 whitespace-nowrap text-fg-faint tabular-nums"
              data-testid="changes-viewed-count"
              title={`${viewedCount} of ${files.length} files viewed`}
            >
              <Check
                size={11}
                className={
                  viewedCount === 0
                    ? 'text-fg-disabled' // nothing reviewed yet: the chip is a label, not a signal
                    : viewedCount === files.length
                      ? 'text-green-400'
                      : 'text-accent'
                }
              />
              {viewedCount}/{files.length}
            </span>
          )}
          <div className="flex items-center gap-0.5">
            <button
              type="button"
              onClick={() => updateConfig({ diffFlatList: !flat })}
              title={flat ? 'Flat list (switch to tree)' : 'Tree view (switch to flat list)'}
              aria-label={flat ? 'Flat list' : 'Tree view'}
              data-testid="changes-tree-flat"
              data-flat={flat}
              className="flex-shrink-0 p-1 rounded text-fg-muted hover:text-fg hover:bg-surface-hover transition-colors"
            >
              {flat ? <List size={14} /> : <ListTree size={14} />}
            </button>
            {/* Always rendered (disabled in flat mode, where there are no
                directories) so toggling tree/flat never shifts the other buttons. */}
            <button
              type="button"
              onClick={toggleCollapseAll}
              disabled={flat}
              title={flat ? 'Collapse / expand all (tree view only)' : expansion.expand ? 'Collapse all' : 'Expand all'}
              aria-label={expansion.expand ? 'Collapse all' : 'Expand all'}
              data-testid="changes-collapse-all"
              className="flex-shrink-0 p-1 rounded text-fg-muted hover:text-fg hover:bg-surface-hover transition-colors disabled:opacity-30 disabled:cursor-default disabled:hover:bg-transparent disabled:hover:text-fg-muted"
            >
              {expansion.expand ? <FoldVertical size={14} /> : <UnfoldVertical size={14} />}
            </button>
          </div>
        </div>
      </div>

      {/* Filter + sort: querying / ordering the list, grouped in one control. */}
      <div className="px-2 py-1.5 border-b border-edge flex-shrink-0">
        <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-surface text-xs">
          <Search size={12} className="text-fg-muted flex-shrink-0" />
          <input
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Filter files..."
            className="bg-transparent outline-none flex-1 min-w-0 text-fg placeholder:text-fg-disabled"
          />
          <div ref={sortButtonRef} className="flex-shrink-0 -mr-1">
            <button
              type="button"
              onClick={() => setSortMenuOpen((open) => !open)}
              title={`Sort: by ${SORT_OPTIONS.find((option) => option.value === sort)?.label.toLowerCase() ?? sort}`}
              aria-label={`Sort: by ${sort}`}
              aria-expanded={sortMenuOpen}
              data-testid="changes-sort"
              className={`p-1 rounded transition-colors ${sortMenuOpen ? 'bg-surface-hover text-fg' : 'text-fg-muted hover:text-fg hover:bg-surface-hover'}`}
            >
              <ArrowDownUp size={14} />
            </button>
            <OverlayPopover
              open={sortMenuOpen}
              popoverRef={sortMenuRef}
              style={sortMenuStyle}
              portal
              transformOrigin={sortMenuPlacement.vertical === 'above' ? 'bottom center' : 'top center'}
              className="fixed z-[2147483646] min-w-[160px] rounded-md border border-edge bg-surface-raised py-1 shadow-lg"
              role="menu"
              data-testid="changes-sort-menu"
            >
              {SORT_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={sort === option.value}
                  onClick={() => {
                    updateConfig({ diffFileSort: option.value });
                    setSortMenuOpen(false);
                  }}
                  data-testid={`changes-sort-option-${option.value}`}
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-fg-secondary hover:bg-surface-hover hover:text-fg transition-colors"
                >
                  <span className="flex w-3.5 items-center justify-center">
                    {sort === option.value && <Check size={12} className="text-accent" />}
                  </span>
                  {option.label}
                </button>
              ))}
            </OverlayPopover>
          </div>
        </div>
      </div>

      {/* File tree */}
      {!loaded && files.length === 0 ? (
        // Initial fetch in flight: pulse rows, never a premature "No changes
        // found" (the false negative this branch exists to prevent).
        <div className="flex-1 p-2 space-y-1.5" data-testid="changes-file-tree-skeleton">
          {Array.from({ length: 4 }, (_, index) => (
            <div key={index} className="h-4 rounded bg-surface-hover animate-pulse" style={{ opacity: 1 - index * 0.15 }} />
          ))}
        </div>
      ) : filteredFiles.length === 0 ? (
        files.length === 0 ? (
          // An empty diff is ONE fact, so it gets ONE sentence. The list
          // header above already reads "0 files", and the diff pane carries
          // the surface's "No changes to review"; a third statement here just
          // printed the same nothing twice, side by side. The spacer keeps the
          // rail's shape so History stays pinned to the bottom.
          <div className="flex-1" />
        ) : (
          // The filter matching nothing IS the rail's own fact - the file set
          // is not empty, this view of it is - so the rail states that itself.
          <div className="flex-1 flex flex-col items-center justify-center gap-2 p-4 text-center">
            <Search size={22} className="text-fg-disabled" />
            <span className="text-sm text-fg-muted">No matching files</span>
          </div>
        )
      ) : (
        <VirtualizedFileTree
          files={filteredFiles}
          selectedFile={selectedFile}
          viewedFiles={viewedFiles}
          sort={sort}
          flat={flat}
          expansionCommand={expansion}
          onSelect={onSelect}
          onToggleViewed={onToggleViewed}
          onContextMenu={handleFileContextMenu}
          onOpenInNewWindow={onOpenInNewWindow}
          defaultExpanded
        />
      )}

      {contextMenu && (
        <FileContextMenu
          state={contextMenu}
          worktreePath={worktreePath}
          projectPath={projectPath}
          onOpenInNewWindow={onOpenInNewWindow ? () => { onOpenInNewWindow(contextMenu.file.path); setContextMenu(null); } : undefined}
          onViewHistory={onSelectHistoryCommit ? handleViewHistory : undefined}
          onClose={() => setContextMenu(null)}
        />
      )}

      {historyPopover && onSelectHistoryCommit && (
        <FileHistoryPopover
          state={historyPopover}
          worktreePath={worktreePath}
          projectPath={projectPath}
          onSelectCommit={(commit) => {
            onSelectHistoryCommit(historyPopover.file.path, commit);
            setHistoryPopover(null);
          }}
          onClose={() => setHistoryPopover(null)}
        />
      )}
    </div>
  );
}

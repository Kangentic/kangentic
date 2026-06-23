import { useMemo, useState, useRef, useCallback, useEffect, memo, type CSSProperties, type MouseEvent as ReactMouseEvent } from 'react';
import { Search, Plus, Pencil, Minus, ArrowRight, Copy, ChevronRight, ChevronDown, FileQuestion, GitBranch, ArrowUp, ArrowDown, FolderOpen, ExternalLink } from 'lucide-react';
import type { GitBranchSummaryResult, GitDiffFileEntry, GitDiffScope, GitDiffStatus } from '../../../../../shared/types';
import { formatRelativeTime } from '../../../../lib/datetime';
import { useToastStore } from '../../../../stores/toast-store';

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
  /** Current diff scope (working / staged / branch). */
  scope?: GitDiffScope;
  /** Change the diff scope. */
  onScopeChange?: (scope: GitDiffScope) => void;
  /** Worktree directory, used to resolve a file's absolute path for OS actions. */
  worktreePath?: string;
  /** Project directory, the fallback base when there is no worktree. */
  projectPath?: string;
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

type FlatRow = FlatDirectoryRow | FlatFileRow;

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
  onSelect,
  onContextMenu,
}: {
  row: FlatFileRow;
  isSelected: boolean;
  onSelect: (filePath: string) => void;
  onContextMenu: (file: GitDiffFileEntry, event: ReactMouseEvent) => void;
}) {
  const statusConfig = STATUS_CONFIG[row.file.status];
  const StatusIcon = statusConfig.icon;
  const fileName = row.file.path.split('/').pop() ?? row.file.path;

  return (
    <button
      onClick={() => onSelect(row.file.path)}
      onContextMenu={(event) => onContextMenu(row.file, event)}
      className={`flex items-center gap-1.5 w-full px-2 text-xs transition-colors ${
        isSelected ? 'bg-accent/15 text-fg' : 'text-fg-secondary hover:bg-surface-raised/50'
      }`}
      style={{ paddingLeft: `${row.depth * 12 + 8}px`, height: ROW_HEIGHT }}
      title={`${statusConfig.label}: ${row.file.path}`}
    >
      <StatusIcon size={12} className={`flex-shrink-0 ${statusConfig.colorClass}`} />
      <span className="truncate">{fileName}</span>
      {!row.file.binary && (row.file.insertions > 0 || row.file.deletions > 0) && (
        <span className="ml-auto flex-shrink-0 flex items-center gap-1 text-[11px]">
          {row.file.insertions > 0 && <span className="text-green-400">+{row.file.insertions}</span>}
          {row.file.deletions > 0 && <span className="text-red-400">-{row.file.deletions}</span>}
        </span>
      )}
    </button>
  );
});

// ---------------------------------------------------------------------------
// Virtualized file tree
// ---------------------------------------------------------------------------

function VirtualizedFileTree({
  files,
  selectedFile,
  onSelect,
  onContextMenu,
  defaultExpanded,
}: {
  files: GitDiffFileEntry[];
  selectedFile: string | null;
  onSelect: (filePath: string) => void;
  onContextMenu: (file: GitDiffFileEntry, event: ReactMouseEvent) => void;
  defaultExpanded: boolean;
}) {
  const tree = useMemo(() => buildDirectoryTree(files), [files]);

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
    const result: FlatRow[] = [];
    flattenTree(tree, 0, expandedPaths, result);
    return result;
  }, [tree, expandedPaths]);

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
          {visibleRows.map((row) =>
            row.kind === 'directory' ? (
              <DirectoryRowView
                key={row.key}
                row={row}
                expanded={expandedPaths.has(row.fullPath)}
                onToggle={toggleDirectory}
              />
            ) : (
              <FileRowView
                key={row.key}
                row={row}
                isSelected={selectedFile === row.file.path}
                onSelect={onSelect}
                onContextMenu={onContextMenu}
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
 *  the file manager, or copy the repo-relative path. Positioned at the cursor,
 *  clamped to the viewport; closes on outside click or Escape. */
function FileContextMenu({
  state,
  worktreePath,
  projectPath,
  onClose,
}: {
  state: FileContextMenuState;
  worktreePath?: string;
  projectPath?: string;
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
    top: Math.min(state.y, window.innerHeight - 160),
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
function BranchHeader({ branchSummary }: { branchSummary?: GitBranchSummaryResult | null }) {
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
  scope,
  onScopeChange,
  worktreePath,
  projectPath,
}: FileTreePanelProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [contextMenu, setContextMenu] = useState<FileContextMenuState | null>(null);

  const filteredFiles = useMemo(() => {
    if (!searchQuery) return files;
    const query = searchQuery.toLowerCase();
    return files.filter((file) => file.path.toLowerCase().includes(query));
  }, [files, searchQuery]);

  const handleFileContextMenu = useCallback((file: GitDiffFileEntry, event: ReactMouseEvent) => {
    event.preventDefault();
    setContextMenu({ file, x: event.clientX, y: event.clientY });
  }, []);

  return (
    <div className="flex flex-col h-full" data-testid="changes-file-tree">
      {/* Branch context + refresh */}
      <BranchHeader branchSummary={branchSummary} />

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

      {/* Stats bar */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-edge text-xs text-fg-muted flex-shrink-0">
        <span>{files.length} file{files.length !== 1 ? 's' : ''}</span>
        {totalInsertions > 0 && <span className="text-green-400">+{totalInsertions}</span>}
        {totalDeletions > 0 && <span className="text-red-400">-{totalDeletions}</span>}
      </div>

      {/* Search */}
      <div className="px-2 py-1.5 border-b border-edge flex-shrink-0">
        <div className="flex items-center gap-1.5 px-2 py-1 rounded bg-surface text-xs">
          <Search size={12} className="text-fg-muted flex-shrink-0" />
          <input
            type="text"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder="Filter files..."
            className="bg-transparent outline-none flex-1 text-fg placeholder:text-fg-disabled"
          />
        </div>
      </div>

      {/* File tree */}
      {filteredFiles.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-xs text-fg-disabled p-4">
          {files.length === 0 ? 'No changes found' : 'No matching files'}
        </div>
      ) : (
        <VirtualizedFileTree
          files={filteredFiles}
          selectedFile={selectedFile}
          onSelect={onSelect}
          onContextMenu={handleFileContextMenu}
          defaultExpanded
        />
      )}

      {contextMenu && (
        <FileContextMenu
          state={contextMenu}
          worktreePath={worktreePath}
          projectPath={projectPath}
          onClose={() => setContextMenu(null)}
        />
      )}
    </div>
  );
}

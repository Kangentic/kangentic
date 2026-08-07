import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Search, X, Loader2, Archive, MessageSquare, Terminal, History, Sparkles } from 'lucide-react';
import { useProjectStore } from '../../stores/project-store';
import { useSessionStore } from '../../stores/session-store';
import { useBoardStore } from '../../stores/board-store';
import { useBacklogStore } from '../../stores/backlog-store';
import { useConfigStore } from '../../stores/config-store';
import { useToastStore } from '../../stores/toast-store';
import { formatRelativeTime } from '../../lib/datetime';
import { useOverlayPhase } from '../../hooks/useOverlayPhase';
import type { SearchHit, SearchHitKind, MemoryStatus } from '../../../shared/types';

const SEARCH_DEBOUNCE_MS = 200;
/** Smart mode embeds the query before searching, which is costlier than the
 *  lexical path, so it waits a little longer before firing. */
const SMART_SEARCH_DEBOUNCE_MS = 350;

type Scope = 'current' | 'all';
type Mode = 'keyword' | 'smart';

interface SearchPaletteProps {
  onClose: () => void;
}

/** Render order - projects float above tasks for fast nav. Each label is
 *  shown exactly once even if there are zero hits in that group. */
const KIND_ORDER: SearchHitKind[] = ['project', 'task', 'backlog', 'conversation', 'session_event'];

const KIND_LABEL: Record<SearchHitKind, string> = {
  project: 'Projects',
  task: 'Tasks',
  backlog: 'Backlog',
  conversation: 'Conversations',
  session_event: 'Session events',
};

export function SearchPalette({ onClose }: SearchPaletteProps) {
  const { requestClose, backdropClassName, contentClassName, onAnimationEnd } = useOverlayPhase(
    onClose,
    { variant: 'command-bar', skipEnterOnHmr: true },
  );
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [scope, setScope] = useState<Scope>('current');
  // No per-search toggle: the mode follows the global Memory setting - Smart
  // (hybrid) when semantic search is enabled, otherwise keyword. Smart already
  // degrades to keyword when the model is missing/slow, so this is safe.
  const semanticOn = useConfigStore((state) => state.config.memory?.semanticEnabled ?? false);
  const mode: Mode = semanticOn ? 'smart' : 'keyword';
  const [memoryStatus, setMemoryStatus] = useState<MemoryStatus | null>(null);
  const [results, setResults] = useState<SearchHit[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const backdropMouseDown = useRef(false);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestSeq = useRef(0);

  const currentProjectId = useProjectStore((state) => state.currentProject?.id ?? null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Fetch the semantic-layer status on open and on each mode flip, so the
  // Smart-mode degraded notice reflects the current backend state.
  useEffect(() => {
    let cancelled = false;
    window.electronAPI.memory
      .getStatus()
      .then((status) => {
        if (!cancelled) setMemoryStatus(status);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [mode]);

  useEffect(() => {
    const debounceMs = mode === 'smart' ? SMART_SEARCH_DEBOUNCE_MS : SEARCH_DEBOUNCE_MS;
    if (debounceTimer.current !== null) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      debounceTimer.current = null;
      setDebouncedQuery(query);
    }, debounceMs);
    return () => {
      if (debounceTimer.current !== null) {
        clearTimeout(debounceTimer.current);
        debounceTimer.current = null;
      }
    };
  }, [query, mode]);

  useEffect(() => {
    const trimmed = debouncedQuery.trim();
    if (!trimmed) {
      setResults([]);
      setIsSearching(false);
      setSelectedIndex(0);
      return;
    }
    if (!currentProjectId) {
      setResults([]);
      setIsSearching(false);
      return;
    }
    const seq = ++requestSeq.current;
    setIsSearching(true);
    window.electronAPI.search
      .everything({ query: trimmed, scope, currentProjectId, mode })
      .then((hits) => {
        if (seq !== requestSeq.current) return;
        setResults(hits);
        setSelectedIndex(0);
        setIsSearching(false);
      })
      .catch((error) => {
        if (seq !== requestSeq.current) return;
        const message = error instanceof Error ? error.message : String(error);
        useToastStore.getState().addToast({ message, variant: 'error' });
        setResults([]);
        setIsSearching(false);
      });
  }, [debouncedQuery, scope, currentProjectId, mode]);

  const grouped = useMemo(() => {
    const buckets: Partial<Record<SearchHitKind, SearchHit[]>> = {};
    for (const hit of results) {
      (buckets[hit.kind] ??= []).push(hit);
    }
    const flat: SearchHit[] = [];
    const headings: { index: number; label: string; count: number }[] = [];
    for (const kind of KIND_ORDER) {
      const bucket = buckets[kind];
      if (!bucket || bucket.length === 0) continue;
      headings.push({ index: flat.length, label: KIND_LABEL[kind], count: bucket.length });
      flat.push(...bucket);
    }
    return { flat, headings };
  }, [results]);

  const activate = useCallback(async (hit: SearchHit) => {
    const sessionStore = useSessionStore.getState();
    const projectStore = useProjectStore.getState();
    const boardStore = useBoardStore.getState();
    const isCrossProject = hit.projectId !== projectStore.currentProject?.id;

    const switchProjectIfNeeded = async (): Promise<boolean> => {
      if (!isCrossProject) return true;
      try {
        await projectStore.openProject(hit.projectId);
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        useToastStore.getState().addToast({ message, variant: 'error' });
        return false;
      }
    };

    switch (hit.kind) {
      case 'project': {
        if (hit.projectId !== projectStore.currentProject?.id) {
          await switchProjectIfNeeded();
        }
        break;
      }
      case 'task': {
        sessionStore.setPendingOpenTaskId(null);
        if (isCrossProject) {
          sessionStore.setPendingOpenTaskId(hit.taskId);
          if (!(await switchProjectIfNeeded())) {
            sessionStore.setPendingOpenTaskId(null);
            return;
          }
        } else {
          sessionStore.setDetailTaskId(hit.taskId);
        }
        break;
      }
      case 'session_event': {
        sessionStore.setScrollToEventKey(hit.eventKey);
        if (isCrossProject) {
          sessionStore.setPendingOpenTaskId(hit.taskId);
          if (!(await switchProjectIfNeeded())) {
            sessionStore.setPendingOpenTaskId(null);
            sessionStore.setScrollToEventKey(null);
            return;
          }
        } else {
          sessionStore.setDetailTaskId(hit.taskId);
        }
        break;
      }
      case 'conversation': {
        // A live agent still owns this session: open the task so the user lands
        // in the active terminal, not the read-only history. Needs a task row.
        if (hit.sessionActive && hit.taskId !== null) {
          if (isCrossProject) {
            sessionStore.setPendingOpenTaskId(hit.taskId);
            if (!(await switchProjectIfNeeded())) {
              sessionStore.setPendingOpenTaskId(null);
              return;
            }
          } else {
            sessionStore.setDetailTaskId(hit.taskId);
          }
          break;
        }
        // Otherwise open the read-only conversation viewer. Scroll-to-turn is a
        // one-shot consumed by the viewer; set it before the (possibly async)
        // project switch so it is armed when the window mounts.
        if (isCrossProject) {
          // The project switch resets `scrollToTurnUuid`, so hand it off via a
          // pending signal alongside the session id (mirrors _pendingOpenConversation);
          // `useProjectSwitchEffect` re-arms both once the destination loads.
          sessionStore.setPendingOpenConversation(hit.sessionId);
          sessionStore.setPendingScrollToTurnUuid(hit.turnUuid);
          if (!(await switchProjectIfNeeded())) {
            sessionStore.setPendingOpenConversation(null);
            sessionStore.setPendingScrollToTurnUuid(null);
            return;
          }
        } else {
          sessionStore.setScrollToTurnUuid(hit.turnUuid);
          sessionStore.setConversationSessionId(hit.sessionId);
        }
        break;
      }
      case 'backlog': {
        if (isCrossProject && !(await switchProjectIfNeeded())) return;
        boardStore.setActiveView('backlog');
        useBacklogStore.getState().setScrollToBacklogId(hit.backlogId);
        break;
      }
    }
    requestClose();
  }, [requestClose]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      // Stop the native event from reaching document-level Escape listeners
      // (BaseDialog, TaskDetailWindow) below this overlay - otherwise a task
      // detail open underneath Quick Find closes on the same keypress instead
      // of only Quick Find. A second Escape then closes the dialog normally.
      event.stopPropagation();
      requestClose();
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setSelectedIndex((currentIndex) =>
        grouped.flat.length === 0 ? 0 : Math.min(currentIndex + 1, grouped.flat.length - 1),
      );
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setSelectedIndex((currentIndex) => Math.max(currentIndex - 1, 0));
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      const hit = grouped.flat[selectedIndex];
      if (hit) activate(hit);
    }
  }, [grouped.flat, selectedIndex, activate, requestClose]);

  // Scroll selected row into view
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const row = list.querySelector<HTMLElement>(`[data-row-index="${selectedIndex}"]`);
    if (row) row.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex, results]);

  const trimmedQuery = query.trim();
  const hasQuery = trimmedQuery.length > 0;
  const showEmpty = !hasQuery;
  // A search is pending while the debounce is still catching up to the live query
  // (query !== debouncedQuery) or while the IPC search is in flight. Show
  // "Searching..." during that window rather than a premature "No matches".
  const searching = isSearching || (hasQuery && trimmedQuery !== debouncedQuery.trim());
  const hasResults = grouped.flat.length > 0;
  // Results always render (the backend falls back to lexical); the notice only
  // explains the degraded semantic state in Smart mode.
  const degradedNotice = mode === 'smart' ? semanticDegradedNotice(memoryStatus) : null;

  return (
    <div
      className={`fixed inset-0 bg-black/60 z-50 ${backdropClassName}`}
      onMouseDown={(event) => { backdropMouseDown.current = event.target === event.currentTarget; }}
      onMouseUp={(event) => {
        if (event.target === event.currentTarget && backdropMouseDown.current) requestClose();
        backdropMouseDown.current = false;
      }}
      onKeyDown={handleKeyDown}
      data-testid="search-palette"
    >
      <div
        className={`absolute top-20 left-1/2 -translate-x-1/2 w-[70%] max-w-3xl ${contentClassName}`}
        onAnimationEnd={onAnimationEnd}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="bg-surface-raised border border-edge rounded-lg shadow-2xl overflow-hidden flex flex-col">
          <div className="flex items-center gap-2 px-3 py-2 border-b border-edge">
            <Search size={16} className="flex-shrink-0 text-fg-disabled" />
            <input
              ref={inputRef}
              data-testid="search-palette-input"
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search tasks, backlog, conversations, session events, projects..."
              className="flex-1 min-w-0 bg-transparent text-sm text-fg placeholder-fg-muted outline-none"
            />
            {/* Corner spinner only while results are already on screen (a
                re-query); the empty "Searching..." state carries its own inline
                spinner, so the two never show at once. */}
            {searching && hasResults ? (
              <Loader2 size={14} className="text-fg-muted animate-spin flex-shrink-0" />
            ) : null}
            <ScopeToggle scope={scope} onChange={setScope} />
            <button
              type="button"
              onClick={requestClose}
              className="p-1 text-fg-muted hover:text-fg transition-colors rounded hover:bg-surface-hover/60"
              aria-label="Close search"
              data-testid="search-palette-close"
            >
              <X size={14} />
            </button>
          </div>

          {degradedNotice ? (
            <div
              className="px-3 py-1.5 text-xs text-fg-muted border-b border-edge"
              data-testid="search-degraded-notice"
            >
              {degradedNotice}
            </div>
          ) : null}

          <div ref={listRef} className="max-h-[60vh] overflow-y-auto">
            {showEmpty ? (
              <EmptyState />
            ) : hasResults ? (
              <ul className="py-1" data-testid="search-palette-results">
                {grouped.headings.map((heading) => (
                  <RenderGroup
                    key={heading.label}
                    heading={heading}
                    flat={grouped.flat}
                    selectedIndex={selectedIndex}
                    onHover={setSelectedIndex}
                    onActivate={activate}
                  />
                ))}
              </ul>
            ) : searching ? (
              <div
                className="flex items-center justify-center gap-2 px-4 py-6 text-sm text-fg-muted"
                data-testid="search-searching"
              >
                <Loader2 size={14} className="animate-spin flex-shrink-0" />
                Searching...
              </div>
            ) : (
              <div className="px-4 py-6 text-sm text-fg-muted text-center">
                No matches in {scope === 'all' ? 'any project' : 'this project'}.
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

interface RenderGroupProps {
  heading: { index: number; label: string; count: number };
  flat: SearchHit[];
  selectedIndex: number;
  onHover: (index: number) => void;
  onActivate: (hit: SearchHit) => void;
}

function RenderGroup({ heading, flat, selectedIndex, onHover, onActivate }: RenderGroupProps) {
  // Render rows belonging to this group: indices [heading.index, heading.index + heading.count)
  const rows: { hit: SearchHit; flatIndex: number }[] = [];
  for (let offset = 0; offset < heading.count; offset++) {
    const flatIndex = heading.index + offset;
    rows.push({ hit: flat[flatIndex], flatIndex });
  }
  return (
    <>
      <li className="px-3 pt-2 pb-1 text-[11px] font-semibold uppercase tracking-wider text-fg-disabled">
        {heading.label}
        <span className="ml-2 text-fg-disabled normal-case font-normal">{heading.count}</span>
      </li>
      {rows.map(({ hit, flatIndex }) => (
        <ResultRow
          key={`${hit.kind}-${flatIndex}`}
          hit={hit}
          rowIndex={flatIndex}
          isSelected={flatIndex === selectedIndex}
          onHover={() => onHover(flatIndex)}
          onClick={() => onActivate(hit)}
        />
      ))}
    </>
  );
}

interface ScopeToggleProps {
  scope: Scope;
  onChange: (scope: Scope) => void;
}

function ScopeToggle({ scope, onChange }: ScopeToggleProps) {
  return (
    <div className="flex items-center gap-0.5 rounded-md bg-surface-hover/50 p-0.5 flex-shrink-0">
      <ScopeButton label="This project" active={scope === 'current'} onClick={() => onChange('current')} />
      <ScopeButton label="All projects" active={scope === 'all'} onClick={() => onChange('all')} />
    </div>
  );
}

function ScopeButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'px-2 py-0.5 text-xs rounded transition-colors ' +
        (active ? 'bg-surface-raised text-fg shadow-sm' : 'text-fg-muted hover:text-fg')
      }
    >
      {label}
    </button>
  );
}

/** One-line notice explaining a degraded semantic state in Smart mode. Returns
 *  null when the hybrid layer is live (no notice) or status is not yet known. */
function semanticDegradedNotice(status: MemoryStatus | null): string | null {
  if (!status) return null;
  switch (status.semantic) {
    case 'hybrid':
      return null;
    case 'downloading':
      return `Preparing semantic search... (${Math.round((status.modelProgress ?? 0) * 100)}%)`;
    case 'lexical':
      return 'Semantic search unavailable on this platform - showing keyword matches.';
    case 'disabled':
      return 'Smart search is off. Enable it in Settings -> Memory.';
    case 'error':
      return 'Semantic search failed - showing keyword matches.';
    default:
      return null;
  }
}

function EmptyState() {
  return (
    <div className="px-4 py-8 text-sm text-fg-muted text-center space-y-1">
      <div>Search across tasks, backlog, conversations, session events, and projects.</div>
      <div className="text-xs text-fg-disabled">
        Type to find by title, description, or tool call.
      </div>
    </div>
  );
}

interface ResultRowProps {
  hit: SearchHit;
  rowIndex: number;
  isSelected: boolean;
  onHover: () => void;
  onClick: () => void;
}

function ResultRow({ hit, rowIndex, isSelected, onHover, onClick }: ResultRowProps) {
  // A hit with no match range (matchStart === matchEnd) is a semantic / no-offset
  // hit: render the snippet plain, with no <mark> highlight.
  const hasMatchRange = hit.matchEnd > hit.matchStart;
  const before = hit.snippet.slice(0, hit.matchStart);
  const matched = hit.snippet.slice(hit.matchStart, hit.matchEnd);
  const after = hit.snippet.slice(hit.matchEnd);
  return (
    <li>
      <button
        type="button"
        data-row-index={rowIndex}
        data-testid="search-palette-result"
        data-result-kind={hit.kind}
        onClick={onClick}
        onMouseEnter={onHover}
        className={
          'w-full text-left px-3 py-2 flex flex-col gap-1 transition-colors ' +
          (isSelected ? 'bg-surface-hover' : 'hover:bg-surface-hover/60')
        }
      >
        <ResultRowHeader hit={hit} />
        <div className="text-xs text-fg-muted truncate">
          {hasMatchRange ? (
            <>
              <span>{before}</span>
              <mark className="bg-amber-400/30 text-fg rounded px-0.5">{matched}</mark>
              <span>{after}</span>
            </>
          ) : (
            <span>{hit.snippet}</span>
          )}
        </div>
      </button>
    </li>
  );
}

/** Map a conversation chunk's dominant role to a short row badge. */
function turnKindLabel(turnKind: string): string {
  switch (turnKind) {
    case 'user':
      return 'You';
    case 'tool_result':
      return 'Tool';
    case 'system':
      return 'System';
    // 'assistant' and 'mixed' both read as the agent speaking.
    default:
      return 'Agent';
  }
}

function ResultRowHeader({ hit }: { hit: SearchHit }) {
  switch (hit.kind) {
    case 'task':
      return (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-fg-muted">{hit.projectName}</span>
          <span className="text-fg-disabled">/</span>
          <span className="text-fg-disabled tabular-nums">#{hit.displayId}</span>
          <span className="text-fg truncate">{hit.taskTitle}</span>
          {hit.archived ? (
            <span className="ml-1 inline-flex items-center gap-1 text-[11px] text-fg-disabled">
              <Archive size={10} /> archived
            </span>
          ) : null}
        </div>
      );
    case 'backlog':
      return (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-fg-muted">{hit.projectName}</span>
          <span className="text-fg-disabled">/</span>
          <span className="text-fg-disabled">Backlog</span>
          <span className="text-fg truncate">{hit.backlogTitle}</span>
        </div>
      );
    case 'session_event':
      return (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-fg-muted">{hit.projectName}</span>
          <span className="text-fg-disabled">/</span>
          <span className="text-fg truncate">{hit.taskTitle}</span>
          <span className="ml-auto text-fg-disabled tabular-nums whitespace-nowrap">
            {formatRelativeTime(new Date(hit.eventTs))}
          </span>
        </div>
      );
    case 'conversation': {
      const turnLabel = turnKindLabel(hit.turnKind);
      return (
        <div className="flex items-center gap-2 text-xs">
          <MessageSquare size={12} className="flex-shrink-0 text-fg-muted" />
          <span className="text-fg truncate">{hit.taskTitle}</span>
          {/* Matched by meaning, not keywords: a pure-semantic hit carries no
              highlighted term in its snippet, so flag why it surfaced. */}
          {hit.matchKind === 'semantic' && (
            <span
              className="flex-shrink-0 inline-flex text-accent"
              title="Matched by meaning"
              aria-label="Matched by meaning"
            >
              <Sparkles size={12} />
            </span>
          )}
          {/* The agent name (e.g. "Claude Code") is intentionally omitted: the
              task title already identifies the conversation and the agent is
              visible the moment it opens, so it would only add row noise. */}
          {/* Who spoke in the matched turn. 'Agent' is redundant with the
              snippet's "Assistant:" prefix, so only surface the non-obvious
              roles (You / Tool / System). */}
          {turnLabel !== 'Agent' && (
            <span className="ml-1 flex-shrink-0 text-[11px] text-fg-muted bg-surface-hover/60 rounded px-1.5 py-0.5">
              {turnLabel}
            </span>
          )}
          {/* Results are collapsed to one row per conversation; show how many
              turns matched when there is more than one. */}
          {hit.matchCount > 1 && (
            <span className="flex-shrink-0 text-[11px] text-fg-muted whitespace-nowrap">
              {hit.matchCount} matches
            </span>
          )}
          {/* What selecting this hit opens: the live terminal if the session's
              agent is still active (and a task row exists to open), otherwise the
              read-only conversation history. Mirrors the routing in `activate`. */}
          {hit.sessionActive && hit.taskId !== null ? (
            <span
              className="ml-1 flex-shrink-0 inline-flex items-center gap-1 text-[11px] rounded px-1.5 py-0.5"
              style={{ color: 'var(--kng-active)', backgroundColor: 'color-mix(in srgb, var(--kng-active) 14%, transparent)' }}
              title="Opens the active terminal"
            >
              <Terminal size={10} /> Terminal
            </span>
          ) : (
            <span
              className="ml-1 flex-shrink-0 inline-flex items-center gap-1 text-[11px] text-fg-secondary bg-surface-hover rounded px-1.5 py-0.5"
              title="Opens the conversation history"
            >
              <History size={10} /> History
            </span>
          )}
          {hit.turnTs !== null && (
            <span className="ml-auto text-fg-muted tabular-nums whitespace-nowrap">
              {formatRelativeTime(new Date(hit.turnTs))}
            </span>
          )}
        </div>
      );
    }
    case 'project':
      return (
        <div className="flex items-center gap-2 text-xs">
          <span className="text-fg truncate">{hit.projectName}</span>
          <span className="ml-auto text-fg-disabled truncate">{hit.projectPath}</span>
        </div>
      );
  }
}

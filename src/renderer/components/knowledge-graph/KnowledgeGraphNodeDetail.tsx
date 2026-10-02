/**
 * Detail panel for the selected conversation: what it is, why it matched, and
 * where to go next.
 *
 * The first version showed `5b027895 6 chunks conversation` - a raw hash - which
 * told the user nothing and offered nothing to do. This version answers three
 * questions in order, because that is the order a person asks them: what IS
 * this, why am I looking at it, and what do I do now.
 *
 * The middle one is the part that was missing. After filtering the map by a
 * query, selecting a node dropped the query entirely: the panel showed global
 * nearest neighbours with no mention of the search that got you there, so the
 * thread of "I am exploring 'settings panel'" broke on the first click.
 *
 * NO SIMILARITY PERCENTAGES. They used to read "99% similar" on every row, which
 * is not a rounding accident - it is the corpus. Measured in Phase 1: anisotropy
 * puts more than 98% of top-10 pairs above 0.8 cosine, so raw cosine compresses
 * into a band a percentage cannot resolve, and six rows of "99%" told the user
 * nothing while looking like precision. The ORDER carries the real signal, so the
 * list is ordered and the number is gone (kept on the row's title for anyone who
 * wants it).
 */

import { useEffect, useState } from 'react';
import { ArrowLeft, ChevronRight, Compass, MessageSquareText } from 'lucide-react';
import { PanelRow } from './PanelRow';
import { humanizeModelId } from '../../../shared/model-id';
import { useToastStore } from '../../stores/toast-store';
import { useKnowledgeGraphStore } from '../../stores/knowledge-graph-store';
import { openKnowledgeGraphConversation } from './open-knowledge-graph-conversation';
import type { KnowledgeGraphCluster, KnowledgeGraphNode } from '../../../shared/types';

export interface KnowledgeGraphNodeDetailProps {
  node: KnowledgeGraphNode;
  cluster: KnowledgeGraphCluster | null;
  /** Nearest neighbours in FULL embedding dimensionality, strongest first, so
   *  this ordering is exact even though the node's position is approximate. */
  neighbors: ReadonlyArray<{ index: number; node: KnowledgeGraphNode; similarity: number }>;
  onSelectNeighbor: (index: number) => void;
  /** Re-scope the map to this conversation and everything it links to. */
  onExploreFrom?: () => void;
  /** Step back to wherever this panel was reached from, if anywhere. */
  onBack?: () => void;
  /** Names the destination, because after a few hops a bare arrow is a guess. */
  backLabel?: string;
  /** The node's own project, when the map shows several, so "Open conversation"
   *  reads the transcript from the project it belongs to. */
  nodeProjectId?: string | null;
}

/**
 * Open this conversation in the read-only Conversation viewer.
 *
 * Reuses the same `ConversationWindow` the board hosts, but mounted on the graph's
 * OWN window layer rather than the board's. Routing through
 * `session-store.setConversationSessionId` (as this did originally) opened the
 * transcript on the board at z-40, underneath the graph's z-42 overlay, so it
 * looked like the click did nothing - and in a detached graph that signal has no
 * layer to reach at all. See `KnowledgeGraphDetailLayer`.
 */
export function openConversationForNode(
  node: KnowledgeGraphNode,
  /** The node's own project, when the map shows several. */
  nodeProjectId?: string | null,
): void {
  if (!node.sessionId) {
    useToastStore.getState().addToast({
      message: 'This conversation has no session record to open',
      variant: 'info',
    });
    return;
  }
  // The project MAIN resolved for this snapshot, not the renderer's ambient one: a
  // detached graph follows main and has no populated project store, so reading it
  // here would stamp every pop-out window `null` and defeat the switch cleanup.
  openKnowledgeGraphConversation(node.sessionId, useKnowledgeGraphStore.getState().snapshot?.projectId ?? null, null, nodeProjectId);
}

/**
 * The selected conversation's task summary, read when it is selected rather
 * than shipped in every snapshot (about 170 KB on a large map). Read from the
 * node's OWN project, since the map may show several, falling back to the
 * project the snapshot is for. A reply for an earlier selection is dropped.
 */
function useTaskSummary(taskId: string | null, nodeProjectId: string | null | undefined): string | null {
  const snapshotProjectId = useKnowledgeGraphStore((state) => state.snapshot?.projectId ?? null);
  const projectId = nodeProjectId ?? snapshotProjectId;
  const [read, setRead] = useState<{ projectId: string; taskId: string; text: string | null } | null>(null);
  useEffect(() => {
    if (!taskId || !projectId) return;
    let current = true;
    window.electronAPI.knowledgeGraph.taskSummary(projectId, taskId)
      .then((text) => {
        if (current) setRead({ projectId, taskId, text });
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [taskId, projectId]);
  return read && read.taskId === taskId && read.projectId === projectId ? read.text : null;
}

const ACTION_CLASS =
  'w-full flex items-center justify-center gap-1.5 rounded-md border border-edge bg-surface-raised px-3 py-2 text-xs font-medium text-fg hover:bg-surface-hover disabled:opacity-50 disabled:cursor-default transition-colors cursor-pointer';

export function KnowledgeGraphNodeDetail({
  node,
  cluster,
  neighbors,
  onSelectNeighbor,
  onExploreFrom,
  onBack,
  backLabel,
  nodeProjectId,
}: KnowledgeGraphNodeDetailProps) {
  const summaryText = useTaskSummary(node.taskId, nodeProjectId);
  return (
    <aside
      className="w-full h-full overflow-y-auto flex flex-col"
      data-testid="knowledge-graph-detail"
    >
      <div className="p-4 border-b border-edge">
        {/* Two dead ends closed by one control. Following a neighbour replaces
            the panel, so without this the trail back is gone; and selecting a
            result replaces the RESULTS list, so the search you ran was equally
            unreachable. Named with the destination rather than a bare arrow,
            because after a few hops "back" alone is a guess. */}
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            className="mb-2 flex w-full items-center gap-1.5 rounded px-1 py-1 text-left text-[11px] text-fg-muted hover:bg-surface-hover hover:text-fg cursor-pointer"
            data-testid="knowledge-graph-detail-back"
          >
            <ArrowLeft size={12} className="flex-shrink-0" aria-hidden />
            <span className="truncate">Back to {backLabel ?? 'where you were'}</span>
          </button>
        ) : null}

        {/* The title sits on its own ground rather than as the first line of the
            block. It was `text-sm font-semibold` directly above a label/value
            list whose values are also `font-medium text-fg`, so the SUBJECT of
            the panel and the attributes describing it differed only by a step
            in size - the name read as one more row and got lost. A surface
            behind it changes the KIND of thing it is rather than its degree,
            which is the distinction the eye resolves without working at it, and
            it wraps where a true pill could not: these titles run to a full
            sentence. */}
        <h2
          className="rounded-md border border-edge/60 bg-surface-control/60 px-2.5 py-2 text-[13px] font-semibold leading-snug text-fg"
          data-testid="knowledge-graph-detail-title"
        >
          {node.title ?? 'Untitled conversation'}
        </h2>

        {/* What the task set out to do and did, in a sentence or two, right
            under what it was called. Absent with summaries off or none written,
            so the panel is then exactly as before. */}
        {summaryText ? (
          <p className="mx-0.5 mt-2 text-xs leading-[18px] text-fg-secondary" data-testid="knowledge-graph-detail-summary">
            {summaryText}
          </p>
        ) : null}

        {/* Named fields, not bare icon + value. This block used to print a `#`
            in front of `drains / pending / bytes` and leave the reader to work
            out that it was the region of the map the conversation sits in - the
            glyph was carrying the whole meaning of the row and getting it wrong.
            Labels also let agent / model / effort sit here without three more
            guessable icons. Same shape as the left panel's Index section. */}
        <dl className="mt-2.5">
          {cluster ? (
            <PanelRow
              label="Region"
              value={cluster.label}
              hint="The area of the map this conversation sits in, named by the terms that set its conversations apart from the rest of the index."
            />
          ) : null}
          {node.agent ? <PanelRow label="Agent" value={node.agent} /> : null}
          {node.model ? (
            // The shared humanizer, so this reads "Opus 5" like the rest of the
            // app rather than the spawnable id the CLI flag carries. It returns
            // null when it cannot derive a name, hence the raw fallback.
            <PanelRow label="Model" value={humanizeModelId(node.model) ?? node.model} />
          ) : null}
          {node.effort ? <PanelRow label="Effort" value={node.effort} /> : null}
          <PanelRow
            label="Indexed"
            numeric
            value={`${node.chunkCount.toLocaleString()} chunks`}
            hint="Passages this conversation was split into for search. Longer conversations produce more."
          />
          {node.lastActivityMs ? (
            <PanelRow label="Last active" value={new Date(node.lastActivityMs).toLocaleDateString()} />
          ) : null}
        </dl>

        <div className="mt-3 space-y-1.5">
          <button
            type="button"
            onClick={() => openConversationForNode(node, nodeProjectId)}
            disabled={!node.sessionId}
            className={ACTION_CLASS}
            data-testid="knowledge-graph-open-conversation"
            title={node.sessionId ? 'Open the full transcript' : 'No session record for this conversation'}
          >
            <MessageSquareText size={13} />
            Open conversation
          </button>
          {onExploreFrom ? (
            <button
              type="button"
              onClick={onExploreFrom}
              disabled={neighbors.length === 0}
              className={ACTION_CLASS}
              data-testid="knowledge-graph-explore-from"
              title={
                neighbors.length > 0
                  ? 'Narrow the map to this conversation and everything it links to'
                  : 'This conversation links to nothing else in the index'
              }
            >
              <Compass size={13} />
              Explore from here
            </button>
          ) : null}
        </div>
      </div>

      {neighbors.length > 0 ? (
        <div className="p-4">
          {/* No subtitle. It read "Strongest first. Exact, not read off the
              map.", which defended an implementation detail nobody asked about:
              the reader does not know the position is approximate and does not
              need to, and a list under "Closest conversations" is already read
              as ordered by closeness. The honest note about position lives once
              in the Index section, as reference rather than a caption reprinted
              on every selection. */}
          <h3 className="text-[11px] font-semibold uppercase tracking-wide text-fg-muted">
            Closest conversations
          </h3>
          <ul className="mt-2 space-y-1.5">
            {neighbors.map((neighbor) => {
              return (
                <li key={neighbor.node.docKey}>
                  {/* A resting affordance, not hover-only: these are the panel's
                      main navigation and they read as plain text until you happen
                      to hover them (`ui-conventions`). Border, chevron and a
                      pointer cursor say "this goes somewhere" at rest. */}
                  <button
                    type="button"
                    onClick={() => onSelectNeighbor(neighbor.index)}
                    className="group flex w-full items-center gap-2 rounded-md border border-edge bg-surface-control px-2.5 py-2 text-left hover:border-fg-faint hover:bg-surface-hover cursor-pointer transition-colors"
                    data-testid="knowledge-graph-neighbor"
                    // The raw value, for anyone who wants it, without putting a
                    // number on screen that reads the same on every row.
                    title={`Cosine similarity ${neighbor.similarity.toFixed(4)}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs text-fg">
                        {neighbor.node.title ?? 'Untitled conversation'}
                      </span>
                      <span className="mt-0.5 flex items-center gap-2 text-[11px] text-fg-muted">
                        {/* The date disambiguates rows that share a title, which
                            happens whenever one TASK accumulated several
                            conversations - they are different sessions, and
                            without this they read as duplicates or as the row
                            pointing at itself. */}
                        {neighbor.node.lastActivityMs ? (
                          <span className="tabular-nums">
                            {new Date(neighbor.node.lastActivityMs).toLocaleDateString()}
                          </span>
                        ) : null}
                      </span>
                    </span>
                    <ChevronRight
                      size={13}
                      aria-hidden
                      className="flex-shrink-0 text-fg-faint group-hover:text-fg-muted"
                    />
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </aside>
  );
}

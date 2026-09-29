/**
 * Coverage strip for the Knowledge Graph.
 *
 * The numbers are a RECONCILIATION of `memory_index_state` against the chunks
 * actually present, not a readout of either. On the real corpus those two
 * disagree for 65% of documents, so a strip built on the state table alone
 * would report 224 sessions beside a graph rendering 638 nodes.
 *
 * The tone rules are the other half. `missing-source` - the transcript file is
 * gone but the indexed text and its embeddings remain, and it is still fully
 * searchable - covers 414 of the real corpus's 638 documents. That is the
 * steady state for a mature project, not a failure, so it is presented plainly.
 * Only `unsupported` / `error` are painted as problems, and only when non-zero.
 */

import { Database, FileQuestion, TriangleAlert, Clock, Sparkles } from 'lucide-react';
import type { KnowledgeGraphCoverageSummary } from '../../../shared/types';

function formatCount(value: number): string {
  return value.toLocaleString();
}

interface StatProps {
  icon: React.ReactNode;
  label: string;
  value: string;
  detail?: string;
  tone?: 'ok' | 'neutral' | 'problem';
}

function Stat({ icon, label, value, detail, tone = 'neutral' }: StatProps) {
  const toneClass = tone === 'problem' ? 'text-attention' : 'text-fg';
  return (
    <div className="flex items-start gap-2 min-w-0">
      <span className="text-fg-muted mt-0.5 flex-shrink-0" aria-hidden>{icon}</span>
      <div className="min-w-0">
        <div className={`text-sm font-semibold tabular-nums ${toneClass}`}>{value}</div>
        <div className="text-xs text-fg-muted truncate">{label}</div>
        {detail ? <div className="text-[11px] text-fg-muted truncate">{detail}</div> : null}
      </div>
    </div>
  );
}

export interface KnowledgeGraphCoverageStripProps {
  coverage: KnowledgeGraphCoverageSummary;
  semanticAvailable: boolean;
}

/**
 * The FULL-WIDTH horizontal form, for the states that have no map to draw (no
 * project, semantic off, first build in progress). It is icon + big number +
 * caption per bucket, which needs the width of the surface.
 *
 * There is deliberately no narrow variant. One existed briefly, for the map's
 * left panel, and squeezing this layout into a 256px column produced a loose
 * pile of glyphs and captions that printed the same number twice under two
 * labels. That panel now renders its own aligned label/value list instead
 * (`KnowledgeGraphControls`), which is what a narrow column of reference numbers
 * wants - so this component keeps one job and one shape.
 */
export function KnowledgeGraphCoverageStrip({ coverage, semanticAvailable }: KnowledgeGraphCoverageStripProps) {
  const embeddedPercent = Math.round(coverage.embeddedFraction * 100);

  return (
    <div
      className="flex flex-wrap items-start gap-x-8 gap-y-3 px-4 py-3 border-b border-edge bg-surface-raised"
      data-testid="knowledge-graph-coverage-strip"
    >
      <Stat
        icon={<Database size={15} />}
        label="conversations indexed"
        value={formatCount(coverage.totalDocumentsWithChunks)}
        detail={`${formatCount(coverage.totalChunks)} chunks`}
      />
      <Stat
        icon={<Sparkles size={15} />}
        label="embedded"
        value={`${embeddedPercent}%`}
        detail={semanticAvailable ? undefined : 'semantic layer unavailable'}
        tone={semanticAvailable ? 'ok' : 'problem'}
      />
      {coverage.sourceMissingButSearchable.documents > 0 ? (
        <Stat
          icon={<FileQuestion size={15} />}
          label="searchable, transcript deleted"
          value={formatCount(coverage.sourceMissingButSearchable.documents)}
          // Said plainly, because it is not a problem: the text and embeddings
          // are still in the index and still answer queries.
          detail="still fully searchable"
        />
      ) : null}
      {coverage.notYetIndexed.documents > 0 ? (
        <Stat
          icon={<Clock size={15} />}
          label="not yet indexed"
          value={formatCount(coverage.notYetIndexed.documents)}
          detail="the sweep has not reached these"
        />
      ) : null}
      {coverage.failed.documents > 0 ? (
        <Stat
          icon={<TriangleAlert size={15} />}
          label="failed to index"
          value={formatCount(coverage.failed.documents)}
          tone="problem"
        />
      ) : null}
      <div className="ml-auto text-[11px] text-fg-muted max-w-[22rem]">
        Covers conversations this project has indexed, not files in the repository.
      </div>
    </div>
  );
}

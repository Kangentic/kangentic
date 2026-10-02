/**
 * The Knowledge Graph with no map to draw: the first build, a project with
 * nothing indexed, or the Knowledge Graph switched off.
 *
 * One card in the middle says what is happening, in the Settings card's
 * language. While the first map builds it is the one place the index shows:
 * the build's progress, the same source lines the map's Index panel lists
 * (`useIndexSourceLines`), and the way to Settings. The left panel keeps only
 * the Projects picker, which names the project and lets a scope whose maps all
 * still build get back to one that draws; the Index card arrives with the map's
 * other cards.
 *
 * This replaced a building card of two fixed totals beside an Index flyout that
 * opened by itself, which pushed the card 264 px right of the page centre to
 * make room for the flyout.
 */

import type React from 'react';
import { useState } from 'react';
import { Brain, Filter, Loader2 } from 'lucide-react';
import { SettingsCard, CardSourceList, CardStatusRow, CardTile } from '../settings/settings-card';
import { settingProps } from '../settings/settings-registry';
import type { KnowledgeGraphBuildProgress, KnowledgeGraphIndexSummary } from '../../../shared/types';
import { CARD_CLASS, GroupLabel, OpenSettingsButton, SectionHeader } from './panel-card';
import { buildProgressRow } from './index-panel-lines';
import { useIndexSourceLines } from './use-index-source-lines';

export interface KnowledgeGraphNoMapProps {
  /** `off`: the Knowledge Graph is switched off. `pending`: on, and no map yet. */
  mode: 'off' | 'pending';
  /** A first build is running; without it a pending map has nothing indexed to draw. */
  building: boolean;
  /** How far the first build has got; null before its first figure. */
  buildProgress: KnowledgeGraphBuildProgress | null;
  index: KnowledgeGraphIndexSummary;
  /** The Projects picker. It names the project, which nothing else here does,
   *  and a scope whose maps all still build needs it to get back to one that draws. */
  projectsPicker?: React.ReactNode;
  onOpenSettings?: () => void;
}

export function KnowledgeGraphNoMap({ mode, building, buildProgress, index, projectsPicker, onOpenSettings }: KnowledgeGraphNoMapProps) {
  const [filterCollapsed, setFilterCollapsed] = useState(false);
  const knowledgeGraphLabel = settingProps('knowledgeGraph.enabled').label;
  const showPicker = mode === 'pending' && projectsPicker !== undefined && projectsPicker !== null;

  return (
    <div className="relative flex-1 min-h-0" data-testid="knowledge-graph-body">
      {showPicker ? (
        <div data-graph-chrome="left" className="pointer-events-none absolute bottom-3 left-3 top-3 z-10 flex flex-col">
          <div className="pointer-events-auto flex max-h-full w-64 flex-col gap-3 overflow-y-auto" data-testid="knowledge-graph-no-map-panel">
            <div className={CARD_CLASS} data-testid="knowledge-graph-pending-scope">
              <SectionHeader
                icon={<Filter size={13} aria-hidden />}
                label="Filter"
                collapsed={filterCollapsed}
                onToggle={() => setFilterCollapsed((current) => !current)}
                testId="knowledge-graph-filter-toggle"
              />
              {!filterCollapsed ? (
                <div className="px-3 pb-3">
                  <GroupLabel hint="Which projects the map shows and a question is asked across. Starts on the open project.">
                    Projects
                  </GroupLabel>
                  {projectsPicker}
                </div>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}

      {/* On the page centre, the line the map's Ask box sits on (`left-1/2`),
          so nothing jumps when the map lands. 50% less half the card's 460 px
          centres it; with the Projects picker up, 280 px (the left column's
          12 + 256 and a 12 px gap) holds it clear of the picker below about
          1020 px wide. The 12 px above and below is what lets the building card
          fit the 900 x 600 floor with no scrollbar; a shorter window scrolls it
          rather than clipping it. */}
      <div className="absolute inset-0 overflow-y-auto">
        <div className="flex min-h-full items-center py-3">
          <div
            className={`${showPicker
              ? 'ml-[max(280px,calc(50%_-_230px))] max-w-[calc(100%_-_292px)]'
              : 'mx-auto max-w-[calc(100%_-_32px)]'} w-[460px] flex-shrink-0 rounded-lg bg-surface-raised/80`}
            data-testid="knowledge-graph-no-map"
          >
            {mode === 'off' ? (
              <SettingsCard
                icon={<Brain size={16} />}
                label={knowledgeGraphLabel}
                // Not the Settings card's description: here the card says what
                // the map needs, which is what is missing.
                description="Places conversations by meaning, with a local model."
                tag="Off"
                testId="knowledge-graph-off-card"
              >
                {onOpenSettings ? (
                  <OpenSettingsButton onClick={onOpenSettings} testId="knowledge-graph-off-settings" />
                ) : (
                  // The detached window has no Settings of its own.
                  <CardTile testId="knowledge-graph-off-where">
                    <p className="text-xs text-fg-secondary">Turn it on in Settings &gt; Knowledge Graph, in the main window.</p>
                  </CardTile>
                )}
              </SettingsCard>
            ) : building ? (
              <BuildingCard buildProgress={buildProgress} index={index} onOpenSettings={onOpenSettings} />
            ) : (
              <SettingsCard
                icon={<Brain size={16} />}
                label="No map yet"
                description="Nothing has been indexed for this project yet."
                testId="knowledge-graph-empty-card"
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/** The first build: its progress, what the index holds, and the way to Settings. */
function BuildingCard({ buildProgress, index, onOpenSettings }: {
  buildProgress: KnowledgeGraphBuildProgress | null;
  index: KnowledgeGraphIndexSummary;
  onOpenSettings?: () => void;
}) {
  // A build runs only with the Knowledge Graph on, so the lines read as on.
  const sourceLines = useIndexSourceLines(index, true);
  const row = buildProgressRow(buildProgress);
  return (
    <SettingsCard
      icon={<Loader2 size={16} className="animate-spin" />}
      label="Building the map"
      description="Once per project, in the background. Later updates take moments."
      testId="knowledge-graph-building-card"
    >
      <CardStatusRow
        label={row.label}
        value={row.value}
        percent={row.percent}
        progressLabel="Map built"
        testId="knowledge-graph-building-progress"
      />
      <CardSourceList readOnly lines={sourceLines} testId="knowledge-graph-building-sources" />
      {onOpenSettings ? <OpenSettingsButton onClick={onOpenSettings} testId="knowledge-graph-building-settings" /> : null}
    </SettingsCard>
  );
}

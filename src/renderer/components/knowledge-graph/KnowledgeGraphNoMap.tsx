/**
 * The Knowledge Graph with no map to draw: the first build, a project with
 * nothing indexed, or the Knowledge Graph switched off.
 *
 * The left panel is where it will be once the map exists (the Projects picker
 * while a map builds, then the Index card), so nothing moves when the map
 * lands, and the counts have one home: the Index panel, the same one the map
 * opens. The middle is a card in the Settings card's language saying what is
 * happening, and while the Knowledge Graph is off, the way to Settings.
 *
 * This replaced a full-width coverage strip with its own copy of the counts and
 * a caption that still said the index held conversations only.
 */

import type React from 'react';
import { useState } from 'react';
import { Brain, Filter, Loader2 } from 'lucide-react';
import { SettingsCard, CardSourceList, CardTile } from '../settings/settings-card';
import { settingProps } from '../settings/settings-registry';
import type { KnowledgeGraphCoverageSummary, KnowledgeGraphIndexSummary } from '../../../shared/types';
import { CARD_CLASS, GroupLabel, OpenSettingsButton, SectionHeader } from './panel-card';
import { KnowledgeGraphIndexCard } from './KnowledgeGraphIndexCard';

/**
 * The narrowest window where the first build's Index flyout opens beside the
 * building card without covering it. The left column (12 + 256) and the flyout
 * (8 + 360) end at 636, so with a 12px gap the card may start at 648; centred
 * in the space from 560 with 32 to its right, as the board draws it, a 460px
 * card starts there from 1228 wide. Narrower, the flyout starts closed and the
 * card centres beside the panel, as in the other states.
 */
const SIDE_BY_SIDE_MIN_WIDTH = 1228;

export interface KnowledgeGraphNoMapProps {
  /** `off`: the Knowledge Graph is switched off. `pending`: on, and no map yet. */
  mode: 'off' | 'pending';
  /** A first build is running; without it a pending map has nothing indexed to draw. */
  building: boolean;
  coverage: KnowledgeGraphCoverageSummary;
  index: KnowledgeGraphIndexSummary;
  /** The Projects picker. It names the project, which nothing else here does,
   *  and a scope whose maps all still build needs it to get back to one that draws. */
  projectsPicker?: React.ReactNode;
  onOpenSettings?: () => void;
}

export function KnowledgeGraphNoMap({ mode, building, coverage, index, projectsPicker, onOpenSettings }: KnowledgeGraphNoMapProps) {
  const [filterCollapsed, setFilterCollapsed] = useState(false);
  // Measured once, so nothing moves when the window is resized afterwards.
  const [roomBeside] = useState(() => window.innerWidth >= SIDE_BY_SIDE_MIN_WIDTH);
  const besideBuild = mode === 'pending' && building && roomBeside;
  const conversationEmbeddings = index.corpora.find((entry) => entry.corpus === 'conversation')?.embeddedChunks ?? 0;
  const knowledgeGraphLabel = settingProps('knowledgeGraph.enabled').label;

  return (
    <div className="relative flex-1 min-h-0" data-testid="knowledge-graph-body">
      <div data-graph-chrome="left" className="pointer-events-none absolute bottom-3 left-3 top-3 z-10 flex flex-col">
        <div className="pointer-events-auto flex max-h-full w-64 flex-col gap-3 overflow-y-auto" data-testid="knowledge-graph-no-map-panel">
          {mode === 'pending' && projectsPicker ? (
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
          ) : null}
          <KnowledgeGraphIndexCard
            index={index}
            coverage={coverage}
            semanticAvailable={mode === 'pending'}
            hasMap={false}
            building={building}
            edgeCount={0}
            onOpenSettings={onOpenSettings}
            defaultOpen={besideBuild}
          />
        </div>
      </div>

      {/* Centred in the space beside the left panel, not across it. During the
          first build, in a window with room for both, the Index flyout opens
          beside the panel and the card centres beyond it, keeping that place
          when the flyout closes so nothing jumps. */}
      <div className={`absolute inset-0 flex items-center justify-center p-8 ${besideBuild ? 'pl-[560px]' : 'pl-[280px]'}`}>
        <div className="w-full max-w-[460px] rounded-lg bg-surface-raised/80" data-testid="knowledge-graph-no-map">
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
            <SettingsCard
              icon={<Loader2 size={16} className="animate-spin" />}
              label="Building the map"
              description="Once per project, in the background. Later updates take moments."
              testId="knowledge-graph-building-card"
            >
              <CardSourceList
                readOnly
                lines={[
                  { label: 'Conversations to place', value: coverage.totalDocumentsWithChunks.toLocaleString(), testId: 'knowledge-graph-building-conversations' },
                  { label: 'Embeddings to read', value: conversationEmbeddings.toLocaleString(), testId: 'knowledge-graph-building-embeddings' },
                ]}
              />
            </SettingsCard>
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
  );
}

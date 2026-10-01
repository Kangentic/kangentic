/**
 * The left panel's Index card and the flyout it opens: what the index holds,
 * read as the Settings > Knowledge Graph > Index card without its switches.
 * The same header, the same source lines with their check and count, the same
 * tags, and one button to Settings, where sources change and the index is
 * rebuilt. It is built from the Settings card's own pieces (`SettingsCard`,
 * `CardSourceList` read-only), so the two cannot drift apart.
 *
 * It sits at the bottom of the controls stack on the map, and on its own while
 * there is no map yet (the first build, the Knowledge Graph off).
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Database } from 'lucide-react';
import { OverlayPopover } from '../OverlayPopover';
import { SettingsCard, CardSourceList } from '../settings/settings-card';
import { settingProps } from '../settings/settings-registry';
import { sourceRequirements } from '../settings/tabs/index-sources';
import { useConfigStore } from '../../stores/config-store';
import { agentJobChoice, answerSetupGap, taskSummariesOn } from '../../../shared/answer-agent';
import type { KnowledgeGraphCoverageSummary, KnowledgeGraphIndexSummary } from '../../../shared/types';
import { CARD_CLASS, OpenSettingsButton, SectionHeader } from './panel-card';
import { indexMapLines, indexSourceLines } from './index-panel-lines';

/** Without the graph's left chrome to measure, air kept from the viewport's
 *  edges: the bottom one clears the app's status bar. */
const FLYOUT_FALLBACK_TOP = 8;
const FLYOUT_FALLBACK_BOTTOM_PADDING = 40;
/** Below this the flyout stops shrinking and the page decides. */
const FLYOUT_MIN_HEIGHT = 160;

/**
 * The band the flyout may occupy: the left panel's own column, so it never
 * rises over the graph's header or the app's title bar, nor sinks under the
 * status bar. The panel and the no-map screen both sit in a
 * `data-graph-chrome="left"` column inset from the graph surface.
 */
function flyoutBand(trigger: HTMLElement): { top: number; bottom: number } {
  const column = trigger.closest('[data-graph-chrome="left"]');
  if (column) {
    const box = column.getBoundingClientRect();
    return { top: box.top, bottom: box.bottom };
  }
  return { top: FLYOUT_FALLBACK_TOP, bottom: window.innerHeight - FLYOUT_FALLBACK_BOTTOM_PADDING };
}

/** Whether the header is still in view inside the box that scrolled. */
function headerVisibleIn(trigger: HTMLElement, scroller: Element): boolean {
  const header = trigger.getBoundingClientRect();
  const box = scroller.getBoundingClientRect();
  return header.top >= box.top - 1 && header.bottom <= box.bottom + 1;
}

interface FlyoutPlacement {
  left: number;
  top: number;
  maxHeight: number;
}

export interface KnowledgeGraphIndexCardProps {
  index: KnowledgeGraphIndexSummary;
  coverage: KnowledgeGraphCoverageSummary;
  semanticAvailable: boolean;
  /** A map is drawn for this scope; without one the map line says it is building. */
  hasMap: boolean;
  building: boolean;
  edgeCount: number;
  /** Opens Settings > Knowledge Graph. Absent in the detached window, which has no settings. */
  onOpenSettings?: () => void;
  /** Open on mount. Only while the first map builds in a window with room
   *  beside the building card, when these counts are what there is to look
   *  at; on the map they are reference, so closed. */
  defaultOpen?: boolean;
}

export function KnowledgeGraphIndexCard({
  index, coverage, semanticAvailable, hasMap, building, edgeCount, onOpenSettings, defaultOpen = false,
}: KnowledgeGraphIndexCardProps) {
  const [open, setOpen] = useState(defaultOpen);
  // Opened on its own as the screen arrives, which may be a project switch:
  // that paints flat. A click on the header opens it with its entrance.
  const [openedByDefault, setOpenedByDefault] = useState(defaultOpen);
  const triggerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [placement, setPlacement] = useState<FlyoutPlacement | null>(null);

  // What each source line still waits for, through the rule the Settings card
  // reads. The agent's half comes from config, so choosing one shows at once;
  // whether the Knowledge Graph is on comes from the snapshot, the same signal
  // that shows the map's off card, so the two never disagree.
  const knowledgeGraphConfig = useConfigStore((state) => state.config.knowledgeGraph);
  const agentList = useConfigStore((state) => state.agentList);
  const sourceLines = useMemo(() => {
    const choice = agentJobChoice(knowledgeGraphConfig, 'answer');
    const requirements = sourceRequirements({
      semanticEnabled: semanticAvailable,
      answerCapableAgents: agentList.filter((agent) => agent.found && agent.supportsAnswerFromContext).length,
      agentSetup: answerSetupGap({ agents: agentList, configured: choice.agent, configuredModel: choice.model, requireFound: true }),
      agentChosen: Boolean(choice.agent),
    });
    return indexSourceLines({
      index,
      semanticAvailable,
      summariesOn: taskSummariesOn(knowledgeGraphConfig),
      codeOn: knowledgeGraphConfig?.sourceCode !== false,
      requirements,
    });
  }, [index, semanticAvailable, knowledgeGraphConfig, agentList]);
  const mapLines = useMemo(
    () => indexMapLines({ hasMap, building, edgeCount, coverage, storageBytes: index.storageBytes }),
    [hasMap, building, edgeCount, coverage, index.storageBytes],
  );
  const indexSetting = settingProps('knowledgeGraph.indexingEnabled');

  /**
   * The flyout opens to the SIDE of its card, outside the panel, and stays on
   * screen whatever the panel looks like.
   *
   * To the side because Index is the last card in a column whose middle is a
   * list of every region, forty on a large project, so a section opening
   * downward ran off the window. Outside the panel because the panel scrolls as
   * a whole in a short window, and a scrolling box clips anything inside it.
   *
   * With every card expanded Index sits at the bottom of the window, so the
   * flyout is lifted until its bottom meets the panel's, and capped to the
   * panel's height with its own scroll when even that is not enough; it never
   * rises over the graph's header (`flyoutBand`). Its content grows after it
   * opens (the source lines fill in, a line gains its progress track), so it
   * is placed again whenever that content resizes, and whenever the window
   * does.
   *
   * The panel itself scrolls in a short window with every card open, which
   * carries the header with it. While the header stays in view the flyout
   * follows it; once the header scrolls out of the panel the flyout closes, as
   * a click outside does, rather than float beside nothing.
   */
  const place = useCallback(() => {
    const trigger = triggerRef.current;
    const content = contentRef.current;
    if (!trigger || !content) return;
    const triggerBox = trigger.getBoundingClientRect();
    const band = flyoutBand(trigger);
    const maxHeight = Math.max(FLYOUT_MIN_HEIGHT, band.bottom - band.top);
    const height = Math.min(content.offsetHeight, maxHeight);
    const next: FlyoutPlacement = {
      left: triggerBox.right + 8,
      top: Math.max(band.top, Math.min(triggerBox.top, band.bottom - height)),
      maxHeight,
    };
    setPlacement((current) => (
      current && current.left === next.left && current.top === next.top && current.maxHeight === next.maxHeight ? current : next
    ));
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const content = contentRef.current;
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => place());
    if (observer && content) observer.observe(content);
    window.addEventListener('resize', place);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', place);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (popoverRef.current?.contains(target)) return;
      // The header is the toggle, so let its own handler close it rather than
      // closing here and reopening on the same click.
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    // Escape closes the flyout, not the graph under it: a capture-phase
    // listener registered only while open, as the Projects picker does.
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      setOpen(false);
    };
    // Scroll does not bubble, so capture it at the document to hear the panel's.
    // Only a scroll that carries the header matters: the chat thread scrolls
    // itself while an answer streams, and that moves nothing here.
    const followHeaderScroll = (event: Event) => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const scroller = event.target;
      if (scroller === document) {
        place();
        return;
      }
      if (!(scroller instanceof Element) || !scroller.contains(trigger)) return;
      if (headerVisibleIn(trigger, scroller)) place();
      else setOpen(false);
    };
    document.addEventListener('mousedown', closeOnOutsideClick, true);
    document.addEventListener('keydown', closeOnEscape, true);
    document.addEventListener('scroll', followHeaderScroll, true);
    return () => {
      document.removeEventListener('mousedown', closeOnOutsideClick, true);
      document.removeEventListener('keydown', closeOnEscape, true);
      document.removeEventListener('scroll', followHeaderScroll, true);
    };
  }, [open, place]);

  return (
    <>
      <div ref={triggerRef} className={CARD_CLASS}>
        <SectionHeader
          icon={<Database size={13} aria-hidden />}
          label="Index"
          collapsed={!open}
          onToggle={() => {
            setOpenedByDefault(false);
            setOpen((current) => !current);
          }}
          testId="knowledge-graph-index-toggle"
          opens="side"
        />
      </div>
      <OverlayPopover
        open={open}
        popoverRef={popoverRef}
        portal
        skipEnter={openedByDefault}
        style={placement
          ? { left: placement.left, top: placement.top, maxHeight: placement.maxHeight }
          // Measured before it is placed, so the first frame is invisible.
          : { left: 0, top: 0, visibility: 'hidden' }}
        transformOrigin="left top"
        className="fixed z-[2147483646] w-[360px] overflow-y-auto rounded-lg bg-surface-raised shadow-xl"
        data-testid="knowledge-graph-index-panel"
      >
        <div ref={contentRef}>
          <SettingsCard icon={<Database size={16} />} label={indexSetting.label} description={indexSetting.description}>
            <CardSourceList readOnly lines={sourceLines} testId="knowledge-graph-index-sources" />
            <CardSourceList readOnly lines={mapLines} testId="knowledge-graph-index-facts" />
            {onOpenSettings ? (
              <OpenSettingsButton
                onClick={() => {
                  setOpen(false);
                  onOpenSettings();
                }}
                testId="knowledge-graph-index-settings"
              />
            ) : null}
          </SettingsCard>
        </div>
      </OverlayPopover>
    </>
  );
}

/**
 * The conversation viewer's body: the Route tab row, the placeholder while a
 * jump reads its page, a column's empty state, and the ConversationView itself.
 * It draws what `useConversationState` returns and reads no store, so any host
 * (the Conversation window today) can mount it under its own chrome.
 *
 * It renders a fragment, not a wrapper: the host supplies a flex column with a
 * bounded height (`flex h-full flex-col overflow-hidden`), and the spinner and
 * the tab panel each take the rest of it.
 */

import { useMemo } from 'react';
import { Loader2, MessageSquare } from 'lucide-react';
import { Tabs, tabIds, type TabItem } from '../Tabs';
import { ColumnGlyph } from '../../utils/swimlane-icons';
import { IsolatedIcon } from '../IsolatedBadge';
import { ConversationView } from './ConversationView';
import { ConversationSkeleton } from './ConversationSkeleton';
import { ALL_CONVERSATION_TAB } from './route-slice';
import type { ConversationState } from './use-conversation-state';

const DEFAULT_TAB_ID_PREFIX = 'conversation-route';

interface ConversationBodyProps {
  state: ConversationState;
  /**
   * Whether the host has keyboard focus. Gates the view's `conversation.find`
   * (Mod+F) binding, so of two mounted bodies only the focused one answers it.
   */
  isFocused: boolean;
  /** Whether new turns on a live task scroll the view down to them. */
  autoFollowNewMessages: boolean;
  /** The tab row's element ids. Two bodies mounted at once need two prefixes. */
  tabIdPrefix?: string;
}

export function ConversationBody({
  state,
  isFocused,
  autoFollowNewMessages,
  tabIdPrefix = DEFAULT_TAB_ID_PREFIX,
}: ConversationBodyProps) {
  const {
    response,
    ready,
    route,
    showTabs,
    activeTab,
    columnOnScreen,
    isolatedSwimlaneIds,
    selectTab,
    paging,
    viewPaging,
    slice,
    visibleEntries,
    viewScrollTarget,
    consumeScroll,
    viewInitialPosition,
    searchPlaceholder,
  } = state;

  const tabItems = useMemo<Array<TabItem<string>>>(
    () => [
      { id: ALL_CONVERSATION_TAB, label: 'All' },
      ...route.map((column) => ({
        id: column.swimlaneId,
        label: column.name,
        icon: <ColumnGlyph column={column} size={14} color={column.color} />,
        badge: isolatedSwimlaneIds.has(column.swimlaneId) ? <IsolatedIcon size={13} explained /> : undefined,
      })),
    ],
    [route, isolatedSwimlaneIds],
  );

  if (!ready || !response) {
    return (
      <div className="flex-1 min-h-0 flex items-center justify-center">
        <Loader2 size={20} className="animate-spin text-fg-muted" />
      </div>
    );
  }

  return (
    <>
      {showTabs && (
        <Tabs
          tabs={tabItems}
          selectedId={activeTab}
          onSelect={selectTab}
          ariaLabel="Conversation sections"
          idPrefix={tabIdPrefix}
          fit="icons-then-scroll"
          testId="conversation-route-tabs"
        />
      )}
      {/* One view at one position, tab row or not, so a live task's first
          move (one column to two) adds the tab row above the conversation
          without remounting it. */}
      <div
        role={showTabs ? 'tabpanel' : undefined}
        id={showTabs ? tabIds(tabIdPrefix, activeTab).panelId : undefined}
        aria-labelledby={showTabs ? tabIds(tabIdPrefix, activeTab).tabId : undefined}
        className="flex min-h-0 flex-1 flex-col"
      >
        {paging.jumping ? (
          // A jump is reading the page it lands on: placeholder rows, with
          // the moment it is headed for when it knows one.
          <ConversationSkeleton labelTs={paging.jumpLabelTs} className="min-h-0 flex-1" />
        ) : columnOnScreen && visibleEntries.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center" data-testid="conversation-route-empty">
            <MessageSquare size={24} className="text-fg-disabled" />
            <div className="text-sm font-semibold text-fg-tertiary">No conversation in {columnOnScreen.name}</div>
            <div className="text-sm text-fg-muted">The agent did not run while the task was in {columnOnScreen.name}.</div>
          </div>
        ) : (
          <ConversationView
            // A tab is its own list: switching remounts the view so it opens
            // at that tab's own position rather than the last tab's scroll.
            // A jump that replaced a paged window's rows remounts it too.
            key={`${activeTab}:${paging.generation}`}
            entries={visibleEntries}
            degraded={response.degraded}
            source={response.source}
            unavailableReason={response.unavailableReason}
            agentName={response.agentName ?? ''}
            archivedAgentName={response.archivedAgentName ?? null}
            scrollToTurnUuid={viewScrollTarget}
            onConsumedScroll={consumeScroll}
            autoFollowNewMessages={autoFollowNewMessages}
            initialPosition={viewInitialPosition}
            isFocused={isFocused}
            dividerColumns={slice?.dividerColumns}
            isolatedDividers={slice?.isolatedDividers}
            searchPlaceholder={searchPlaceholder}
            paging={viewPaging}
          />
        )}
      </div>
    </>
  );
}

import { useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { Tooltip } from './Tooltip';

export interface TabItem<TabId extends string> {
  id: TabId;
  label: string;
  /** Drawn before the label. Under `fit="icons-then-scroll"` it is also what an
   *  unselected tab shrinks to when the names do not all fit. */
  icon?: ReactNode;
  /** Drawn after the label, and dropped with it when the tab shrinks to its icon. */
  badge?: ReactNode;
}

/** The id pair one tab and its panel share, so `aria-controls` and `aria-labelledby` agree. */
export function tabIds(idPrefix: string, tabId: string): { tabId: string; panelId: string } {
  return { tabId: `${idPrefix}-tab-${tabId}`, panelId: `${idPrefix}-panel-${tabId}` };
}

/** Whether the row has fallen back to icons, for the tab set it was measured with. */
interface FitState {
  tabsKey: string;
  iconsOnly: boolean;
}

/**
 * An underline tab bar (`role="tablist"`). One tab is in the Tab order, the
 * selected one; the arrow keys, Home and End move between tabs and select the
 * one they land on, as the WAI-ARIA tabs pattern with automatic activation
 * does. These keys are the widget's own navigation, not app shortcuts, so they
 * are not in the keybinding registry. `trailing` sits at the right end of the
 * bar, outside the tablist.
 *
 * `fit="icons-then-scroll"` is for a row whose tab count is data (a task's
 * columns): every tab shows its name while all the names fit; when they do not,
 * every tab but the selected one shows its icon alone, named by a Tooltip and
 * an `aria-label`; when even that overflows, the row scrolls sideways with the
 * selected tab kept in view. It switches by measuring rather than by container
 * query, because where it has to switch depends on how many tabs there are and
 * how long their names run, which no fixed breakpoint knows. The width the
 * names needed is kept, and the row goes back to names only once there is that
 * much room again, so it never flickers at the edge.
 */
export function Tabs<TabId extends string>({
  tabs,
  selectedId,
  onSelect,
  ariaLabel,
  idPrefix,
  trailing,
  testId,
  fit,
}: {
  tabs: ReadonlyArray<TabItem<TabId>>;
  selectedId: TabId;
  onSelect: (tabId: TabId) => void;
  ariaLabel: string;
  idPrefix: string;
  trailing?: ReactNode;
  testId?: string;
  fit?: 'icons-then-scroll';
}) {
  const tabRefs = useRef(new Map<TabId, HTMLButtonElement>());
  const listRef = useRef<HTMLDivElement>(null);
  const namesWidthRef = useRef<{ tabsKey: string; width: number } | null>(null);
  const [fitState, setFitState] = useState<FitState>({ tabsKey: '', iconsOnly: false });

  // A changed tab set reads as "names" until it is measured, so a column added
  // while the window is open gets its name back without a reset effect. A badge
  // counts too: one that arrives later widens the names the row has to fit.
  const tabsKey = tabs.map((tab) => `${tab.id}\u0000${tab.label}\u0000${tab.badge ? 1 : 0}`).join('\u0001');
  const iconsOnly = fit !== undefined && fitState.tabsKey === tabsKey && fitState.iconsOnly;

  // `selectedId` re-arms the observer, whose first callback re-measures: the
  // selected tab's name is bold, so a new selection changes the width the
  // names need while the row's own box, which is all the observer watches,
  // stays the same.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!fit || !list) return;
    // The observer's first callback lands before the next paint, so the row is
    // measured and switched without ever showing a clipped frame.
    const observer = new ResizeObserver(() => {
      const available = list.clientWidth;
      if (!iconsOnly) {
        const needed = list.scrollWidth;
        namesWidthRef.current = { tabsKey, width: needed };
        if (needed > available + 1) setFitState({ tabsKey, iconsOnly: true });
        return;
      }
      const names = namesWidthRef.current;
      if (names && names.tabsKey === tabsKey && available >= names.width) setFitState({ tabsKey, iconsOnly: false });
    });
    observer.observe(list);
    return () => observer.disconnect();
  }, [fit, tabsKey, iconsOnly, selectedId]);

  // When even the icons overflow, keep the selected tab on screen.
  useLayoutEffect(() => {
    const list = listRef.current;
    if (!fit || !iconsOnly || !list || list.scrollWidth <= list.clientWidth) return;
    tabRefs.current.get(selectedId)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [fit, iconsOnly, selectedId]);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    const currentIndex = tabs.findIndex((tab) => tab.id === selectedId);
    let nextIndex: number;
    switch (event.key) {
      case 'ArrowRight': nextIndex = (currentIndex + 1) % tabs.length; break;
      case 'ArrowLeft': nextIndex = (currentIndex - 1 + tabs.length) % tabs.length; break;
      case 'Home': nextIndex = 0; break;
      case 'End': nextIndex = tabs.length - 1; break;
      default: return;
    }
    event.preventDefault();
    const nextTab = tabs[nextIndex];
    onSelect(nextTab.id);
    tabRefs.current.get(nextTab.id)?.focus();
  };

  const listClass = fit
    ? `flex h-full min-w-0 flex-1 items-stretch gap-0.5 ${iconsOnly ? 'overflow-x-auto [scrollbar-width:none]' : 'overflow-hidden'}`
    : 'flex h-full items-stretch gap-0.5';

  return (
    <div className="flex h-10 flex-shrink-0 items-center gap-0.5 border-b border-edge pl-2 pr-2.5" data-testid={testId}>
      <div
        ref={listRef}
        role="tablist"
        aria-label={ariaLabel}
        className={listClass}
        onKeyDown={handleKeyDown}
        data-fit-icons-only={fit ? (iconsOnly ? 'true' : 'false') : undefined}
      >
        {tabs.map((tab) => {
          const selected = tab.id === selectedId;
          const ids = tabIds(idPrefix, tab.id);
          const iconAlone = iconsOnly && !selected && tab.icon !== undefined;
          return (
            <Tooltip key={tab.id} label={iconAlone ? tab.label : ''}>
              <button
                ref={(element) => {
                  if (element) tabRefs.current.set(tab.id, element);
                  else tabRefs.current.delete(tab.id);
                }}
                type="button"
                role="tab"
                id={ids.tabId}
                aria-selected={selected}
                aria-controls={ids.panelId}
                aria-label={iconAlone ? tab.label : undefined}
                tabIndex={selected ? 0 : -1}
                onClick={() => onSelect(tab.id)}
                className={`flex flex-shrink-0 items-center gap-[7px] whitespace-nowrap border-b-2 pt-0.5 text-[13px] transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent ${
                  iconAlone ? 'px-2.5' : 'px-3'
                } ${
                  selected ? 'border-accent font-semibold text-fg' : 'border-transparent text-fg-muted hover:text-fg-secondary'
                }`}
                data-testid={testId ? `${testId}-${tab.id}` : undefined}
              >
                {tab.icon}
                {!iconAlone && tab.label}
                {!iconAlone && tab.badge}
              </button>
            </Tooltip>
          );
        })}
      </div>
      {trailing && <div className="ml-auto flex items-center">{trailing}</div>}
    </div>
  );
}

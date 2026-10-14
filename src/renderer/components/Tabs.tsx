import { useRef } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';

export interface TabItem<TabId extends string> {
  id: TabId;
  label: string;
}

/** The id pair one tab and its panel share, so `aria-controls` and `aria-labelledby` agree. */
export function tabIds(idPrefix: string, tabId: string): { tabId: string; panelId: string } {
  return { tabId: `${idPrefix}-tab-${tabId}`, panelId: `${idPrefix}-panel-${tabId}` };
}

/**
 * An underline tab bar (`role="tablist"`). One tab is in the Tab order, the
 * selected one; the arrow keys, Home and End move between tabs and select the
 * one they land on, as the WAI-ARIA tabs pattern with automatic activation
 * does. These keys are the widget's own navigation, not app shortcuts, so they
 * are not in the keybinding registry. `trailing` sits at the right end of the
 * bar, outside the tablist.
 */
export function Tabs<TabId extends string>({
  tabs,
  selectedId,
  onSelect,
  ariaLabel,
  idPrefix,
  trailing,
  testId,
}: {
  tabs: ReadonlyArray<TabItem<TabId>>;
  selectedId: TabId;
  onSelect: (tabId: TabId) => void;
  ariaLabel: string;
  idPrefix: string;
  trailing?: ReactNode;
  testId?: string;
}) {
  const tabRefs = useRef(new Map<TabId, HTMLButtonElement>());

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

  return (
    <div className="flex h-10 flex-shrink-0 items-center gap-0.5 border-b border-edge pl-2 pr-2.5" data-testid={testId}>
      <div role="tablist" aria-label={ariaLabel} className="flex h-full items-stretch gap-0.5" onKeyDown={handleKeyDown}>
        {tabs.map((tab) => {
          const selected = tab.id === selectedId;
          const ids = tabIds(idPrefix, tab.id);
          return (
            <button
              key={tab.id}
              ref={(element) => {
                if (element) tabRefs.current.set(tab.id, element);
                else tabRefs.current.delete(tab.id);
              }}
              type="button"
              role="tab"
              id={ids.tabId}
              aria-selected={selected}
              aria-controls={ids.panelId}
              tabIndex={selected ? 0 : -1}
              onClick={() => onSelect(tab.id)}
              className={`flex items-center border-b-2 px-3 pt-0.5 text-[13px] transition-colors focus:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent ${
                selected ? 'border-accent font-semibold text-fg' : 'border-transparent text-fg-muted hover:text-fg-secondary'
              }`}
              data-testid={testId ? `${testId}-${tab.id}` : undefined}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {trailing && <div className="ml-auto flex items-center">{trailing}</div>}
    </div>
  );
}

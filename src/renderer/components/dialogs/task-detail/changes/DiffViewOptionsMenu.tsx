import { SlidersHorizontal, Settings } from 'lucide-react';
import { KebabMenu, KebabMenuItem, KebabMenuCheckItem, KebabMenuDivider } from '../../../KebabMenu';
import { useConfigStore } from '../../../../stores/config-store';

/** Shared styling for the diff toolbar buttons: a clear hover background (matching
 *  the rest of the app) and a brief press effect so a click visibly registers.
 *  `active` renders the pressed/selected state for toggles and the current view mode.
 *  Lives here rather than in DiffViewer because ChangesPanel's no-file toolbar
 *  renders the same button family and must not drift from it. */
export function diffToolbarButtonClass(active: boolean): string {
  return `p-1.5 rounded transition active:scale-90 ${
    active
      ? 'bg-surface-raised text-fg'
      : 'text-fg-muted hover:text-fg hover:bg-surface-hover'
  }`;
}

interface DiffViewOptionsMenuProps {
  /** Blame is a per-FILE inspection overlay owned by the mounted DiffViewer, so
   *  it is passed in rather than read from config (it is deliberately never
   *  persisted). Omit it where there is no file to annotate - ChangesPanel's
   *  no-file toolbar - and the row plus its divider are left out entirely
   *  rather than shown disabled, since "unavailable" would imply this file
   *  cannot be blamed when in fact there is no file at all. */
  blame?: {
    on: boolean;
    unavailable: boolean;
    onToggle: () => void;
  };
}

/**
 * The diff's "View options" menu: the persisted rendering preferences, the
 * optional blame overlay, and a jump to the settings page that owns the same
 * keys.
 *
 * These were four icon-only toggles (pilcrow, fold, wrap, person) that no one
 * could read without hovering, and whose detail did not survive 16px. They are
 * one labelled menu now - the treatment VS Code's diff `...` menu and GitHub's
 * diff settings both use - so every option states its own name.
 *
 * Extracted from DiffViewer so the menu has ONE definition across the two
 * places it appears. DiffViewer only mounts once a file is selected, which left
 * a clean worktree with no route to these preferences at all; ChangesPanel now
 * renders the same menu in a file-less toolbar row.
 */
export function DiffViewOptionsMenu({ blame }: DiffViewOptionsMenuProps) {
  const ignoreWhitespace = useConfigStore((state) => state.config.diffIgnoreWhitespace);
  const collapseUnchanged = useConfigStore((state) => state.config.diffCollapseUnchanged);
  const wrapLines = useConfigStore((state) => state.config.diffWrapLines);
  const useInlineWhenNarrow = useConfigStore((state) => state.config.diffUseInlineWhenNarrow);
  const updateConfig = useConfigStore((state) => state.updateConfig);
  const setSettingsOpen = useConfigStore((state) => state.setSettingsOpen);
  const setLastSettingsTab = useConfigStore((state) => state.setLastSettingsTab);

  return (
    <KebabMenu
      icon={<SlidersHorizontal size={16} />}
      title="View options"
      triggerClassName={diffToolbarButtonClass(false)}
      triggerTestId="diff-view-options"
      menuTestId="diff-view-options-menu"
    >
      {(close) => (
        <>
          <KebabMenuCheckItem
            label="Ignore whitespace"
            checked={ignoreWhitespace}
            onChange={() => updateConfig({ diffIgnoreWhitespace: !ignoreWhitespace })}
            data-testid="diff-ignore-whitespace"
          />
          <KebabMenuCheckItem
            label="Collapse unchanged"
            checked={collapseUnchanged}
            onChange={() => updateConfig({ diffCollapseUnchanged: !collapseUnchanged })}
            data-testid="diff-collapse-unchanged"
          />
          <KebabMenuCheckItem
            label="Wrap long lines"
            checked={wrapLines}
            onChange={() => updateConfig({ diffWrapLines: !wrapLines })}
            data-testid="diff-wrap-lines"
          />
          <KebabMenuCheckItem
            label="Inline when narrow"
            checked={useInlineWhenNarrow}
            onChange={() => updateConfig({ diffUseInlineWhenNarrow: !useInlineWhenNarrow })}
            data-testid="diff-inline-when-narrow"
          />
          {blame && (
            <>
              <KebabMenuDivider />
              <KebabMenuCheckItem
                label="Show blame"
                checked={blame.on}
                disabled={blame.unavailable}
                title={blame.unavailable ? 'Blame is unavailable for this file' : undefined}
                onChange={blame.onToggle}
                data-testid="diff-blame-toggle"
              />
            </>
          )}
          <KebabMenuDivider />
          {/* Names the DESTINATION, not the topic: "Diff settings..." read as
              another submenu of the same options rather than a jump to the
              app's Settings panel. Gear plus "Open settings" is the whole
              promise; qualifying it with the tab name only restated the surface
              the menu is already attached to. It does land on the Changes tab. */}
          <KebabMenuItem
            icon={<Settings size={12} />}
            label="Open settings"
            onClick={() => {
              setLastSettingsTab('changes');
              setSettingsOpen(true);
              close();
            }}
            data-testid="diff-open-settings"
          />
        </>
      )}
    </KebabMenu>
  );
}

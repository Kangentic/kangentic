import { useLingui } from '@lingui/react/macro';
import { EllipsisVertical } from 'lucide-react';
import { Tooltip } from '../../Tooltip';

/** The menu button's width and height, in px. The Actions column is sized from it. */
export const ROW_MENU_BUTTON_SIZE_PX = 28;
const ROW_MENU_BUTTON_STYLE = { width: ROW_MENU_BUTTON_SIZE_PX, height: ROW_MENU_BUTTON_SIZE_PX };

/**
 * A backlog row's one action control: a more-actions button that opens the row's menu (the
 * same `BacklogContextMenu` a right-click opens) anchored under it. It acts on this row only,
 * never the selection, and never toggles the row's selection itself.
 */
export function BacklogRowActions({
  itemId,
  menuOpen,
  onOpenMenu,
}: {
  itemId: string;
  menuOpen: boolean;
  /** Opens the row's menu under the button, or closes it when this row's menu is the one open. */
  onOpenMenu: (itemId: string, button: HTMLElement) => void;
}) {
  const { t } = useLingui();
  const itemActionsLabel = t`Item actions`;
  return (
    <div className="flex items-center justify-end">
      <Tooltip label={t`Edit, move or delete`} enabled={!menuOpen}>
        <button
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onOpenMenu(itemId, event.currentTarget);
          }}
          onDoubleClick={(event) => event.stopPropagation()}
          style={ROW_MENU_BUTTON_STYLE}
          className={`flex items-center justify-center rounded transition-colors ${
            menuOpen ? 'text-fg bg-surface-hover/60' : 'text-fg-muted hover:text-fg hover:bg-surface-hover/40'
          }`}
          aria-label={itemActionsLabel}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          data-testid="backlog-row-menu-btn"
        >
          <EllipsisVertical size={16} />
        </button>
      </Tooltip>
    </div>
  );
}

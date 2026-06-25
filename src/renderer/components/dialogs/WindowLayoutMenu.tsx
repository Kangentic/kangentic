/**
 * Tile-layout picker shared by every window-manager window (task-detail and
 * command-terminal): a one-click menu of snap / tiling presets, the menu
 * equivalent of the snap keyboard shortcuts + Win11 layouts. Half presets snap
 * this window; columns / grid tile every open window in the layer and are
 * disabled until a second window exists. Mirrors KebabMenu's portal +
 * click-outside so the menu escapes the window frame's overflow clip.
 */
import { useState, useRef, useEffect, type ReactNode } from 'react';
import { PanelLeft, PanelRight, PanelTop, PanelBottom, Columns2, LayoutGrid } from 'lucide-react';
import { usePopoverPosition } from '../../hooks/usePopoverPosition';
import { KebabMenuItem } from '../KebabMenu';
import { OverlayPopover } from '../OverlayPopover';
import { TILE_PRESETS, type TilePreset } from '../../window-manager/tiling/presets';

/** Icon + label + multi-window flag for each tiling preset, in menu order. */
const TILE_PRESET_META: Record<TilePreset, { icon: ReactNode; label: string; multiWindow: boolean }> = {
  'left-half': { icon: <PanelLeft size={15} />, label: 'Snap left', multiWindow: false },
  'right-half': { icon: <PanelRight size={15} />, label: 'Snap right', multiWindow: false },
  'top-half': { icon: <PanelTop size={15} />, label: 'Snap top', multiWindow: false },
  'bottom-half': { icon: <PanelBottom size={15} />, label: 'Snap bottom', multiWindow: false },
  columns: { icon: <Columns2 size={15} />, label: 'Columns', multiWindow: true },
  grid: { icon: <LayoutGrid size={15} />, label: 'Grid', multiWindow: true },
};

export function WindowLayoutMenu({
  onApply,
  canTileMultiple,
}: {
  onApply: (preset: TilePreset) => void;
  canTileMultiple: boolean;
}) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const { style } = usePopoverPosition(containerRef, popoverRef, open, { mode: 'dropdown', strategy: 'fixed' });

  useEffect(() => {
    if (!open) return;
    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!containerRef.current?.contains(target) && !popoverRef.current?.contains(target)) setOpen(false);
    };
    document.addEventListener('mousedown', handleClick, true);
    return () => document.removeEventListener('mousedown', handleClick, true);
  }, [open]);

  return (
    <div className="relative flex-shrink-0" ref={containerRef}>
      <button
        onClick={() => setOpen((value) => !value)}
        className="p-1.5 text-fg-faint hover:text-fg-tertiary hover:bg-surface-hover rounded transition-colors"
        title="Tile layout"
        aria-label="Tile layout"
        data-testid="window-tile-layout"
      >
        <LayoutGrid size={16} />
      </button>
      <OverlayPopover
        open={open}
        popoverRef={popoverRef}
        style={style}
        portal
        className="fixed min-w-[160px] bg-surface-raised border border-edge-input rounded-md shadow-xl z-[2147483646] py-1"
      >
        {TILE_PRESETS.map((preset) => {
          const meta = TILE_PRESET_META[preset];
          return (
            <KebabMenuItem
              key={preset}
              icon={meta.icon}
              label={meta.label}
              disabled={meta.multiWindow && !canTileMultiple}
              onClick={() => {
                onApply(preset);
                setOpen(false);
              }}
              data-testid={`tile-preset-${preset}`}
            />
          );
        })}
      </OverlayPopover>
    </div>
  );
}

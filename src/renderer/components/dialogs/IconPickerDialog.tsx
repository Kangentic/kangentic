import { useEffect, useMemo, useState } from 'react';
import { Search, Smile } from 'lucide-react';
import { BaseDialog } from './BaseDialog';
import { Tooltip } from '../Tooltip';
import { getLoadedIconCatalog, loadIconCatalog, type IconEntry } from '../../utils/icon-registry';
import { tipLabel } from '../../utils/tooltip';

/** Why a used icon cannot be picked: each column's icon is its own. */
const USED_ICON_REASON = 'Another column uses this icon';

interface IconPickerDialogProps {
  onClose: () => void;
  onSelect: (iconName: string | null) => void;
  selectedIcon: string | null;
  accentColor?: string;
  usedIcons?: Set<string>;
  /** Hide the "None" option (color dot). Useful when a selection is required. */
  hideNone?: boolean;
}

const EMPTY_SET = new Set<string>();
const NO_ICONS: IconEntry[] = [];
const DEFAULT_ACCENT = '#3b82f6';

/**
 * The whole glyph list, which loads with the picker rather than with the board. A map already in
 * hand (an earlier open, or the Icon button's hover warm-up) seeds the first render, so the grid
 * paints with the dialog instead of a frame after it.
 */
function useAllIcons(): { icons: IconEntry[]; failed: boolean } {
  const [state, setState] = useState<{ icons: IconEntry[]; failed: boolean }>(
    () => ({ icons: getLoadedIconCatalog()?.ALL_ICONS ?? NO_ICONS, failed: false }),
  );
  const loaded = state.icons !== NO_ICONS;
  useEffect(() => {
    if (loaded) return;
    let current = true;
    loadIconCatalog().then(
      (catalog) => { if (current) setState({ icons: catalog.ALL_ICONS, failed: false }); },
      () => { if (current) setState({ icons: NO_ICONS, failed: true }); },
    );
    return () => { current = false; };
  }, [loaded]);
  return state;
}

export function IconPickerDialog({
  onClose,
  onSelect,
  selectedIcon,
  accentColor = DEFAULT_ACCENT,
  usedIcons = EMPTY_SET,
  hideNone = false,
}: IconPickerDialogProps) {
  const [query, setQuery] = useState('');
  const { icons: allIcons, failed } = useAllIcons();
  const loading = allIcons.length === 0 && !failed;

  const filtered = useMemo(() => {
    if (!query.trim()) return allIcons;
    const q = query.toLowerCase();
    return allIcons.filter(
      (entry) =>
        entry.name.includes(q) || entry.label.toLowerCase().includes(q),
    );
  }, [allIcons, query]);

  return (
    <BaseDialog
      onClose={onClose}
      title="Choose Icon"
      icon={<Smile size={14} className="text-fg-muted" />}
      className="w-[480px] h-[40vh]"
      rawBody
      zIndex="z-[60]"
    >
      {/* Sticky search bar */}
      <div className="sticky top-0 z-10 bg-surface-raised px-4 pt-3 pb-2 border-b border-edge">
        <div className="relative">
          <Search
            size={12}
            className="absolute left-2 top-1/2 -translate-y-1/2 text-fg-disabled"
          />
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search icons..."
            autoFocus
            className="w-full bg-surface/50 border border-edge/50 rounded text-xs text-fg-tertiary placeholder-fg-muted pl-7 pr-2 py-1.5 outline-none focus:border-edge-input"
          />
        </div>
      </div>

      {/* Scrollable icon grid */}
      <div className="px-4 py-3 overflow-y-auto flex-1 min-h-0">
        <div className="flex flex-wrap gap-1">
          {/* None option */}
          {!hideNone && (
            <Tooltip label="None">
              <button
                type="button"
                onClick={() => onSelect(null)}
                className={`w-8 h-8 rounded flex items-center justify-center border transition-all ${
                  selectedIcon === null
                    ? 'border-white bg-surface-hover'
                    : 'border-transparent text-fg-muted hover:text-fg-secondary hover:bg-surface-raised'
                }`}
                aria-label="None"
              >
                <div
                  className="w-2.5 h-2.5 rounded-full"
                  style={{ backgroundColor: accentColor }}
                />
              </button>
            </Tooltip>
          )}

          {/* Icon buttons */}
          {filtered.map((entry) => {
            const isUsed = usedIcons.has(entry.name);
            const isSelected = selectedIcon === entry.name;
            return (
              <Tooltip
                key={entry.name}
                label={tipLabel({ disabled: isUsed, disabledReason: USED_ICON_REASON, tip: entry.label })}
              >
                <button
                  type="button"
                  onClick={() => onSelect(entry.name)}
                  disabled={isUsed}
                  className={`w-8 h-8 rounded flex items-center justify-center border transition-all ${
                    isUsed
                      ? 'opacity-30 cursor-not-allowed border-transparent'
                      : isSelected
                        ? 'border-white bg-surface-hover'
                        : 'border-transparent text-fg-muted hover:text-fg-secondary hover:bg-surface-raised'
                  }`}
                  aria-label={entry.label}
                >
                  <entry.component
                    size={16}
                    strokeWidth={1.75}
                    style={isSelected ? { color: accentColor } : undefined}
                  />
                </button>
              </Tooltip>
            );
          })}
        </div>

        {loading && (
          <div className="text-sm text-fg-disabled text-center py-6" data-testid="icon-picker-loading">
            Loading icons
          </div>
        )}
        {failed && (
          <div className="text-sm text-fg-disabled text-center py-6" data-testid="icon-picker-failed">
            Icons failed to load. Restart Kangentic to try again.
          </div>
        )}
        {!loading && !failed && filtered.length === 0 && query && (
          <div className="text-sm text-fg-disabled text-center py-6">
            No icons match "{query}"
          </div>
        )}
      </div>
    </BaseDialog>
  );
}

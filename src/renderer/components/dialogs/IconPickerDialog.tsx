import { useMemo, useState } from 'react';
import { Smile } from 'lucide-react';
import { BaseDialog } from './BaseDialog';
import { ALL_ICONS, ICON_REGISTRY } from '../../utils/swimlane-icons';

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
const DEFAULT_ACCENT = '#3b82f6';

export function IconPickerDialog({
  onClose,
  onSelect,
  selectedIcon,
  accentColor = DEFAULT_ACCENT,
  usedIcons = EMPTY_SET,
  hideNone = false,
}: IconPickerDialogProps) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    if (!query.trim()) return ALL_ICONS;
    const q = query.toLowerCase();
    return ALL_ICONS.filter(
      (entry) =>
        entry.name.includes(q) || entry.label.toLowerCase().includes(q),
    );
  }, [query]);

  const SearchIcon = ICON_REGISTRY.get('search')!;

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
          <SearchIcon
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
            <button
              type="button"
              onClick={() => onSelect(null)}
              className={`w-8 h-8 rounded flex items-center justify-center border transition-all ${
                selectedIcon === null
                  ? 'border-white bg-surface-hover'
                  : 'border-transparent text-fg-muted hover:text-fg-secondary hover:bg-surface-raised'
              }`}
              title="None"
            >
              <div
                className="w-2.5 h-2.5 rounded-full"
                style={{ backgroundColor: accentColor }}
              />
            </button>
          )}

          {/* Icon buttons */}
          {filtered.map((entry) => {
            const isUsed = usedIcons.has(entry.name);
            const isSelected = selectedIcon === entry.name;
            return (
              <button
                key={entry.name}
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
                title={entry.label}
              >
                <entry.component
                  size={16}
                  strokeWidth={1.75}
                  style={isSelected ? { color: accentColor } : undefined}
                />
              </button>
            );
          })}
        </div>

        {filtered.length === 0 && query && (
          <div className="text-xs text-fg-disabled text-center py-6">
            No icons match "{query}"
          </div>
        )}
      </div>
    </BaseDialog>
  );
}

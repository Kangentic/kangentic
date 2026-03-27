import { useEffect, useRef } from 'react';
import { File, Folder, Loader2 } from 'lucide-react';
import type { ProjectSearchEntry } from '../../shared/types';
import { basenameOfMentionPath } from '../utils/description-mentions';

interface DescriptionMentionMenuProps {
  items: ProjectSearchEntry[];
  isLoading: boolean;
  activeIndex: number;
  helperText: string;
  onSelect: (item: ProjectSearchEntry) => void;
  onHover: (index: number) => void;
}

export function DescriptionMentionMenu({
  items,
  isLoading,
  activeIndex,
  helperText,
  onSelect,
  onHover,
}: DescriptionMentionMenuProps) {
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    itemRefs.current.length = items.length;
    if (items.length === 0) return;
    itemRefs.current[activeIndex]?.scrollIntoView({
      block: 'nearest',
    });
  }, [activeIndex, items]);

  return (
    <div
      className="absolute inset-x-3 bottom-3 z-10 overflow-hidden rounded-md border border-edge-input bg-surface-raised shadow-xl"
      data-testid="description-mention-menu"
    >
      <div className="max-h-60 overflow-y-auto py-1">
        {items.length === 0 ? (
          <div className="px-3 py-2 text-xs text-fg-faint">
            <div className="flex items-center gap-2">
              {isLoading && <Loader2 size={12} className="animate-spin" />}
              <span>{helperText}</span>
            </div>
          </div>
        ) : (
          items.map((item, index) => {
            const Icon = item.kind === 'directory' ? Folder : File;
            return (
              <button
                key={`${item.kind}:${item.path}`}
                type="button"
                data-testid="description-mention-item"
                ref={(element) => {
                  itemRefs.current[index] = element;
                }}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => onHover(index)}
                onClick={() => onSelect(item)}
                className={`flex w-full items-center gap-2 px-3 py-2 text-left transition-colors ${
                  index === activeIndex ? 'bg-surface-hover' : ''
                }`}
              >
                <Icon size={14} className="shrink-0 text-fg-faint" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-xs font-medium text-fg">
                    {basenameOfMentionPath(item.path)}
                  </div>
                  <div className="truncate text-[11px] text-fg-faint">
                    {item.parentPath ?? ''}
                  </div>
                </div>
              </button>
            );
          })
        )}
      </div>
    </div>
  );
}

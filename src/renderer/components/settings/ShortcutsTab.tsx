import React, { useState, useEffect, useCallback, useRef } from 'react';
import { DndContext, closestCenter, PointerSensor, useSensor, useSensors, type DragEndEvent } from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Plus, Trash2, GripVertical, ChevronDown, ChevronRight, Info, Zap } from 'lucide-react';
import { useBoardStore } from '../../stores/board-store';
import { IconPickerDialog } from '../dialogs/IconPickerDialog';
import { ICON_REGISTRY } from '../../utils/swimlane-icons';
import { SectionHeader, Select, INPUT_CLASS } from './shared';
import type { ShortcutConfig, ShortcutDisplay } from '../../../shared/types';

interface ShortcutEditState extends ShortcutConfig {
  source: 'team' | 'local';
}

/** Stable ID for dnd-kit (index-based fallback when id is missing). */
function getSortableId(action: ShortcutEditState, index: number): string {
  return action.id ?? `__new_${index}`;
}

const PRESETS: { label: string; action: Omit<ShortcutConfig, 'id'>; platform?: string | string[]; category: string }[] = [
  // Editors (cross-platform unless noted)
  { label: 'VS Code', category: 'Editors', action: { label: 'VS Code', icon: 'code', command: 'code "{{cwd}}"', display: 'both' } },
  { label: 'Cursor', category: 'Editors', action: { label: 'Cursor', icon: 'code', command: 'cursor "{{cwd}}"', display: 'both' } },
  { label: 'Zed', category: 'Editors', action: { label: 'Zed', icon: 'code', command: 'zed "{{cwd}}"' }, platform: ['darwin', 'linux'] },
  { label: 'Sublime Text', category: 'Editors', action: { label: 'Sublime Text', icon: 'code', command: 'subl "{{cwd}}"' } },
  { label: 'WebStorm', category: 'Editors', action: { label: 'WebStorm', icon: 'code', command: 'webstorm "{{cwd}}"' } },
  { label: 'IntelliJ IDEA', category: 'Editors', action: { label: 'IntelliJ IDEA', icon: 'code', command: 'idea "{{cwd}}"' } },

  // Git (cross-platform unless noted)
  { label: 'GitHub Desktop', category: 'Git', action: { label: 'GitHub Desktop', icon: 'github', command: 'github "{{cwd}}"' }, platform: ['win32', 'darwin'] },
  { label: 'Fork', category: 'Git', action: { label: 'Fork', icon: 'git-fork', command: 'fork open "{{cwd}}"' }, platform: 'win32' },
  { label: 'Fork', category: 'Git', action: { label: 'Fork', icon: 'git-fork', command: 'open -a Fork "{{cwd}}"' }, platform: 'darwin' },
  { label: 'GitKraken', category: 'Git', action: { label: 'GitKraken', icon: 'git-branch', command: 'gitkraken -p "{{cwd}}"' } },
  { label: 'TortoiseGit Log', category: 'Git', action: { label: 'TortoiseGit Log', icon: 'git-branch', command: 'TortoiseGitProc /command:log /path:"{{cwd}}"' }, platform: 'win32' },
  { label: 'TortoiseGit Commit', category: 'Git', action: { label: 'TortoiseGit Commit', icon: 'git-commit-horizontal', command: 'TortoiseGitProc /command:commit /path:"{{cwd}}"' }, platform: 'win32' },

  // Files & Terminal (platform-specific)
  { label: 'File Explorer', category: 'Files & Terminal', action: { label: 'File Explorer', icon: 'folder-open', command: 'explorer "{{cwd}}"' }, platform: 'win32' },
  { label: 'Finder', category: 'Files & Terminal', action: { label: 'Finder', icon: 'folder-open', command: 'open "{{cwd}}"' }, platform: 'darwin' },
  { label: 'File Manager', category: 'Files & Terminal', action: { label: 'File Manager', icon: 'folder-open', command: 'xdg-open "{{cwd}}"' }, platform: 'linux' },
  { label: 'Windows Terminal', category: 'Files & Terminal', action: { label: 'Windows Terminal', icon: 'terminal', command: 'wt -d "{{cwd}}"' }, platform: 'win32' },
  { label: 'Terminal', category: 'Files & Terminal', action: { label: 'Terminal', icon: 'terminal', command: 'open -a Terminal "{{cwd}}"' }, platform: 'darwin' },
  { label: 'iTerm2', category: 'Files & Terminal', action: { label: 'iTerm2', icon: 'terminal', command: 'open -a iTerm "{{cwd}}"' }, platform: 'darwin' },
  { label: 'Alacritty', category: 'Files & Terminal', action: { label: 'Alacritty', icon: 'terminal', command: 'alacritty --working-directory "{{cwd}}"' } },
];

function getFilteredPresets(): typeof PRESETS {
  const platform = window.electronAPI?.platform;
  return PRESETS.filter((preset) => {
    if (!preset.platform) return true;
    if (Array.isArray(preset.platform)) return preset.platform.includes(platform);
    return preset.platform === platform;
  });
}

/** Strip `source` from edit state to get a plain ShortcutConfig. */
function stripSource({ source: _source, ...rest }: ShortcutEditState): ShortcutConfig {
  return rest;
}

// --- Sortable item component ---

interface SortableActionItemProps {
  action: ShortcutEditState;
  index: number;
  sortableId: string;
  isEditing: boolean;
  iconPickerOpen: boolean;
  onToggleEdit: () => void;
  onRemove: () => void;
  onUpdate: (partial: Partial<ShortcutEditState>) => void;
  onUpdateAndSave: (partial: Partial<ShortcutEditState>) => void;
  onCommitEdit: () => void;
  onOpenIconPicker: () => void;
  onCloseIconPicker: (selectedIcon: string | null) => void;
}

function SortableActionItem({
  action,
  sortableId,
  isEditing,
  iconPickerOpen,
  onToggleEdit,
  onRemove,
  onUpdate,
  onUpdateAndSave,
  onCommitEdit,
  onOpenIconPicker,
  onCloseIconPicker,
}: SortableActionItemProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: sortableId });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition: transition || undefined,
    opacity: isDragging ? 0.4 : 1,
    zIndex: isDragging ? 10 : undefined,
  };

  const Icon = ICON_REGISTRY.get(action.icon ?? 'zap') ?? Zap;

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="border border-edge-input rounded-lg bg-surface-hover/30"
    >
      {/* Summary row */}
      <div
        className="flex items-center gap-2 px-3 py-2 cursor-pointer hover:bg-surface-hover/50 rounded-lg transition-colors"
        onClick={onToggleEdit}
      >
        <div
          className="flex-shrink-0 cursor-grab active:cursor-grabbing text-fg-disabled hover:text-fg-muted"
          {...attributes}
          {...listeners}
          onClick={(event) => event.stopPropagation()}
        >
          <GripVertical size={14} />
        </div>
        <Icon size={16} className="text-fg-muted flex-shrink-0" />
        <span className="text-sm text-fg font-medium truncate flex-1">{action.label}</span>
        <span
          className={`text-[11px] font-medium px-1.5 py-0.5 rounded ${action.source === 'team' ? 'bg-accent/15 text-accent border border-accent/25' : 'bg-fg-disabled/15 text-fg-muted border border-fg-disabled/25'}`}
          title={action.source === 'team' ? 'Shared with team via kangentic.json' : 'Personal shortcut in kangentic.local.json'}
        >
          {action.source === 'team' ? 'Team' : 'Personal'}
        </span>
        <span
          className={`text-[11px] font-medium px-1.5 py-0.5 rounded border ${
            action.display === 'both' || !action.display
              ? 'bg-blue-500/15 text-blue-400 border-blue-500/25'
              : 'bg-surface-hover/80 text-fg-faint border-edge-input/50'
          }`}
          title={
            !action.display || action.display === 'menu'
              ? 'Appears in the task detail kebab menu only'
              : action.display === 'both'
                ? 'Appears in both the header bar and kebab menu'
                : 'Appears in the task detail header bar only'
          }
        >
          {!action.display || action.display === 'menu' ? 'Menu' : action.display === 'both' ? 'Both' : 'Header'}
        </span>
        <button
          onClick={(event) => { event.stopPropagation(); onRemove(); }}
          className="p-1 text-fg-disabled hover:text-red-400 transition-colors"
          title="Remove"
        >
          <Trash2 size={14} />
        </button>
      </div>

      {/* Edit form */}
      {isEditing && (
        <div className="px-3 pb-3 space-y-3 border-t border-edge-input/50 pt-3">
          {/* Icon + Label on same row */}
          <div className="flex gap-3">
            <div className="flex-shrink-0">
              <label className="text-xs text-fg-muted mb-1 block">Icon</label>
              <button
                type="button"
                onClick={onOpenIconPicker}
                className="bg-surface-hover border border-edge-input rounded px-3 py-1.5 text-sm text-fg flex items-center gap-2 cursor-pointer hover:border-fg-faint transition-colors group focus:outline-none focus:border-accent"
              >
                {(() => {
                  const iconName = action.icon ?? 'zap';
                  const IconComp = ICON_REGISTRY.get(iconName) ?? Zap;
                  return <IconComp size={14} strokeWidth={1.75} className="text-fg-muted flex-shrink-0" />;
                })()}
                <span className="text-xs text-fg-tertiary truncate">
                  {action.icon ?? 'zap'}
                </span>
                <ChevronRight size={14} className="text-fg-faint group-hover:text-fg-muted flex-shrink-0 ml-auto" />
              </button>
            </div>
            <div className="flex-1 min-w-0">
              <label className="text-xs text-fg-muted mb-1 block">Label</label>
              <input
                type="text"
                value={action.label}
                onChange={(event) => onUpdate({ label: event.target.value })}
                onBlur={onCommitEdit}
                className={INPUT_CLASS}
                data-testid="shortcut-label"
              />
            </div>
          </div>

          {iconPickerOpen && (
            <IconPickerDialog
              selectedIcon={action.icon ?? 'zap'}
              hideNone
              onSelect={(name) => onCloseIconPicker(name)}
              onClose={() => onCloseIconPicker(null)}
            />
          )}

          <div>
            <div className="flex items-center gap-1.5 mb-1">
              <label className="text-xs text-fg-muted">Command</label>
              <div className="relative group/tip">
                <Info size={12} className="text-fg-disabled cursor-help" />
                <div className="absolute top-full left-0 mt-1.5 px-2.5 py-1.5 bg-surface-raised border border-edge-input rounded-md shadow-xl text-[11px] text-fg-tertiary whitespace-nowrap opacity-0 pointer-events-none group-hover/tip:opacity-100 transition-opacity z-50">
                  {'{{cwd}}'} {'{{branchName}}'} {'{{taskTitle}}'} {'{{projectPath}}'}
                </div>
              </div>
            </div>
            <input
              type="text"
              value={action.command}
              onChange={(event) => onUpdate({ command: event.target.value })}
              onBlur={onCommitEdit}
              placeholder='code "{{cwd}}"'
              className={`${INPUT_CLASS} font-mono text-xs placeholder-fg-faint`}
              data-testid="shortcut-command"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs text-fg-muted mb-1 block">Display</label>
              <Select
                value={action.display ?? 'both'}
                onChange={(event) => onUpdateAndSave({ display: event.target.value as ShortcutDisplay })}
              >
                <option value="both">Both</option>
                <option value="header">Header only</option>
                <option value="menu">Menu only</option>
              </Select>
            </div>
            <div>
              <label className="text-xs text-fg-muted mb-1 block">Scope</label>
              <Select
                value={action.source}
                onChange={(event) => {
                  const newSource = event.target.value as 'team' | 'local';
                  onUpdateAndSave({ source: newSource });
                }}
              >
                <option value="team">Team (kangentic.json)</option>
                <option value="local">Personal (kangentic.local.json)</option>
              </Select>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// --- Main tab component ---

export function ShortcutsTab() {
  const shortcuts = useBoardStore((state) => state.shortcuts);
  const [localActions, setLocalActions] = useState<ShortcutEditState[]>([]);
  const [showPresets, setShowPresets] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [iconPickerIndex, setIconPickerIndex] = useState<number | null>(null);
  const presetsRef = useRef<HTMLDivElement>(null);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  useEffect(() => {
    setLocalActions(shortcuts.map((action) => ({ ...action })));
  }, [shortcuts]);

  // Click-outside handler for presets dropdown (capture phase to beat scroll containers)
  useEffect(() => {
    if (!showPresets) return;
    const handleClickOutside = (event: PointerEvent) => {
      if (presetsRef.current && !presetsRef.current.contains(event.target as Node)) {
        setShowPresets(false);
      }
    };
    document.addEventListener('pointerdown', handleClickOutside, true);
    return () => document.removeEventListener('pointerdown', handleClickOutside, true);
  }, [showPresets]);

  const saveActions = useCallback(async (actions: ShortcutEditState[]) => {
    const teamActions = actions.filter((action) => action.source === 'team').map(stripSource);
    const personalActions = actions.filter((action) => action.source === 'local').map(stripSource);

    // Save team and local actions separately
    if (teamActions.length > 0 || shortcuts.some((action) => action.source === 'team')) {
      await window.electronAPI.boardConfig.setShortcuts(teamActions, 'team');
    }
    if (personalActions.length > 0 || shortcuts.some((action) => action.source === 'local')) {
      await window.electronAPI.boardConfig.setShortcuts(personalActions, 'local');
    }

    // Reload directly instead of waiting for boardConfig:changed event
    // (which would trigger full column reconciliation unnecessarily)
    await useBoardStore.getState().loadShortcuts();
  }, [shortcuts]);

  const updateAndSave = useCallback((index: number, partial: Partial<ShortcutEditState>) => {
    const updated = localActions.map((action, mapIndex) =>
      mapIndex === index ? { ...action, ...partial } : action,
    );
    setLocalActions(updated);
    saveActions(updated);
  }, [localActions, saveActions]);

  const addAction = useCallback((preset?: Omit<ShortcutConfig, 'id'>) => {
    const newAction: ShortcutEditState = {
      label: preset?.label ?? 'New Action',
      icon: preset?.icon ?? 'zap',
      command: preset?.command ?? '',
      display: preset?.display ?? 'both',
      source: 'team',
    };
    const updated = [...localActions, newAction];
    setLocalActions(updated);
    setEditingIndex(updated.length - 1);
    setShowPresets(false);
    saveActions(updated);
  }, [localActions, saveActions]);

  const removeAction = useCallback((index: number) => {
    setLocalActions((previous) => {
      const updated = previous.filter((_action, filterIndex) => filterIndex !== index);
      saveActions(updated);
      return updated;
    });
    setEditingIndex(null);
  }, [saveActions]);

  const updateAction = useCallback((index: number, partial: Partial<ShortcutEditState>) => {
    setLocalActions((previous) =>
      previous.map((action, mapIndex) =>
        mapIndex === index ? { ...action, ...partial } : action,
      ),
    );
  }, []);

  const commitEdit = useCallback(() => {
    setEditingIndex(null);
    saveActions(localActions);
  }, [localActions, saveActions]);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;

    const oldIndex = localActions.findIndex((action, index) => getSortableId(action, index) === active.id);
    const newIndex = localActions.findIndex((action, index) => getSortableId(action, index) === over.id);
    if (oldIndex === -1 || newIndex === -1) return;

    const reordered = arrayMove(localActions, oldIndex, newIndex);
    setLocalActions(reordered);

    // Update editing index to follow the moved item
    if (editingIndex === oldIndex) {
      setEditingIndex(newIndex);
    } else if (editingIndex !== null) {
      if (oldIndex < editingIndex && newIndex >= editingIndex) {
        setEditingIndex(editingIndex - 1);
      } else if (oldIndex > editingIndex && newIndex <= editingIndex) {
        setEditingIndex(editingIndex + 1);
      }
    }

    saveActions(reordered);
  }, [localActions, editingIndex, saveActions]);

  const filteredPresets = getFilteredPresets();
  const sortableIds = localActions.map((action, index) => getSortableId(action, index));

  return (
    <div className="space-y-4">
      <SectionHeader label="Shortcuts" description="Custom commands that appear in the task detail dialog header and menu." />

      {localActions.length === 0 && (
        <p className="text-sm text-fg-faint">No shortcuts configured. Add one below or choose a preset.</p>
      )}

      <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
        <SortableContext items={sortableIds} strategy={verticalListSortingStrategy}>
          <div className="space-y-2">
            {localActions.map((action, index) => {
              const sortableId = getSortableId(action, index);
              return (
                <SortableActionItem
                  key={sortableId}
                  action={action}
                  index={index}
                  sortableId={sortableId}
                  isEditing={editingIndex === index}
                  iconPickerOpen={iconPickerIndex === index}
                  onToggleEdit={() => setEditingIndex(editingIndex === index ? null : index)}
                  onRemove={() => removeAction(index)}
                  onUpdate={(partial) => updateAction(index, partial)}
                  onUpdateAndSave={(partial) => updateAndSave(index, partial)}
                  onCommitEdit={commitEdit}
                  onOpenIconPicker={() => setIconPickerIndex(index)}
                  onCloseIconPicker={(name) => {
                    if (name) {
                      updateAndSave(index, { icon: name });
                    }
                    setIconPickerIndex(null);
                  }}
                />
              );
            })}
          </div>
        </SortableContext>
      </DndContext>

      {/* Add action button + presets */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => addAction()}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-fg-muted bg-surface-hover/50 hover:bg-surface-hover hover:text-fg-secondary rounded-lg transition-colors"
          data-testid="add-shortcut"
        >
          <Plus size={14} />
          Add Shortcut
        </button>

        <div className="relative" ref={presetsRef}>
          <button
            onClick={() => setShowPresets(!showPresets)}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs text-fg-muted bg-surface-hover/50 hover:bg-surface-hover hover:text-fg-secondary rounded-lg transition-colors"
            data-testid="shortcut-presets"
          >
            Presets
            <ChevronDown size={12} />
          </button>
          {showPresets && (
            <div className="absolute top-full left-0 mt-1 min-w-[200px] max-h-[320px] overflow-y-auto bg-surface-raised border border-edge-input rounded-md shadow-xl z-50 py-1">
              {(() => {
                let lastCategory = '';
                return filteredPresets.map((preset, index) => {
                  const PresetIcon = ICON_REGISTRY.get(preset.action.icon ?? 'zap') ?? Zap;
                  const showHeader = preset.category !== lastCategory;
                  lastCategory = preset.category;
                  return (
                    <React.Fragment key={`${preset.label}-${preset.platform ?? 'all'}-${index}`}>
                      {showHeader && (
                        <div className={`px-3 py-1 text-[10px] font-semibold uppercase tracking-wider text-fg-disabled ${index > 0 ? 'mt-1 border-t border-edge-input/50 pt-1.5' : ''}`}>
                          {preset.category}
                        </div>
                      )}
                      <button
                        onClick={() => addAction(preset.action)}
                        className="w-full text-left px-3 py-1.5 text-xs text-fg-tertiary hover:bg-surface-hover hover:text-fg transition-colors flex items-center gap-2"
                      >
                        <PresetIcon size={14} />
                        {preset.label}
                      </button>
                    </React.Fragment>
                  );
                });
              })()}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { Tags, Trash2, Plus, Pencil } from 'lucide-react';
import { ConfirmDialog } from '../../dialogs/ConfirmDialog';
import { Pill } from '../../Pill';
import { useBacklogStore } from '../../../stores/backlog-store';
import { useBoardStore } from '../../../stores/board-store';
import { useConfigStore } from '../../../stores/config-store';
import type { AppConfig } from '../../../../shared/types';
import { ColorPickerPopover } from './ColorPickerPopover';
import { PopoverShell } from './PopoverShell';

export function LabelsPopover() {
  const [open, setOpen] = useState(false);
  const [pendingDeleteLabel, setPendingDeleteLabel] = useState<{ name: string; count: number } | null>(null);
  const [addingLabel, setAddingLabel] = useState(false);
  const [newLabelName, setNewLabelName] = useState('');
  const newLabelInputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const items = useBacklogStore((state) => state.items);
  const boardTasks = useBoardStore((state) => state.tasks);
  const renameLabel = useBacklogStore((state) => state.renameLabel);
  const deleteLabel = useBacklogStore((state) => state.deleteLabel);
  const config = useConfigStore((state) => state.config);
  const updateConfig = useConfigStore((state) => state.updateConfig);
  const labelColors = config.backlog?.labelColors ?? {};

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handleClick = (event: MouseEvent) => {
      if (
        popoverRef.current && !popoverRef.current.contains(event.target as Node) &&
        buttonRef.current && !buttonRef.current.contains(event.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick, true);
    return () => document.removeEventListener('mousedown', handleClick, true);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); setOpen(false); }
    };
    document.addEventListener('keydown', handleEscape, true);
    return () => document.removeEventListener('keydown', handleEscape, true);
  }, [open]);

  const labelEntries = useMemo(() => {
    const counts = new Map<string, number>();
    // Count labels used on backlog tasks and board tasks
    for (const item of items) {
      for (const label of item.labels) {
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
    }
    for (const task of boardTasks) {
      for (const label of (task.labels ?? [])) {
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
    }
    // Include labels from config that aren't yet assigned to any item
    for (const name of Object.keys(labelColors)) {
      if (!counts.has(name)) {
        counts.set(name, 0);
      }
    }
    return [...counts.entries()]
      .sort(([labelA], [labelB]) => labelA.localeCompare(labelB))
      .map(([name, count]) => ({ name, count, color: labelColors[name] ?? null }));
  }, [items, boardTasks, labelColors]);

  const handleColorChange = useCallback((labelName: string, newColor: string) => {
    const updated = { ...labelColors, [labelName]: newColor };
    updateConfig({ backlog: { ...config.backlog, labelColors: updated } } as Partial<AppConfig>);
  }, [labelColors, config.backlog, updateConfig]);

  const handleRename = useCallback(async (oldName: string, newName: string) => {
    await renameLabel(oldName, newName);
    if (labelColors[oldName]) {
      const updated = { ...labelColors };
      updated[newName] = updated[oldName];
      delete updated[oldName];
      updateConfig({ backlog: { ...config.backlog, labelColors: updated } } as Partial<AppConfig>);
    }
  }, [renameLabel, labelColors, config.backlog, updateConfig]);

  const handleDelete = useCallback(async (name: string) => {
    // Read fresh config via getState() to avoid stale closure values
    const currentConfig = useConfigStore.getState().config;
    const currentLabelColors = currentConfig.backlog?.labelColors ?? {};
    if (currentLabelColors[name]) {
      const updated = { ...currentLabelColors };
      delete updated[name];
      await useConfigStore.getState().updateConfig({ backlog: { ...currentConfig.backlog, labelColors: updated } } as Partial<AppConfig>);
    }
    await deleteLabel(name);
    setPendingDeleteLabel(null);
  }, [deleteLabel]);

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        onClick={() => setOpen(!open)}
        className={`flex items-center gap-1.5 px-3 py-1.5 text-sm border rounded transition-colors ${
          open
            ? 'text-fg border-accent/50 bg-surface-hover/40'
            : 'text-fg-muted hover:text-fg border-edge/50 hover:bg-surface-hover/40'
        }`}
        data-testid="manage-labels-btn"
      >
        <Tags size={14} />
        Labels
      </button>

      <PopoverShell open={open} popoverRef={popoverRef}>
        <div>
          {labelEntries.length === 0 ? (
            <div className="text-center text-fg-faint py-6 px-3">
              <Tags size={28} strokeWidth={1} className="mx-auto mb-2" />
              <p className="text-sm">No labels yet</p>
              <p className="text-xs mt-1">Add labels when creating tasks</p>
            </div>
          ) : (
            <div className="space-y-0.5 p-2">
              {labelEntries.map((entry) => (
                <LabelRow
                  key={entry.name}
                  name={entry.name}
                  color={entry.color}
                  onColorChange={(newColor) => handleColorChange(entry.name, newColor)}
                  onRename={(newName) => handleRename(entry.name, newName)}
                  onDelete={() => {
                    if (useConfigStore.getState().config.skipDeleteConfirm) {
                      handleDelete(entry.name);
                    } else {
                      setPendingDeleteLabel({ name: entry.name, count: entry.count });
                    }
                  }}
                />
              ))}
            </div>
          )}

          <div className="border-t border-edge" />
          {addingLabel ? (
            <div className="flex items-center gap-2 px-3 py-1.5">
              <input
                ref={newLabelInputRef}
                type="text"
                value={newLabelName}
                onChange={(event) => setNewLabelName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && newLabelName.trim()) {
                    const trimmed = newLabelName.trim();
                    if (!labelEntries.some((entry) => entry.name === trimmed)) {
                      handleColorChange(trimmed, '#6b7280');
                    }
                    setNewLabelName('');
                    setAddingLabel(false);
                  }
                  if (event.key === 'Escape') {
                    setAddingLabel(false);
                    setNewLabelName('');
                  }
                }}
                onBlur={() => {
                  if (newLabelName.trim()) {
                    const trimmed = newLabelName.trim();
                    if (!labelEntries.some((entry) => entry.name === trimmed)) {
                      handleColorChange(trimmed, '#6b7280');
                    }
                  }
                  setNewLabelName('');
                  setAddingLabel(false);
                }}
                placeholder="Label name"
                className="flex-1 bg-surface border border-edge-input rounded px-2 py-1 text-sm text-fg focus:outline-none focus:border-accent"
              />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setAddingLabel(true);
                setTimeout(() => newLabelInputRef.current?.focus(), 0);
              }}
              className="flex items-center gap-1.5 w-full px-3 py-2 text-sm text-fg-muted hover:text-fg hover:bg-surface-hover/40 transition-colors"
            >
              <Plus size={14} />
              Add Label
            </button>
          )}
        </div>
      </PopoverShell>

      {pendingDeleteLabel && (
        <ConfirmDialog
          title={`Delete label "${pendingDeleteLabel.name}"`}
          message={pendingDeleteLabel.count > 0
            ? `This will remove the label from ${pendingDeleteLabel.count} item${pendingDeleteLabel.count !== 1 ? 's' : ''}.`
            : 'This label is not assigned to any items.'}
          confirmLabel="Delete"
          variant="danger"
          showDontAskAgain
          onConfirm={(dontAskAgain) => {
            if (dontAskAgain) useConfigStore.getState().updateConfig({ skipDeleteConfirm: true });
            handleDelete(pendingDeleteLabel.name);
          }}
          onCancel={() => setPendingDeleteLabel(null)}
        />
      )}
    </div>
  );
}

function LabelRow({
  name,
  color,
  onColorChange,
  onRename,
  onDelete,
}: {
  name: string;
  color: string | null;
  onColorChange: (newColor: string) => void;
  onRename: (newName: string) => void;
  onDelete: () => void;
}) {
  const [showColorPicker, setShowColorPicker] = useState(false);
  const colorButtonRef = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(name);
  const editInputRef = useRef<HTMLInputElement>(null);

  const startEditing = () => {
    setEditValue(name);
    setEditing(true);
    setTimeout(() => editInputRef.current?.focus(), 0);
  };

  const saveEdit = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== name) onRename(trimmed);
    setEditing(false);
  };

  const effectiveColor = color ?? '#6b7280';

  return (
    <div className="flex items-center gap-2 h-9 px-1.5 rounded hover:bg-surface-hover/30">
      <div className="relative flex-shrink-0">
        <button
          ref={colorButtonRef}
          type="button"
          onClick={() => setShowColorPicker(!showColorPicker)}
          title="Change color"
        >
          {editing ? (
            <span
              className="w-4 h-4 rounded-full border border-edge-input hover:border-fg-faint transition-colors block"
              style={{ backgroundColor: effectiveColor }}
            />
          ) : (
            <Pill
              size="sm"
              className="bg-surface-hover/60 font-medium cursor-pointer"
              style={{ color: effectiveColor }}
            >
              {name}
            </Pill>
          )}
        </button>
        {showColorPicker && (
          <ColorPickerPopover
            color={effectiveColor}
            triggerRef={colorButtonRef}
            onChange={onColorChange}
            onClose={() => setShowColorPicker(false)}
          />
        )}
      </div>

      {editing && (
        <div className="flex-1 min-w-0 flex items-center">
          <input
            ref={editInputRef}
            type="text"
            value={editValue}
            onChange={(event) => setEditValue(event.target.value)}
            onBlur={saveEdit}
            onKeyDown={(event) => {
              if (event.key === 'Enter') saveEdit();
              if (event.key === 'Escape') setEditing(false);
            }}
            className="bg-surface border border-edge-input rounded px-2 py-0.5 text-sm text-fg focus:outline-none focus:border-accent w-full"
          />
        </div>
      )}

      {!editing && <div className="flex-1" />}

      <button
        type="button"
        onClick={startEditing}
        className="p-1 text-fg-disabled hover:text-fg-muted rounded transition-colors flex-shrink-0"
        title="Rename"
      >
        <Pencil size={12} />
      </button>

      <button
        type="button"
        onClick={onDelete}
        className="p-1 text-fg-disabled hover:text-red-400 rounded transition-colors flex-shrink-0"
        title="Delete label"
      >
        <Trash2 size={13} />
      </button>
    </div>
  );
}

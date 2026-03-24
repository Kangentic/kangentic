import React, { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { Tags, Trash2, GripVertical, Plus, Pencil, Palette, Flag } from 'lucide-react';
import { HexColorPicker } from 'react-colorful';
import {
  DndContext,
  closestCenter,
  PointerSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  verticalListSortingStrategy,
  useSortable,
  arrayMove,
} from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { ConfirmDialog } from '../dialogs/ConfirmDialog';
import { Pill } from '../Pill';
import { useBacklogStore } from '../../stores/backlog-store';
import { useConfigStore } from '../../stores/config-store';
import type { AppConfig } from '../../../shared/types';

const PRESET_COLORS = [
  '#6b7280', '#ef4444', '#f43f5e', '#f97316',
  '#f59e0b', '#10b981', '#06b6d4', '#3b82f6',
  '#8b5cf6', '#ec4899', '#78716c',
];

// --- Color Picker Popover ---

function ColorPickerPopover({
  color,
  triggerRef,
  onChange,
  onClose,
}: {
  color: string;
  triggerRef: React.RefObject<HTMLElement | null>;
  onChange: (color: string) => void;
  onClose: () => void;
}) {
  const popoverRef = useRef<HTMLDivElement>(null);
  const [showCustomPicker, setShowCustomPicker] = useState(false);
  const [hexInput, setHexInput] = useState(color);
  const isCustomColor = !PRESET_COLORS.includes(color);

  const [position, setPosition] = useState<{ top: number; left: number }>({ top: 0, left: 0 });

  useEffect(() => {
    if (!triggerRef.current) return;
    const triggerRect = triggerRef.current.getBoundingClientRect();
    const popoverWidth = 200;
    const popoverHeight = 300;
    let top = triggerRect.bottom + 4;
    let left = triggerRect.left;
    if (left + popoverWidth > window.innerWidth - 16) left = window.innerWidth - popoverWidth - 16;
    if (top + popoverHeight > window.innerHeight - 16) top = triggerRect.top - popoverHeight - 4;
    setPosition({ top, left });
  }, [triggerRef]);

  useEffect(() => {
    const handleClick = (event: MouseEvent) => {
      if (
        popoverRef.current && !popoverRef.current.contains(event.target as Node) &&
        triggerRef.current && !triggerRef.current.contains(event.target as Node)
      ) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClick, true);
    return () => document.removeEventListener('mousedown', handleClick, true);
  }, [onClose, triggerRef]);

  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.stopPropagation(); onClose(); }
    };
    document.addEventListener('keydown', handleEscape, true);
    return () => document.removeEventListener('keydown', handleEscape, true);
  }, [onClose]);

  return (
    <div
      ref={popoverRef}
      className="fixed z-[60] bg-surface-raised border border-edge rounded-lg shadow-xl p-2"
      style={{ top: position.top, left: position.left }}
      onClick={(event) => event.stopPropagation()}
    >
      <div className="grid grid-cols-6 gap-1.5 place-items-center">
        {PRESET_COLORS.map((presetColor) => (
          <button
            key={presetColor}
            type="button"
            onClick={() => {
              onChange(presetColor);
              setHexInput(presetColor);
              setShowCustomPicker(false);
              onClose();
            }}
            className={`w-6 h-6 rounded-full border-2 transition-all ${
              color === presetColor ? 'border-white/60 scale-110' : 'border-transparent hover:border-fg-faint'
            }`}
            style={{ backgroundColor: presetColor }}
          />
        ))}
        <button
          type="button"
          onClick={() => setShowCustomPicker(!showCustomPicker)}
          className={`w-6 h-6 rounded-full border-2 flex items-center justify-center transition-all ${
            isCustomColor
              ? 'border-white/60 scale-110'
              : showCustomPicker
                ? 'border-white/60 bg-surface-hover'
                : 'border-edge-input hover:border-fg-muted bg-surface-raised'
          }`}
          style={isCustomColor ? { backgroundColor: color } : undefined}
          title="Custom color"
        >
          <Palette size={10} className={isCustomColor ? 'text-white' : 'text-fg-muted'} />
        </button>
      </div>

      {showCustomPicker && (
        <div className="mt-3 space-y-2">
          <HexColorPicker
            color={color}
            onChange={(newColor) => { onChange(newColor); setHexInput(newColor); }}
            className="!w-full"
          />
          <input
            type="text"
            value={hexInput}
            onChange={(event) => {
              const value = event.target.value;
              setHexInput(value);
              if (/^#[0-9a-fA-F]{6}$/.test(value)) onChange(value.toLowerCase());
            }}
            onBlur={() => {
              if (!/^#[0-9a-fA-F]{6}$/.test(hexInput)) setHexInput(color);
            }}
            className="w-full bg-surface border border-edge-input rounded px-3 py-1.5 text-sm text-fg font-mono focus:outline-none focus:border-accent"
            placeholder="#000000"
            maxLength={7}
          />
        </div>
      )}
    </div>
  );
}

// --- Popover Shell (shared wrapper for both Labels and Priorities) ---

function PopoverShell({
  open,
  popoverRef,
  children,
}: {
  open: boolean;
  popoverRef: React.RefObject<HTMLDivElement | null>;
  children: React.ReactNode;
}) {
  if (!open) return null;
  return (
    <div
      ref={popoverRef}
      className="absolute left-0 top-full mt-1 z-50 bg-surface-raised border border-edge rounded-lg shadow-xl w-[320px] max-h-[420px] overflow-y-auto"
    >
      {children}
    </div>
  );
}

// =====================================================================
// Labels Popover
// =====================================================================

export function LabelsPopover() {
  const [open, setOpen] = useState(false);
  const [pendingDeleteLabel, setPendingDeleteLabel] = useState<{ name: string; count: number } | null>(null);
  const [addingLabel, setAddingLabel] = useState(false);
  const [newLabelName, setNewLabelName] = useState('');
  const newLabelInputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const items = useBacklogStore((state) => state.items);
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
    for (const item of items) {
      for (const label of item.labels) {
        counts.set(label, (counts.get(label) ?? 0) + 1);
      }
    }
    return [...counts.entries()]
      .sort(([labelA], [labelB]) => labelA.localeCompare(labelB))
      .map(([name, count]) => ({ name, count, color: labelColors[name] ?? null }));
  }, [items, labelColors]);

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
    await deleteLabel(name);
    if (labelColors[name]) {
      const updated = { ...labelColors };
      delete updated[name];
      updateConfig({ backlog: { ...config.backlog, labelColors: updated } } as Partial<AppConfig>);
    }
    setPendingDeleteLabel(null);
  }, [deleteLabel, labelColors, config.backlog, updateConfig]);

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
        <div className="p-3">
          {labelEntries.length === 0 ? (
            <div className="text-center text-fg-faint py-6">
              <Tags size={28} strokeWidth={1} className="mx-auto mb-2" />
              <p className="text-sm">No labels yet</p>
              <p className="text-xs mt-1">Add labels when creating backlog items</p>
            </div>
          ) : (
            <div className="space-y-0.5">
              {labelEntries.map((entry) => (
                <LabelRow
                  key={entry.name}
                  name={entry.name}
                  color={entry.color}
                  onColorChange={(newColor) => handleColorChange(entry.name, newColor)}
                  onRename={(newName) => handleRename(entry.name, newName)}
                  onDelete={() => setPendingDeleteLabel({ name: entry.name, count: entry.count })}
                />
              ))}
            </div>
          )}

          <div className="my-1.5 border-t border-edge" />
          {addingLabel ? (
            <div className="flex items-center gap-2 px-1.5">
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
                onBlur={() => { setAddingLabel(false); setNewLabelName(''); }}
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
              className="flex items-center gap-1.5 px-1.5 py-1.5 text-xs text-fg-secondary hover:text-fg hover:bg-surface-hover/30 rounded w-full transition-colors"
            >
              <Plus size={13} />
              Add Label
            </button>
          )}
        </div>
      </PopoverShell>

      {pendingDeleteLabel && (
        <ConfirmDialog
          title={`Delete label "${pendingDeleteLabel.name}"`}
          message={`This will remove the label from ${pendingDeleteLabel.count} backlog item${pendingDeleteLabel.count !== 1 ? 's' : ''}.`}
          confirmLabel="Delete"
          variant="danger"
          onConfirm={() => handleDelete(pendingDeleteLabel.name)}
          onCancel={() => setPendingDeleteLabel(null)}
        />
      )}
    </div>
  );
}

// --- Label Row ---

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
              className="font-medium cursor-pointer"
              style={{ backgroundColor: `${effectiveColor}20`, color: effectiveColor, border: `1px solid ${effectiveColor}30` }}
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

// =====================================================================
// Priorities Popover
// =====================================================================

export function PrioritiesPopover() {
  const [open, setOpen] = useState(false);
  const [pendingDeletePriority, setPendingDeletePriority] = useState<{ index: number; label: string; count: number } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const items = useBacklogStore((state) => state.items);
  const config = useConfigStore((state) => state.config);
  const updateConfig = useConfigStore((state) => state.updateConfig);

  const priorities = config.backlog?.priorities ?? [
    { label: 'None', color: '#6b7280' },
    { label: 'Low', color: '#6b7280' },
    { label: 'Medium', color: '#eab308' },
    { label: 'High', color: '#f97316' },
    { label: 'Urgent', color: '#ef4444' },
  ];

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

  const priorityItemCounts = useMemo(() => {
    const counts = new Map<number, number>();
    for (const item of items) {
      counts.set(item.priority, (counts.get(item.priority) ?? 0) + 1);
    }
    return counts;
  }, [items]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
  );

  const handleRename = useCallback((index: number, newLabel: string) => {
    const updated = [...priorities];
    updated[index] = { ...updated[index], label: newLabel };
    updateConfig({ backlog: { ...config.backlog, priorities: updated } } as Partial<AppConfig>);
  }, [priorities, config.backlog, updateConfig]);

  const handleColorChange = useCallback((index: number, newColor: string) => {
    const updated = [...priorities];
    updated[index] = { ...updated[index], color: newColor };
    updateConfig({ backlog: { ...config.backlog, priorities: updated } } as Partial<AppConfig>);
  }, [priorities, config.backlog, updateConfig]);

  const handleAdd = useCallback(() => {
    const updated = [...priorities, { label: `Priority ${priorities.length}`, color: '#6b7280' }];
    updateConfig({ backlog: { ...config.backlog, priorities: updated } } as Partial<AppConfig>);
  }, [priorities, config.backlog, updateConfig]);

  const handleDelete = useCallback(async (index: number) => {
    // Build mapping: deleted index -> 0 (None), higher indices shift down by 1
    const mapping: Record<number, number> = {};
    mapping[index] = 0;
    for (let position = index + 1; position < priorities.length; position++) {
      mapping[position] = position - 1;
    }
    // Remap item priorities in DB first
    await window.electronAPI.backlog.remapPriorities(mapping);
    // Then update config
    const updated = priorities.filter((_, priorityIndex) => priorityIndex !== index);
    updateConfig({ backlog: { ...config.backlog, priorities: updated } } as Partial<AppConfig>);
    // Reload backlog to reflect remapped priorities
    useBacklogStore.getState().loadBacklog();
    setPendingDeletePriority(null);
  }, [priorities, config.backlog, updateConfig]);

  const handleReorder = useCallback(async (activeId: string, overId: string) => {
    const activeIndex = priorities.findIndex((_, index) => `priority-${index}` === activeId);
    const overIndex = priorities.findIndex((_, index) => `priority-${index}` === overId);
    if (activeIndex === -1 || overIndex === -1 || activeIndex === 0 || overIndex === 0) return;
    // Build mapping from old indices to new indices after the move
    const reordered = arrayMove([...priorities], activeIndex, overIndex);
    const mapping: Record<number, number> = {};
    for (let oldIndex = 0; oldIndex < priorities.length; oldIndex++) {
      const newIndex = reordered.indexOf(priorities[oldIndex]);
      if (newIndex !== oldIndex) {
        mapping[oldIndex] = newIndex;
      }
    }
    // Remap item priorities in DB
    if (Object.keys(mapping).length > 0) {
      await window.electronAPI.backlog.remapPriorities(mapping);
    }
    // Update config
    updateConfig({ backlog: { ...config.backlog, priorities: reordered } } as Partial<AppConfig>);
    // Reload backlog to reflect remapped priorities
    useBacklogStore.getState().loadBacklog();
  }, [priorities, config.backlog, updateConfig]);

  const reversedPriorities = useMemo(() => {
    return priorities.map((priority, index) => ({ ...priority, index })).reverse();
  }, [priorities]);

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
        data-testid="manage-priorities-btn"
      >
        <Flag size={14} />
        Priorities
      </button>

      <PopoverShell open={open} popoverRef={popoverRef}>
        <div className="p-3">
          <div className="space-y-0.5">
            <DndContext
              sensors={sensors}
              collisionDetection={closestCenter}
              autoScroll={false}
              onDragEnd={(event) => {
                const { active, over } = event;
                if (over && active.id !== over.id) {
                  handleReorder(String(active.id), String(over.id));
                }
              }}
            >
              <SortableContext
                items={reversedPriorities.map((priority) => `priority-${priority.index}`)}
                strategy={verticalListSortingStrategy}
              >
                {reversedPriorities.map((priority) => (
                  <PriorityRow
                    key={`priority-${priority.index}`}
                    id={`priority-${priority.index}`}
                    label={priority.label}
                    color={priority.color}
                    isLocked={priority.index === 0}
                    onRename={(newLabel) => handleRename(priority.index, newLabel)}
                    onColorChange={(newColor) => handleColorChange(priority.index, newColor)}
                    onDelete={() => setPendingDeletePriority({
                      index: priority.index,
                      label: priority.label,
                      count: priorityItemCounts.get(priority.index) ?? 0,
                    })}
                  />
                ))}
              </SortableContext>
            </DndContext>

            <div className="my-1.5 border-t border-edge" />
            <button
              type="button"
              onClick={handleAdd}
              className="flex items-center gap-1.5 px-1.5 py-1.5 text-xs text-fg-secondary hover:text-fg hover:bg-surface-hover/30 rounded w-full transition-colors"
            >
              <Plus size={13} />
              Add Priority
            </button>
          </div>
        </div>
      </PopoverShell>

      {pendingDeletePriority && (
        <ConfirmDialog
          title={`Delete priority "${pendingDeletePriority.label}"`}
          message={`${pendingDeletePriority.count} item${pendingDeletePriority.count !== 1 ? 's' : ''} with this priority will be reset to "${priorities[0]?.label ?? 'None'}".`}
          confirmLabel="Delete"
          variant="danger"
          onConfirm={() => handleDelete(pendingDeletePriority.index)}
          onCancel={() => setPendingDeletePriority(null)}
        />
      )}
    </div>
  );
}

// --- Priority Row ---

function PriorityRow({
  id,
  label,
  color,
  isLocked,
  onRename,
  onColorChange,
  onDelete,
}: {
  id: string;
  label: string;
  color: string;
  isLocked: boolean;
  onRename: (newLabel: string) => void;
  onColorChange: (newColor: string) => void;
  onDelete: () => void;
}) {
  const [showColorPicker, setShowColorPicker] = useState(false);
  const colorButtonRef = useRef<HTMLButtonElement>(null);
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(label);
  const editInputRef = useRef<HTMLInputElement>(null);

  const startEditing = () => {
    setEditValue(label);
    setEditing(true);
    setTimeout(() => editInputRef.current?.focus(), 0);
  };

  const saveEdit = () => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== label) onRename(trimmed);
    setEditing(false);
  };

  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled: isLocked });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className="flex items-center gap-2.5 h-9 px-1.5 rounded hover:bg-surface-hover/30"
    >
      {!isLocked ? (
        <div {...attributes} {...listeners} className="cursor-grab text-fg-disabled hover:text-fg-muted flex-shrink-0">
          <GripVertical size={13} />
        </div>
      ) : (
        <div className="w-[13px] flex-shrink-0" />
      )}

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
              style={{ backgroundColor: color }}
            />
          ) : (
            <Pill
              size="sm"
              className="font-medium cursor-pointer"
              style={{ backgroundColor: `${color}20`, color, border: `1px solid ${color}30` }}
            >
              {label}
            </Pill>
          )}
        </button>
        {showColorPicker && (
          <ColorPickerPopover
            color={color}
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

      {!isLocked ? (
        <button
          type="button"
          onClick={onDelete}
          className="p-1 text-fg-disabled hover:text-red-400 rounded transition-colors flex-shrink-0"
          title="Delete priority"
        >
          <Trash2 size={13} />
        </button>
      ) : (
        <div className="w-[21px] flex-shrink-0" />
      )}
    </div>
  );
}

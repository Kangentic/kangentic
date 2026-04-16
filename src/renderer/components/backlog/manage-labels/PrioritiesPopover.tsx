import React, { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { Trash2, GripVertical, Plus, Pencil, Flag } from 'lucide-react';
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
import { ConfirmDialog } from '../../dialogs/ConfirmDialog';
import { Pill } from '../../Pill';
import { useBacklogStore } from '../../../stores/backlog-store';
import { useConfigStore } from '../../../stores/config-store';
import type { AppConfig } from '../../../../shared/types';
import { ColorPickerPopover } from './ColorPickerPopover';
import { PopoverShell } from './PopoverShell';

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
        <div>
          <div className="space-y-0.5 p-2">
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
                    onDelete={() => {
                      if (useConfigStore.getState().config.skipDeleteConfirm) {
                        handleDelete(priority.index);
                      } else {
                        setPendingDeletePriority({
                          index: priority.index,
                          label: priority.label,
                          count: priorityItemCounts.get(priority.index) ?? 0,
                        });
                      }
                    }}
                  />
                ))}
              </SortableContext>
            </DndContext>
          </div>

          <div className="border-t border-edge" />
          <button
            type="button"
            onClick={handleAdd}
            className="flex items-center gap-1.5 w-full px-3 py-2 text-sm text-fg-muted hover:text-fg hover:bg-surface-hover/40 transition-colors"
          >
            <Plus size={14} />
            Add Priority
          </button>
        </div>
      </PopoverShell>

      {pendingDeletePriority && (
        <ConfirmDialog
          title={`Delete priority "${pendingDeletePriority.label}"`}
          message={`${pendingDeletePriority.count} item${pendingDeletePriority.count !== 1 ? 's' : ''} with this priority will be reset to "${priorities[0]?.label ?? 'None'}".`}
          confirmLabel="Delete"
          variant="danger"
          showDontAskAgain
          onConfirm={(dontAskAgain) => {
            if (dontAskAgain) useConfigStore.getState().updateConfig({ skipDeleteConfirm: true });
            handleDelete(pendingDeletePriority.index);
          }}
          onCancel={() => setPendingDeletePriority(null)}
        />
      )}
    </div>
  );
}

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
              className="bg-surface-hover/60 font-medium cursor-pointer"
              style={{ color }}
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

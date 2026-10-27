import { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import { Tags, Trash2, Plus, Pencil } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { plural } from '@lingui/core/macro';
import { ConfirmDialog } from '../../dialogs/ConfirmDialog';
import { Pill, TINTED_PILL_FILL, TINTED_PILL_EDGE } from '../../Pill';
import { Tooltip } from '../../Tooltip';
import { useBacklogStore } from '../../../stores/backlog-store';
import { useBoardStore } from '../../../stores/board-store';
import { useConfigStore } from '../../../stores/config-store';
import type { AppConfig } from '../../../../shared/types';
import { ColorPickerPopover } from './ColorPickerPopover';
import { PopoverShell } from './PopoverShell';
import type { ToolbarControlCollapse } from '../../board/toolbar-collapse';

interface LabelsPopoverProps {
  /**
   * The container-query pair that sheds this trigger's text in a tight toolbar
   * row. Omitted, the button always shows its label, which is what a mount site
   * outside the toolbar's `@container` needs.
   */
  collapse?: ToolbarControlCollapse;
}

export function LabelsPopover({ collapse }: LabelsPopoverProps) {
  const { t } = useLingui();
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
  // useMemo so the empty-object fallback keeps a stable identity across renders;
  // otherwise `?? {}` makes a fresh object each render and destabilizes every
  // hook below that depends on labelColors.
  const labelColors = useMemo(() => config.backlog?.labelColors ?? {}, [config.backlog?.labelColors]);
  const labelsButtonLabel = t({ message: 'Labels', context: 'toolbar button' });
  // Named locals, so a translator reads `{pendingDeleteLabelName}`, not `{0}`.
  const pendingDeleteLabelName = pendingDeleteLabel?.name ?? '';
  const pendingDeleteLabelCount = pendingDeleteLabel?.count ?? 0;

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
    <div className="relative shrink-0">
      <Tooltip label={labelsButtonLabel} enabled={!open}>
        <button
          ref={buttonRef}
          type="button"
          onClick={() => setOpen(!open)}
          aria-label={labelsButtonLabel}
          className={`flex items-center gap-1.5 py-1.5 text-sm border rounded transition-colors ${collapse ? collapse.button : 'px-3'} ${
            open
              ? 'text-fg border-accent/50 bg-surface-control/40'
              : 'text-fg-muted hover:text-fg border-edge/50 hover:bg-surface-hover/40'
          }`}
          data-testid="manage-labels-btn"
        >
          <Tags size={14} className="shrink-0" />
          <span className={collapse?.label}>{labelsButtonLabel}</span>
        </button>
      </Tooltip>

      <PopoverShell open={open} popoverRef={popoverRef}>
        <div>
          {labelEntries.length === 0 ? (
            <div className="text-center text-fg-faint py-6 px-3">
              <Tags size={28} strokeWidth={1} className="mx-auto mb-2" />
              <p className="text-sm"><Trans>No labels yet</Trans></p>
              <p className="text-xs mt-1"><Trans>Add labels when creating tasks</Trans></p>
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
                placeholder={t`Label name`}
                className="flex-1 bg-surface-control border border-edge-input rounded px-2 py-1 text-sm text-fg focus:outline-none focus:border-accent"
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
              <Trans>Add Label</Trans>
            </button>
          )}
        </div>
      </PopoverShell>

      {pendingDeleteLabel && (
        <ConfirmDialog
          title={t`Delete label "${pendingDeleteLabelName}"`}
          message={pendingDeleteLabelCount > 0
            ? t`This will remove the label from ${plural(pendingDeleteLabelCount, { one: '# item', other: '# items' })}.`
            : t`This label is not assigned to any items.`}
          confirmLabel={t({ message: 'Delete', context: 'button' })}
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
  const { t } = useLingui();
  const changeColorLabel = t`Change color`;
  const renameLabel = t({ message: 'Rename', context: 'button' });
  const deleteLabelLabel = t`Delete label`;
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
        <Tooltip label={changeColorLabel} enabled={!showColorPicker}>
          <button
            ref={colorButtonRef}
            type="button"
            onClick={() => setShowColorPicker(!showColorPicker)}
            aria-label={changeColorLabel}
          >
            {editing ? (
              <span
                className="w-4 h-4 rounded-full border border-edge-input hover:border-fg-faint transition-colors block"
                style={{ backgroundColor: effectiveColor }}
              />
            ) : (
              <Pill
                size="sm"
                className="font-medium border cursor-pointer"
                style={{ color: effectiveColor, backgroundColor: TINTED_PILL_FILL, borderColor: TINTED_PILL_EDGE }}
              >
                {name}
              </Pill>
            )}
          </button>
        </Tooltip>
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
            className="bg-surface-control border border-edge-input rounded px-2 py-0.5 text-sm text-fg focus:outline-none focus:border-accent w-full"
          />
        </div>
      )}

      {!editing && <div className="flex-1" />}

      <Tooltip label={renameLabel}>
        <button
          type="button"
          onClick={startEditing}
          className="p-1 text-fg-disabled hover:text-fg-muted rounded transition-colors flex-shrink-0"
          aria-label={renameLabel}
        >
          <Pencil size={12} />
        </button>
      </Tooltip>

      <Tooltip label={deleteLabelLabel}>
        <button
          type="button"
          onClick={onDelete}
          className="p-1 text-fg-disabled hover:text-red-400 rounded transition-colors flex-shrink-0"
          aria-label={deleteLabelLabel}
        >
          <Trash2 size={13} />
        </button>
      </Tooltip>
    </div>
  );
}

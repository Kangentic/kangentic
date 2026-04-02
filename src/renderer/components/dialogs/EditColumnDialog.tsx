import { useState, useRef, useEffect } from 'react';
import { Pencil, Lock, Trash2, Palette, ChevronRight, Info } from 'lucide-react';
import { HexColorPicker } from 'react-colorful';
import { useBoardStore } from '../../stores/board-store';
import { useConfigStore } from '../../stores/config-store';
import { useToastStore } from '../../stores/toast-store';
import { BaseDialog } from './BaseDialog';
import { ConfirmDialog } from './ConfirmDialog';
import { IconPickerDialog } from './IconPickerDialog';
import { ICON_REGISTRY, ROLE_DEFAULTS, getUsedIcons } from '../../utils/swimlane-icons';
import type { Swimlane, PermissionMode, AgentDetectionInfo } from '../../../shared/types';

const PERMISSION_LABELS: Record<PermissionMode, string> = {
  default: 'Default (Allowlist)',
  plan: 'Plan',
  acceptEdits: 'Accept Edits',
  dontAsk: "Don't Ask (Deny Unless Allowed)",
  bypassPermissions: 'Bypass (Unsafe)',
};

const PRESET_COLORS = [
  '#6b7280', '#ef4444', '#f43f5e', '#f97316',
  '#f59e0b', '#10b981', '#06b6d4', '#3b82f6',
  '#8b5cf6', '#ec4899',
];

interface EditColumnDialogProps {
  swimlane: Swimlane;
  onClose: () => void;
}

export function EditColumnDialog({ swimlane, onClose }: EditColumnDialogProps) {
  const updateSwimlane = useBoardStore((s) => s.updateSwimlane);
  const deleteSwimlane = useBoardStore((s) => s.deleteSwimlane);
  const tasks = useBoardStore((s) => s.tasks);
  const globalPermissionMode = useConfigStore((s) => s.config.claude.permissionMode);

  const swimlanes = useBoardStore((s) => s.swimlanes);

  const [name, setName] = useState(swimlane.name);
  const [color, setColor] = useState(swimlane.color.toLowerCase());
  const [icon, setIcon] = useState<string | null>(swimlane.icon);
  const [showCustomPicker, setShowCustomPicker] = useState(false);
  const [showIconPicker, setShowIconPicker] = useState(false);
  const [hexInput, setHexInput] = useState(swimlane.color.toLowerCase());
  const [permissionMode, setPermissionMode] = useState<PermissionMode | null>(swimlane.permission_mode);
  const [autoSpawn, setAutoSpawn] = useState(swimlane.auto_spawn);
  const [autoCommand, setAutoCommand] = useState(swimlane.auto_command || '');
  const [planExitTargetId, setPlanExitTargetId] = useState<string | null>(swimlane.plan_exit_target_id);
  const [agentOverride, setAgentOverride] = useState<string | null>(swimlane.agent_override);
  const [agentList, setAgentList] = useState<AgentDetectionInfo[]>([]);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const taskCount = tasks.filter((t) => t.swimlane_id === swimlane.id).length;
  const isLocked = swimlane.role !== null;

  const isTodoOrDone = swimlane.role === 'todo' || swimlane.role === 'done';
  const permissionLocked = isTodoOrDone;
  const autoSpawnLocked = isTodoOrDone;
  const isPlanMode = permissionMode === 'plan';

  const isCustomColor = !PRESET_COLORS.includes(color);
  const usedIcons = getUsedIcons(swimlanes, swimlane.id);

  useEffect(() => {
    inputRef.current?.select();
    window.electronAPI.agents.list().then(setAgentList).catch(() => {});
  }, []);

  const handleSave = async () => {
    if (!name.trim()) return;
    await updateSwimlane({
      id: swimlane.id,
      name: name.trim(),
      color,
      icon,
      permission_mode: permissionLocked ? undefined : permissionMode,
      auto_spawn: autoSpawnLocked ? undefined : autoSpawn,
      auto_command: isTodoOrDone ? undefined : (autoCommand.trim() || null),
      plan_exit_target_id: isPlanMode ? (planExitTargetId || null) : undefined,
      agent_override: isTodoOrDone ? undefined : (agentOverride || null),
    });
    onClose();
  };

  const handleDelete = async (_dontAskAgain: boolean) => {
    if (taskCount > 0) {
      useToastStore.getState().addToast({
        message: `Cannot delete "${swimlane.name}". Move or delete all ${taskCount} task${taskCount > 1 ? 's' : ''} first.`,
        variant: 'error',
      });
      onClose();
      return;
    }
    try {
      const colName = swimlane.name;
      await deleteSwimlane(swimlane.id);
      useToastStore.getState().addToast({
        message: `Deleted column "${colName}"`,
        variant: 'info',
      });
      onClose();
    } catch (err: unknown) {
      useToastStore.getState().addToast({
        message: err instanceof Error ? err.message : 'Failed to delete column.',
        variant: 'error',
      });
      onClose();
    }
  };

  if (confirmDelete) {
    return (
      <ConfirmDialog
        title="Delete column"
        message={<>
          <p>Are you sure you want to delete this column?</p>
          <p className="text-fg-secondary bg-surface rounded px-3 py-2 truncate" title={swimlane.name}>{swimlane.name}</p>
        </>}
        confirmLabel="Delete"
        variant="danger"
        onConfirm={handleDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    );
  }

  return (
    <BaseDialog
      onClose={onClose}
      title="Edit Column"
        icon={<Pencil size={14} className="text-fg-muted" />}
        headerRight={isLocked ? (
          <span className="text-xs text-fg-faint flex items-center gap-1 flex-shrink-0">
            <Lock size={12} />
            System
          </span>
        ) : undefined}
        footer={
          <div className="flex items-center">
            <div className="flex-1">
              {!isLocked && (
                <button
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-red-400 border border-red-400/40 hover:text-red-300 hover:border-red-300/50 hover:bg-red-400/10 rounded transition-colors"
                >
                  <Trash2 size={13} />
                  Delete
                </button>
              )}
            </div>
            <div className="flex gap-3">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-1.5 text-xs text-fg-muted hover:text-fg-secondary border border-edge-input hover:border-fg-faint rounded transition-colors"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={!name.trim()}
                className="px-4 py-1.5 text-xs bg-accent-emphasis hover:bg-accent text-accent-on rounded transition-colors disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </div>
        }
      >
        <div className="space-y-4">
          {/* Name input */}
          <div>
            <label className="text-xs text-fg-muted mb-1.5 block">Name</label>
            <input
              ref={inputRef}
              type="text"
              placeholder="Column name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSave(); }}
              className="w-full bg-surface border border-edge-input rounded px-3 py-2 text-sm text-fg placeholder-fg-faint focus:outline-none focus:border-accent"
            />
          </div>

          {/* Icon picker */}
          <div>
            <label className="text-xs text-fg-muted mb-1.5 block">Icon</label>
            <button
              type="button"
              onClick={() => setShowIconPicker(true)}
              aria-label={`Choose icon${icon ? `: ${icon}` : ''}`}
              className="w-full flex items-center gap-2.5 bg-surface border border-edge-input hover:border-fg-faint rounded px-3 py-2 transition-colors group"
            >
              <div className="flex-shrink-0">
                {(() => {
                  if (icon) {
                    const IconComp = ICON_REGISTRY.get(icon);
                    if (IconComp) return <IconComp size={14} strokeWidth={1.75} style={{ color }} />;
                  }
                  if (swimlane.role) {
                    const RoleIcon = ROLE_DEFAULTS[swimlane.role];
                    return <RoleIcon size={14} strokeWidth={1.75} style={{ color }} />;
                  }
                  return (
                    <div
                      className="w-2.5 h-2.5 rounded-full"
                      style={{ backgroundColor: color }}
                    />
                  );
                })()}
              </div>
              <span className="text-xs text-fg-tertiary flex-1 text-left truncate">
                {icon ?? (swimlane.role ? `Default (${swimlane.role})` : 'None')}
              </span>
              <ChevronRight size={14} className="text-fg-faint group-hover:text-fg-muted flex-shrink-0" />
            </button>
          </div>

          {showIconPicker && (
            <IconPickerDialog
              selectedIcon={icon}
              accentColor={color}
              usedIcons={usedIcons}
              onSelect={(name) => { setIcon(name); setShowIconPicker(false); }}
              onClose={() => setShowIconPicker(false)}
            />
          )}

          {/* Color picker */}
          <div>
            <label className="text-xs text-fg-muted mb-1.5 block">Color</label>
            <div className="flex gap-2 flex-wrap items-center">
              {PRESET_COLORS.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => {
                    setColor(c);
                    setHexInput(c);
                    setShowCustomPicker(false);
                  }}
                  aria-label={`Color ${c}${color === c ? ' (selected)' : ''}`}
                  className={`w-6 h-6 rounded-full border-2 transition-all ${
                    color === c ? 'border-white/60 scale-110' : 'border-transparent hover:border-fg-faint'
                  }`}
                  style={{ backgroundColor: c }}
                />
              ))}
              <button
                type="button"
                onClick={() => setShowCustomPicker(!showCustomPicker)}
                className={`w-7 h-7 rounded-full border-2 flex items-center justify-center transition-all ${
                  isCustomColor
                    ? 'border-white/60 scale-110'
                    : showCustomPicker
                      ? 'border-white/60 bg-surface-hover'
                      : 'border-edge-input hover:border-fg-muted bg-surface-raised'
                }`}
                style={isCustomColor ? { backgroundColor: color } : undefined}
                title={isCustomColor ? `Custom color ${color}` : 'Custom color'}
                aria-label={isCustomColor ? `Custom color ${color}` : 'Custom color'}
              >
                <Palette size={12} className={isCustomColor ? 'text-white' : 'text-fg-muted'} />
              </button>
            </div>

            {showCustomPicker && (
              <div className="mt-3 space-y-2">
                <HexColorPicker
                  color={color}
                  onChange={(c) => { setColor(c); setHexInput(c); }}
                  className="!w-full"
                />
                <input
                  type="text"
                  value={hexInput}
                  onChange={(e) => {
                    const v = e.target.value;
                    setHexInput(v);
                    if (/^#[0-9a-fA-F]{6}$/.test(v)) setColor(v.toLowerCase());
                  }}
                  onBlur={() => {
                    if (!/^#[0-9a-fA-F]{6}$/.test(hexInput)) setHexInput(color);
                  }}
                  aria-label="Hex color value"
                  className="w-full bg-surface border border-edge-input rounded px-3 py-1.5 text-sm text-fg font-mono focus:outline-none focus:border-accent"
                  placeholder="#000000"
                  maxLength={7}
                />
              </div>
            )}
          </div>

          {/* Agent section divider */}
          <div className="flex items-center gap-2 pt-1">
            <span className="text-[11px] text-fg-faint uppercase tracking-wider">Agent</span>
            <div className="flex-1 border-t border-edge-subtle" />
          </div>

          {/* Auto-spawn toggle */}
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs text-fg-muted">Auto-spawn</label>
              <button
                type="button"
                role="switch"
                aria-checked={autoSpawn}
                aria-label="Auto-spawn"
                onClick={() => { if (!autoSpawnLocked) setAutoSpawn(!autoSpawn); }}
                disabled={autoSpawnLocked}
                className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
                  autoSpawn ? 'bg-accent' : 'bg-edge-input'
                }`}
              >
                <span
                  className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                    autoSpawn ? 'translate-x-[18px]' : 'translate-x-[3px]'
                  }`}
                />
              </button>
            </div>
            <p className="text-[11px] text-fg-faint mt-1">
              {isTodoOrDone
                ? 'Tasks in this column do not start agents.'
                : 'Start an agent when a task enters this column.'}
            </p>
          </div>

          {/* Agent override dropdown */}
          <div>
            <label className="text-xs text-fg-muted mb-1.5 block">Agent</label>
            <select
              value={agentOverride ?? ''}
              onChange={(event) => setAgentOverride(event.target.value || null)}
              disabled={isTodoOrDone}
              className="w-full appearance-none bg-surface border border-edge-input rounded px-3 py-1.5 text-sm text-fg focus:outline-none focus:border-accent disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <option value="">Default (project setting)</option>
              {agentList.map((agent) => (
                <option key={agent.name} value={agent.name}>
                  {agent.displayName ?? agent.name}{agent.found ? (agent.version ? ` ${agent.version}` : '') : ' (not found)'}
                </option>
              ))}
            </select>
            <p className="text-[11px] text-fg-faint mt-1">
              Override the project default agent for this column.
            </p>
          </div>

          {/* Permissions dropdown */}
          <div>
            <label className="text-xs text-fg-muted mb-1.5 block">Permissions</label>
            <select
              value={permissionMode ?? ''}
              onChange={(e) => setPermissionMode(e.target.value ? e.target.value as PermissionMode : null)}
              disabled={permissionLocked}
              className="w-full appearance-none bg-surface border border-edge-input rounded px-3 py-1.5 text-sm text-fg focus:outline-none focus:border-accent disabled:opacity-50 disabled:cursor-not-allowed"
            >
              <option value="">{PERMISSION_LABELS[globalPermissionMode]}</option>
              {globalPermissionMode !== 'plan' && <option value="plan">Plan</option>}
              {globalPermissionMode !== 'dontAsk' && <option value="dontAsk">Don&apos;t Ask (Deny Unless Allowed)</option>}
              {globalPermissionMode !== 'default' && <option value="default">Default (Allowlist)</option>}
              {globalPermissionMode !== 'acceptEdits' && <option value="acceptEdits">Accept Edits</option>}
              {globalPermissionMode !== 'bypassPermissions' && <option value="bypassPermissions">Bypass (Unsafe)</option>}
            </select>
            <p className="text-[11px] text-fg-faint mt-1">
              Override the global permission mode for new agents spawned in this column.
            </p>
          </div>

          {/* After planning dropdown (only for plan-mode columns) */}
          {isPlanMode && (
            <div>
              <label className="text-xs text-fg-muted mb-1.5 block">After Plan Mode</label>
              <select
                value={planExitTargetId ?? ''}
                onChange={(e) => setPlanExitTargetId(e.target.value || null)}
                className="w-full appearance-none bg-surface border border-edge-input rounded px-3 py-1.5 text-sm text-fg focus:outline-none focus:border-accent"
                data-testid="plan-exit-target"
              >
                <option value="">Nowhere -- stay in column</option>
                {swimlanes
                  .filter((s) => s.id !== swimlane.id && s.role !== 'todo' && s.role !== 'done')
                  .map((s) => (
                    <option key={s.id} value={s.id}>{s.name}</option>
                  ))
                }
              </select>
              <p className="text-[11px] text-fg-faint mt-1">
                Automatically moves the task when the agent exits Plan mode.
              </p>
            </div>
          )}

          {/* Auto-command textarea (hidden for backlog/done -- sessions don't run there) */}
          {!isTodoOrDone && (
            <div>
              <label className="text-xs text-fg-muted mb-1.5 block">Auto-command</label>
              <textarea
                value={autoCommand}
                onChange={(e) => setAutoCommand(e.target.value)}
                rows={2}
                placeholder="/test, /review, or a prompt..."
                className="w-full bg-surface border border-edge-input rounded px-3 py-2 text-sm text-fg font-mono placeholder-fg-faint focus:outline-none focus:border-accent resize-y"
                data-testid="auto-command-input"
              />
              <p className="text-[11px] text-fg-faint mt-1 flex items-center gap-1">
                Runs automatically when a task moves into this column
                <span
                  title="Supports variables: {{title}}, {{description}}, {{branchName}}"
                  className="inline-flex cursor-help text-fg-faint hover:text-fg-muted"
                >
                  <Info size={12} />
                </span>
              </p>
            </div>
          )}

        </div>
      </BaseDialog>
  );
}

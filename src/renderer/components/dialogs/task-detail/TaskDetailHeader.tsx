import { useState, useRef, useEffect } from 'react';
import { useCopyDisplayId } from './useCopyDisplayId';
import { X, Trash2, Pencil, Loader2, FolderGit2, FolderOpen, GitPullRequest, ArrowRightLeft, ChevronRight, ChevronLeft, CirclePause, CirclePlay, Clock, SquareChevronRight, Zap, Archive, Inbox, Copy, Check } from 'lucide-react';
import { usePopoverPosition } from '../../../hooks/usePopoverPosition';
import { getSwimlaneIcon } from '../../../utils/swimlane-icons';
import { ICON_REGISTRY } from '../../../utils/swimlane-icons';
import { Pill } from '../../Pill';
import { KebabMenu, KebabMenuItem, KebabMenuDivider } from '../../KebabMenu';
import { CommandPalettePopover } from './CommandPalettePopover';
import { PriorityBadge } from '../../backlog/PriorityBadge';
import type { Task, ClaudeCommand, ShortcutConfig, Swimlane } from '../../../../shared/types';

interface TaskDetailHeaderProps {
  task: Task;
  onClose: () => void;
  isEditing: boolean;
  setIsEditing: (editing: boolean) => void;
  canToggle: boolean;
  isSessionActive: boolean;
  isQueued: boolean;
  isArchived: boolean;
  toggling: boolean;
  onToggle: () => void;
  onCommandSelect: (command: ClaudeCommand) => void;
  onArchive: () => void;
  onSendToBacklog: () => void;
  onDelete: () => void;
  onMoveTo: (targetSwimlaneId: string) => void;
  moveTargets: Swimlane[];
  headerShortcuts: ShortcutConfig[];
  menuShortcuts: ShortcutConfig[];
  executeShortcut: (action: ShortcutConfig) => void;
  projectPath: string | null;
}

export function TaskDetailHeader({
  task,
  onClose,
  isEditing,
  setIsEditing,
  canToggle,
  isSessionActive,
  isQueued,
  isArchived,
  toggling,
  onToggle,
  onCommandSelect,
  onArchive,
  onSendToBacklog,
  onDelete,
  onMoveTo,
  moveTargets,
  headerShortcuts,
  menuShortcuts,
  executeShortcut,
  projectPath,
}: TaskDetailHeaderProps) {
  const [showCommandPalette, setShowCommandPalette] = useState(false);
  const commandButtonRef = useRef<HTMLDivElement>(null);
  const { copied: displayIdCopied, copy: copyDisplayId } = useCopyDisplayId(task.display_id);

  return (
    <div className="flex items-center gap-3 px-4 py-3 min-w-0">
      {/* Pause / Resume toggle */}
      {canToggle && (
        toggling ? (
          <Loader2 size={18} className="text-fg-muted animate-spin flex-shrink-0" />
        ) : (
          <button
            onClick={onToggle}
            className={`p-1 rounded-full transition-colors flex-shrink-0 ${
              isQueued
                ? 'text-fg-muted hover:bg-surface-hover'
                : isSessionActive
                  ? 'text-green-400 hover:bg-green-400/10'
                  : 'text-fg-faint hover:bg-surface-hover hover:text-fg-tertiary'
            }`}
            title={isQueued ? 'Queued (click to pause)' : isSessionActive ? 'Pause session' : 'Resume session'}
          >
            {isQueued ? (
              <Clock size={18} />
            ) : isSessionActive ? (
              <CirclePause size={18} />
            ) : (
              <CirclePlay size={18} />
            )}
          </button>
        )
      )}

      {/* Display ID - clickable to copy */}
      <button
        type="button"
        className="flex items-center gap-1 text-sm font-mono text-fg-muted hover:text-fg-secondary transition-colors flex-shrink-0"
        title={`Click to copy: ${task.display_id}`}
        data-testid="task-display-id"
        onClick={copyDisplayId}
      >
        {displayIdCopied
          ? <Check size={12} className="text-green-400" />
          : <Copy size={12} className="text-fg-disabled" />
        }
        #{task.display_id}
      </button>

      {/* Priority badge (hidden when priority is 0) */}
      <PriorityBadge priority={task.priority ?? 0} />

      {/* Title */}
      <h2 className="text-base font-semibold text-fg truncate min-w-0">{task.title}</h2>

      {/* Scrollable pills container - hidden for archived tasks */}
      {!isArchived ? (
        <div className="flex-1 flex items-center gap-3 min-w-0">
          {/* Commands button */}
          {!isEditing && (
            <div className="relative flex-shrink-0" ref={commandButtonRef}>
              <Pill
                shape="square"
                onClick={() => setShowCommandPalette(!showCommandPalette)}
                className="bg-surface-hover/50 text-fg-muted hover:text-fg-secondary hover:bg-surface-hover transition-colors"
                title="Run a command or skill"
                data-testid="commands-button"
              >
                <SquareChevronRight size={14} />
                Commands
              </Pill>
              {showCommandPalette && (
                <CommandPalettePopover
                  triggerRef={commandButtonRef}
                  cwd={task.worktree_path ?? projectPath ?? undefined}
                  onSelect={(command) => {
                    setShowCommandPalette(false);
                    onCommandSelect(command);
                  }}
                  onClose={() => setShowCommandPalette(false)}
                />
              )}
            </div>
          )}

          {/* Open folder pill */}
          {(task.worktree_path || projectPath) && (
            <Pill
              shape="square"
              onClick={() => window.electronAPI.shell.openPath(task.worktree_path ?? projectPath!)}
              className="bg-surface-hover/50 text-fg-muted hover:text-fg-secondary hover:bg-surface-hover transition-colors flex-shrink-0"
              title={[task.branch_name, task.worktree_path ?? projectPath].filter(Boolean).join('\n') || 'Open working directory'}
              data-testid="branch-pill"
            >
              {task.worktree_path ? (
                <>
                  <FolderGit2 size={14} />
                  Worktree
                </>
              ) : (
                <>
                  <FolderOpen size={14} />
                  Project
                </>
              )}
            </Pill>
          )}

          {/* PR pill */}
          {task.pr_url && (
            <Pill
              shape="square"
              onClick={() => window.electronAPI.shell.openExternal(task.pr_url!)}
              className="bg-surface-hover/50 text-fg-muted hover:text-fg-secondary hover:bg-surface-hover transition-colors flex-shrink-0"
              title={task.pr_url}
              data-testid="pr-pill"
            >
              <GitPullRequest size={14} />
              PR #{task.pr_number}
            </Pill>
          )}

          {/* Shortcut header pills */}
          {headerShortcuts.map((action) => {
            const ActionIcon = ICON_REGISTRY.get(action.icon ?? 'zap') ?? Zap;
            return (
              <Pill
                key={action.id ?? action.label}
                shape="square"
                onClick={() => executeShortcut(action)}
                className="bg-surface-hover/50 text-fg-muted hover:text-fg-secondary hover:bg-surface-hover transition-colors flex-shrink-0"
                title={action.command}
                data-testid={`shortcut-pill-${action.label.toLowerCase().replace(/\s+/g, '-')}`}
              >
                <ActionIcon size={14} />
                {action.label}
              </Pill>
            );
          })}
        </div>
      ) : (
        <div className="flex-1" />
      )}

      {/* Actions */}
      <KebabMenu>
        {(close) => (
          <TaskDetailKebabItems
            task={task}
            close={close}
            setIsEditing={setIsEditing}
            canToggle={canToggle}
            isSessionActive={isSessionActive}
            isArchived={isArchived}
            toggling={toggling}
            onToggle={onToggle}
            onCommandSelect={onCommandSelect}
            onArchive={onArchive}
            onSendToBacklog={onSendToBacklog}
            onDelete={onDelete}
            onMoveTo={onMoveTo}
            moveTargets={moveTargets}
            menuShortcuts={menuShortcuts}
            executeShortcut={executeShortcut}
            projectPath={projectPath}
          />
        )}
      </KebabMenu>

      {/* Divider + Close */}
      <div className="w-px h-5 bg-surface-hover flex-shrink-0" />
      <button
        onClick={onClose}
        className="p-1.5 text-fg-faint hover:text-fg-tertiary hover:bg-surface-hover rounded transition-colors flex-shrink-0"
      >
        <X size={16} />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Kebab menu items (extracted to keep header component clean)
// ---------------------------------------------------------------------------

interface TaskDetailKebabItemsProps {
  task: Task;
  close: () => void;
  setIsEditing: (editing: boolean) => void;
  canToggle: boolean;
  isSessionActive: boolean;
  isArchived: boolean;
  toggling: boolean;
  onToggle: () => void;
  onCommandSelect: (command: ClaudeCommand) => void;
  onArchive: () => void;
  onSendToBacklog: () => void;
  onDelete: () => void;
  onMoveTo: (targetSwimlaneId: string) => void;
  moveTargets: Swimlane[];
  menuShortcuts: ShortcutConfig[];
  executeShortcut: (action: ShortcutConfig) => void;
  projectPath: string | null;
}

function TaskDetailKebabItems({
  task,
  close,
  setIsEditing,
  canToggle,
  isSessionActive,
  isArchived,
  toggling,
  onToggle,
  onCommandSelect,
  onArchive,
  onSendToBacklog,
  onDelete,
  onMoveTo,
  moveTargets,
  menuShortcuts,
  executeShortcut,
  projectPath,
}: TaskDetailKebabItemsProps) {
  const [showMoveSubmenu, setShowMoveSubmenu] = useState(false);
  const [showCommandsSubmenu, setShowCommandsSubmenu] = useState(false);
  const [kebabCommands, setKebabCommands] = useState<ClaudeCommand[]>([]);

  const commandsFlyoutTriggerRef = useRef<HTMLDivElement>(null);
  const commandsFlyoutRef = useRef<HTMLDivElement>(null);
  const moveFlyoutTriggerRef = useRef<HTMLDivElement>(null);
  const moveFlyoutRef = useRef<HTMLDivElement>(null);

  const { placement: commandsFlyoutPlacement } = usePopoverPosition(commandsFlyoutTriggerRef, commandsFlyoutRef, showCommandsSubmenu, { mode: 'flyout' });
  const { placement: moveFlyoutPlacement } = usePopoverPosition(moveFlyoutTriggerRef, moveFlyoutRef, showMoveSubmenu, { mode: 'flyout' });

  // Fetch commands on mount (kebab is open)
  useEffect(() => {
    if (!isSessionActive) return;
    let cancelled = false;
    window.electronAPI.claude.listCommands(task.worktree_path ?? projectPath ?? undefined)
      .then((result) => { if (!cancelled) setKebabCommands(result); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isSessionActive, task.worktree_path, projectPath]);

  const closeAll = () => {
    setShowMoveSubmenu(false);
    setShowCommandsSubmenu(false);
    close();
  };

  return (
    <>
      {/* Edit */}
      <KebabMenuItem
        icon={<Pencil size={14} />}
        label="Edit"
        onClick={() => { closeAll(); setIsEditing(true); }}
      />

      {/* Open folder */}
      {(task.worktree_path || projectPath) && (
        <KebabMenuItem
          icon={<FolderGit2 size={14} />}
          label="Open folder"
          onClick={() => { closeAll(); window.electronAPI.shell.openPath(task.worktree_path ?? projectPath!); }}
        />
      )}

      {/* View PR */}
      {task.pr_url && (
        <KebabMenuItem
          icon={<GitPullRequest size={14} />}
          label={`View PR #${task.pr_number}`}
          onClick={() => { closeAll(); window.electronAPI.shell.openExternal(task.pr_url!); }}
        />
      )}

      {/* Pause / Resume */}
      {canToggle && (
        <KebabMenuItem
          icon={isSessionActive ? <CirclePause size={14} /> : <CirclePlay size={14} />}
          label={isSessionActive ? 'Pause session' : 'Resume session'}
          onClick={() => { closeAll(); onToggle(); }}
          disabled={toggling}
        />
      )}

      {/* Commands -- flyout submenu */}
      {isSessionActive && kebabCommands.length > 0 && (
        <div
          ref={commandsFlyoutTriggerRef}
          className="relative"
          onMouseEnter={() => setShowCommandsSubmenu(true)}
          onMouseLeave={() => setShowCommandsSubmenu(false)}
        >
          <button
            onClick={() => setShowCommandsSubmenu(!showCommandsSubmenu)}
            className={`w-full text-left px-3 py-1.5 text-xs text-fg-tertiary hover:bg-surface-hover hover:text-fg transition-colors flex items-center gap-2 ${showCommandsSubmenu ? 'bg-surface-hover text-fg' : ''}`}
            data-testid="kebab-commands-button"
          >
            <SquareChevronRight size={14} />
            <span className="flex-1">Commands</span>
            {commandsFlyoutPlacement.horizontal === 'left' ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
          </button>
          {showCommandsSubmenu && (
            <div ref={commandsFlyoutRef} className="absolute min-w-[220px] max-h-[300px] overflow-y-auto bg-surface-raised border border-edge-input rounded-md shadow-xl z-50 py-1">
              {kebabCommands.map((command) => (
                <button
                  key={command.name}
                  onClick={() => { closeAll(); onCommandSelect(command); }}
                  className="w-full text-left px-3 py-1.5 text-xs text-fg-tertiary hover:bg-surface-hover hover:text-fg transition-colors"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="truncate">{command.displayName}</span>
                    {command.argumentHint && (
                      <span className="text-[11px] font-mono text-fg-disabled truncate">{command.argumentHint}</span>
                    )}
                  </div>
                  {command.description && (
                    <span className="block text-[11px] text-fg-faint truncate">{command.description}</span>
                  )}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Move to -- flyout submenu */}
      {moveTargets.length > 0 && (
        <div
          ref={moveFlyoutTriggerRef}
          className="relative"
          onMouseEnter={() => setShowMoveSubmenu(true)}
          onMouseLeave={() => setShowMoveSubmenu(false)}
        >
          <button
            onClick={() => setShowMoveSubmenu(!showMoveSubmenu)}
            className={`w-full text-left px-3 py-1.5 text-xs text-fg-tertiary hover:bg-surface-hover hover:text-fg transition-colors flex items-center gap-2 ${showMoveSubmenu ? 'bg-surface-hover text-fg' : ''}`}
          >
            <ArrowRightLeft size={14} />
            <span className="flex-1">Move to</span>
            {moveFlyoutPlacement.horizontal === 'left' ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}
          </button>
          {showMoveSubmenu && (
            <div ref={moveFlyoutRef} className="absolute min-w-[150px] bg-surface-raised border border-edge-input rounded-md shadow-xl z-50 py-1">
              {moveTargets.map((swimlane) => (
                <button
                  key={swimlane.id}
                  onClick={() => onMoveTo(swimlane.id)}
                  className="w-full text-left px-3 py-1.5 text-xs text-fg-tertiary hover:bg-surface-hover hover:text-fg transition-colors flex items-center gap-2"
                >
                  <span className="flex-shrink-0" style={{ color: swimlane.color }}>
                    {(() => {
                      const Icon = getSwimlaneIcon(swimlane);
                      return Icon ? (
                        <Icon size={14} strokeWidth={1.75} />
                      ) : (
                        <div className="w-2 h-2 rounded-full" style={{ backgroundColor: swimlane.color }} />
                      );
                    })()}
                  </span>
                  {swimlane.name}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Shortcuts */}
      {menuShortcuts.length > 0 && (
        <>
          <KebabMenuDivider />
          {menuShortcuts.map((action) => {
            const ActionIcon = ICON_REGISTRY.get(action.icon ?? 'zap') ?? Zap;
            return (
              <KebabMenuItem
                key={action.id ?? action.label}
                icon={<ActionIcon size={14} />}
                label={action.label}
                onClick={() => { closeAll(); executeShortcut(action); }}
                data-testid={`shortcut-kebab-${action.label.toLowerCase().replace(/\s+/g, '-')}`}
              />
            );
          })}
        </>
      )}

      {/* Divider before destructive actions */}
      <KebabMenuDivider />

      {!isArchived && (
        <KebabMenuItem
          icon={<Inbox size={14} />}
          label="Send to Backlog"
          onClick={() => { closeAll(); onSendToBacklog(); }}
          data-testid="send-to-backlog-btn"
        />
      )}

      {!isArchived && (
        <KebabMenuItem
          icon={<Archive size={14} />}
          label="Archive"
          onClick={() => { closeAll(); onArchive(); }}
        />
      )}

      {/* Delete -- always available */}
      <KebabMenuItem
        icon={<Trash2 size={14} />}
        label="Delete"
        onClick={() => { closeAll(); onDelete(); }}
        destructive
      />
    </>
  );
}

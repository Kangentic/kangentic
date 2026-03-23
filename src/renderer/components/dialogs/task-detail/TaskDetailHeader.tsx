import { useState, useRef, useEffect } from 'react';
import { X, Trash2, Pencil, Loader2, FolderGit2, FolderOpen, GitPullRequest, ArrowRightLeft, ChevronRight, ChevronLeft, MoreHorizontal, Archive, CirclePause, CirclePlay, Clock, SquareChevronRight, Zap } from 'lucide-react';
import { usePopoverPosition } from '../../../hooks/usePopoverPosition';
import { getSwimlaneIcon } from '../../../utils/swimlane-icons';
import { ICON_REGISTRY } from '../../../utils/swimlane-icons';
import { Pill } from '../../Pill';
import { CommandPalettePopover } from './CommandPalettePopover';
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
  onDelete,
  onMoveTo,
  moveTargets,
  headerShortcuts,
  menuShortcuts,
  executeShortcut,
  projectPath,
}: TaskDetailHeaderProps) {
  const [showKebabMenu, setShowKebabMenu] = useState(false);
  const [showMoveSubmenu, setShowMoveSubmenu] = useState(false);
  const [showCommandsSubmenu, setShowCommandsSubmenu] = useState(false);
  const [kebabCommands, setKebabCommands] = useState<ClaudeCommand[]>([]);
  const [showCommandPalette, setShowCommandPalette] = useState(false);

  const commandButtonRef = useRef<HTMLDivElement>(null);
  const kebabMenuRef = useRef<HTMLDivElement>(null);
  const kebabPopoverRef = useRef<HTMLDivElement>(null);
  const commandsFlyoutTriggerRef = useRef<HTMLDivElement>(null);
  const commandsFlyoutRef = useRef<HTMLDivElement>(null);
  const moveFlyoutTriggerRef = useRef<HTMLDivElement>(null);
  const moveFlyoutRef = useRef<HTMLDivElement>(null);

  // Smart popover positioning
  const { style: kebabStyle } = usePopoverPosition(kebabMenuRef, kebabPopoverRef, showKebabMenu, { mode: 'dropdown' });
  const { placement: commandsFlyoutPlacement } = usePopoverPosition(commandsFlyoutTriggerRef, commandsFlyoutRef, showCommandsSubmenu, { mode: 'flyout' });
  const { placement: moveFlyoutPlacement } = usePopoverPosition(moveFlyoutTriggerRef, moveFlyoutRef, showMoveSubmenu, { mode: 'flyout' });

  // Fetch commands when kebab menu opens (for the Commands flyout)
  useEffect(() => {
    if (!showKebabMenu || !isSessionActive) return;
    let cancelled = false;
    window.electronAPI.claude.listCommands(task.worktree_path ?? projectPath ?? undefined)
      .then((result) => { if (!cancelled) setKebabCommands(result); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [showKebabMenu, isSessionActive, task.worktree_path, projectPath]);

  // Close kebab menu on click outside
  useEffect(() => {
    if (!showKebabMenu) return;
    const handleClick = (e: MouseEvent) => {
      if (kebabMenuRef.current && !kebabMenuRef.current.contains(e.target as Node)) {
        setShowKebabMenu(false);
        setShowMoveSubmenu(false);
        setShowCommandsSubmenu(false);
      }
    };
    document.addEventListener('mousedown', handleClick, true);
    return () => document.removeEventListener('mousedown', handleClick, true);
  }, [showKebabMenu]);

  const closeAllMenus = () => {
    setShowKebabMenu(false);
    setShowMoveSubmenu(false);
    setShowCommandsSubmenu(false);
  };

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
      <div className="relative flex-shrink-0" ref={kebabMenuRef}>
        <button
          onClick={() => { setShowKebabMenu(!showKebabMenu); setShowMoveSubmenu(false); setShowCommandsSubmenu(false); }}
          className="p-1.5 text-fg-faint hover:text-fg-tertiary hover:bg-surface-hover rounded transition-colors"
          title="Actions"
        >
          <MoreHorizontal size={16} />
        </button>
        {showKebabMenu && (
          <div ref={kebabPopoverRef} style={kebabStyle} className="absolute min-w-[170px] bg-surface-raised border border-edge-input rounded-md shadow-xl z-50 py-1">
            {/* Edit */}
            <button
              onClick={() => { closeAllMenus(); setIsEditing(true); }}
              className="w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center gap-2 text-fg-tertiary hover:bg-surface-hover hover:text-fg"
            >
              <Pencil size={14} />
              Edit
            </button>

            {/* Open folder */}
            {(task.worktree_path || projectPath) && (
              <button
                onClick={() => { closeAllMenus(); window.electronAPI.shell.openPath(task.worktree_path ?? projectPath!); }}
                className="w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center gap-2 text-fg-tertiary hover:bg-surface-hover hover:text-fg"
              >
                <FolderGit2 size={14} />
                Open folder
              </button>
            )}

            {/* View PR */}
            {task.pr_url && (
              <button
                onClick={() => { closeAllMenus(); window.electronAPI.shell.openExternal(task.pr_url!); }}
                className="w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center gap-2 text-fg-tertiary hover:bg-surface-hover hover:text-fg"
              >
                <GitPullRequest size={14} />
                View PR #{task.pr_number}
              </button>
            )}

            {/* Pause / Resume */}
            {canToggle && (
              <button
                onClick={() => { closeAllMenus(); onToggle(); }}
                disabled={toggling}
                className="w-full text-left px-3 py-1.5 text-xs text-fg-tertiary hover:bg-surface-hover hover:text-fg transition-colors flex items-center gap-2 disabled:opacity-50"
              >
                {isSessionActive ? (
                  <>
                    <CirclePause size={14} />
                    Pause session
                  </>
                ) : (
                  <>
                    <CirclePlay size={14} />
                    Resume session
                  </>
                )}
              </button>
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
                        onClick={() => { closeAllMenus(); onCommandSelect(command); }}
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
                    {moveTargets.map((s) => (
                      <button
                        key={s.id}
                        onClick={() => onMoveTo(s.id)}
                        className="w-full text-left px-3 py-1.5 text-xs text-fg-tertiary hover:bg-surface-hover hover:text-fg transition-colors flex items-center gap-2"
                      >
                        <span className="flex-shrink-0" style={{ color: s.color }}>
                          {(() => {
                            const Icon = getSwimlaneIcon(s);
                            return Icon ? (
                              <Icon size={14} strokeWidth={1.75} />
                            ) : (
                              <div className="w-2 h-2 rounded-full" style={{ backgroundColor: s.color }} />
                            );
                          })()}
                        </span>
                        {s.name}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* Shortcuts */}
            {menuShortcuts.length > 0 && (
              <>
                <div className="my-1 mx-2 border-t border-edge-input/50" />
                {menuShortcuts.map((action) => {
                  const ActionIcon = ICON_REGISTRY.get(action.icon ?? 'zap') ?? Zap;
                  return (
                    <button
                      key={action.id ?? action.label}
                      onClick={() => { closeAllMenus(); executeShortcut(action); }}
                      className="w-full text-left px-3 py-1.5 text-xs transition-colors flex items-center gap-2 text-fg-tertiary hover:bg-surface-hover hover:text-fg"
                      data-testid={`shortcut-kebab-${action.label.toLowerCase().replace(/\s+/g, '-')}`}
                    >
                      <ActionIcon size={14} />
                      {action.label}
                    </button>
                  );
                })}
              </>
            )}

            {/* Divider before destructive actions */}
            <div className="my-1 mx-2 border-t border-edge-input/50" />

            {!isArchived && (
              <button
                onClick={() => { closeAllMenus(); onArchive(); }}
                className="w-full text-left px-3 py-1.5 text-xs text-fg-tertiary hover:bg-surface-hover hover:text-fg transition-colors flex items-center gap-2"
              >
                <Archive size={14} />
                Archive
              </button>
            )}

            {/* Delete -- always available */}
            <button
              onClick={() => { closeAllMenus(); onDelete(); }}
              className="w-full text-left px-3 py-1.5 text-xs text-red-400 hover:bg-red-400/10 hover:text-red-300 transition-colors flex items-center gap-2"
            >
              <Trash2 size={14} />
              Delete
            </button>
          </div>
        )}
      </div>

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

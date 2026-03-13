import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import type { BrowserWindow } from 'electron';
import { FileWatcher } from '../pty/file-watcher';
import { SwimlaneRepository } from '../db/repositories/swimlane-repository';
import { ActionRepository } from '../db/repositories/action-repository';
import { getProjectDb } from '../db/database';
import { IPC } from '../../shared/ipc-channels';
import type {
  BoardConfig,
  BoardColumnConfig,
  SwimlaneRole,
} from '../../shared/types';

const TEAM_FILE = 'kangentic.json';
const LOCAL_FILE = 'kangentic.local.json';
const CURRENT_VERSION = 1;

/**
 * Central orchestrator for shareable board configuration via kangentic.json.
 * Handles file watching, reconciliation (file -> DB), write-back (DB -> file),
 * and ghost column lifecycle.
 *
 * Only watches the active (viewed) project. When the user switches projects,
 * attach() runs initialReconcile() which picks up any changes that happened
 * while the project was inactive. No background watchers for inactive projects.
 */
export class BoardConfigManager {
  private readonly isEphemeral: boolean;
  private activeProjectId: string | null = null;
  private activeProjectPath: string | null = null;
  private mainWindow: BrowserWindow | null = null;
  private teamWatcher: FileWatcher | null = null;
  private localWatcher: FileWatcher | null = null;
  private isWritingBack = false;
  private writeBackDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastTeamContentHash: string | null = null;
  private lastLocalContentHash: string | null = null;

  constructor(options?: { ephemeral?: boolean }) {
    this.isEphemeral = options?.ephemeral ?? false;
  }

  /**
   * Set the active project (for write-back and file watching) and start watchers.
   * Detaches the previous project first.
   */
  attach(projectId: string, projectPath: string, mainWindow: BrowserWindow): void {
    this.detach();
    this.activeProjectId = projectId;
    this.activeProjectPath = projectPath;
    this.mainWindow = mainWindow;

    const teamFilePath = path.join(projectPath, TEAM_FILE);
    const localFilePath = path.join(projectPath, LOCAL_FILE);

    this.teamWatcher = new FileWatcher({
      filePath: teamFilePath,
      onChange: () => this.onFileChanged(projectId, 'team'),
      label: `kangentic.json [${projectId.slice(0, 8)}]`,
      debounceMs: 300,
    });

    this.localWatcher = new FileWatcher({
      filePath: localFilePath,
      onChange: () => this.onFileChanged(projectId, 'local'),
      label: `kangentic.local.json [${projectId.slice(0, 8)}]`,
      debounceMs: 300,
    });
  }

  /**
   * Clear active project state, close file watchers, and cancel write-back timer.
   */
  detach(): void {
    if (this.writeBackDebounceTimer) {
      clearTimeout(this.writeBackDebounceTimer);
      this.writeBackDebounceTimer = null;
    }
    if (this.teamWatcher) {
      this.teamWatcher.close();
      this.teamWatcher = null;
    }
    if (this.localWatcher) {
      this.localWatcher.close();
      this.localWatcher = null;
    }
    this.activeProjectId = null;
    this.activeProjectPath = null;
    this.isWritingBack = false;
    this.lastTeamContentHash = null;
    this.lastLocalContentHash = null;
  }

  /** Check if kangentic.json exists for a given project path. */
  existsForPath(projectPath: string): boolean {
    return fs.existsSync(path.join(projectPath, TEAM_FILE));
  }

  /** Check if kangentic.json exists for the active project. */
  exists(): boolean {
    if (!this.activeProjectPath) return false;
    return this.existsForPath(this.activeProjectPath);
  }

  // --- File Reading ---

  private loadTeamConfigForPath(projectPath: string): BoardConfig | null {
    const filePath = path.join(projectPath, TEAM_FILE);
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as BoardConfig;
    } catch {
      return null;
    }
  }

  loadTeamConfig(): BoardConfig | null {
    if (!this.activeProjectPath) return null;
    return this.loadTeamConfigForPath(this.activeProjectPath);
  }

  private loadLocalOverridesForPath(projectPath: string): Partial<BoardConfig> | null {
    const filePath = path.join(projectPath, LOCAL_FILE);
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(raw) as Partial<BoardConfig>;
    } catch {
      return null;
    }
  }

  loadLocalOverrides(): Partial<BoardConfig> | null {
    if (!this.activeProjectPath) return null;
    return this.loadLocalOverridesForPath(this.activeProjectPath);
  }

  private getEffectiveConfigForPath(projectPath: string): BoardConfig | null {
    const team = this.loadTeamConfigForPath(projectPath);
    if (!team) return null;
    const local = this.loadLocalOverridesForPath(projectPath);
    if (!local) return team;
    return mergeBoardConfigs(team, local);
  }

  getEffectiveConfig(): BoardConfig | null {
    if (!this.activeProjectPath) return null;
    return this.getEffectiveConfigForPath(this.activeProjectPath);
  }

  // --- Reconciliation (file -> DB) ---

  /**
   * Reconcile a specific project's config file into its database.
   * Accepts explicit projectId and projectPath so it can work for any project,
   * not just the active one.
   */
  reconcile(projectId: string, projectPath: string): { warnings: string[] } {
    const warnings: string[] = [];
    const config = this.getEffectiveConfigForPath(projectPath);

    // If no config file, nothing to reconcile
    if (!config) return { warnings: [] };

    // Validation: fatal errors
    const fatalError = validateBoardConfig(config);
    if (fatalError) {
      return { warnings: [fatalError] };
    }

    const db = getProjectDb(projectId);
    const swimlaneRepo = new SwimlaneRepository(db);
    const actionRepo = new ActionRepository(db);

    // Version check: future versions are best-effort with a warning, not fatal
    if (config.version > CURRENT_VERSION) {
      warnings.push(`kangentic.json uses version ${config.version}. Some features may not be supported.`);
    }

    const transaction = db.transaction(() => {
      // --- Ensure system columns ---
      // Query existing lanes once. Used for both system column ID reuse and reconciliation.
      const existingLanes = swimlaneRepo.list();

      const hasBacklog = config.columns.some((column) => column.role === 'backlog');
      if (!hasBacklog) {
        const existingBacklog = existingLanes.find((lane) => lane.role === 'backlog');
        config.columns.unshift({
          id: existingBacklog?.id,
          name: existingBacklog?.name ?? 'Backlog',
          role: 'backlog',
          icon: 'layers',
          color: '#6b7280',
          autoSpawn: false,
        });
        warnings.push('kangentic.json is missing a backlog column. Added default.');
      }

      const hasDone = config.columns.some((column) => column.role === 'done');
      if (!hasDone) {
        const existingDone = existingLanes.find((lane) => lane.role === 'done');
        config.columns.push({
          id: existingDone?.id,
          name: existingDone?.name ?? 'Done',
          role: 'done',
          icon: 'circle-check-big',
          color: '#10b981',
          autoSpawn: false,
          archived: true,
        });
        warnings.push('kangentic.json is missing a done column. Added default.');
      }

      // Enforce position: backlog first, done last
      const backlogIndex = config.columns.findIndex((column) => column.role === 'backlog');
      if (backlogIndex > 0) {
        const [backlogColumn] = config.columns.splice(backlogIndex, 1);
        config.columns.unshift(backlogColumn);
        warnings.push('Backlog column must be first. Position corrected.');
      }

      const doneIndex = config.columns.findIndex((column) => column.role === 'done');
      if (doneIndex >= 0 && doneIndex < config.columns.length - 1) {
        const [doneColumn] = config.columns.splice(doneIndex, 1);
        config.columns.push(doneColumn);
        warnings.push('Done column must be last. Position corrected.');
      }

      // --- Reconcile columns ---
      const existingById = new Map(existingLanes.map((lane) => [lane.id, lane]));
      const configIds = new Set(config.columns.filter((column) => column.id).map((column) => column.id!));

      // Create/update columns from config
      for (let index = 0; index < config.columns.length; index++) {
        const columnConfig = config.columns[index];
        const existing = columnConfig.id ? existingById.get(columnConfig.id) : undefined;

        // Enforce system column constraints
        const isBacklog = columnConfig.role === 'backlog';
        const isDone = columnConfig.role === 'done';

        if (existing) {
          // Update existing column
          swimlaneRepo.update({
            id: existing.id,
            name: columnConfig.name,
            color: columnConfig.color ?? existing.color,
            icon: columnConfig.icon ?? existing.icon,
            position: index,
            is_archived: isDone ? true : (isBacklog ? false : (columnConfig.archived ?? existing.is_archived)),
            is_ghost: false,
            permission_strategy: (isBacklog || isDone) ? null : (columnConfig.permissionStrategy ?? existing.permission_strategy),
            auto_spawn: (isBacklog || isDone) ? false : (columnConfig.autoSpawn ?? existing.auto_spawn),
            auto_command: columnConfig.autoCommand ?? existing.auto_command,
          });
        } else {
          // Create new column (pass config id if provided, otherwise repo generates UUID)
          swimlaneRepo.create({
            id: columnConfig.id,
            name: columnConfig.name,
            role: columnConfig.role as SwimlaneRole | undefined,
            color: columnConfig.color ?? '#3b82f6',
            icon: columnConfig.icon ?? null,
            is_archived: isDone ? true : (isBacklog ? false : (columnConfig.archived ?? false)),
            is_ghost: false,
            permission_strategy: (isBacklog || isDone) ? null : (columnConfig.permissionStrategy ?? null),
            auto_spawn: (isBacklog || isDone) ? false : (columnConfig.autoSpawn ?? true),
            auto_command: columnConfig.autoCommand ?? null,
            position: index,
          });
        }
      }

      // Ghost or delete columns not in config.
      // Skip when no config entries have ids (hand-written config without ids is additive,
      // not destructive. Write-back will serialize the new UUIDs for future reconciliation.)
      if (configIds.size > 0) {
        for (const existing of existingLanes) {
          if (configIds.has(existing.id)) continue;
          if (existing.is_ghost) continue; // already a ghost

          // Check if column has tasks
          const taskCount = db.prepare('SELECT COUNT(*) as c FROM tasks WHERE swimlane_id = ?').get(existing.id) as { c: number };
          if (taskCount.c > 0) {
            swimlaneRepo.setGhost(existing.id, true);
          } else {
            // Safe to delete empty column
            db.prepare('DELETE FROM swimlane_transitions WHERE from_swimlane_id = ? OR to_swimlane_id = ?').run(existing.id, existing.id);
            db.prepare('UPDATE swimlanes SET plan_exit_target_id = NULL WHERE plan_exit_target_id = ?').run(existing.id);
            db.prepare('DELETE FROM swimlanes WHERE id = ?').run(existing.id);
          }
        }
      }

      // Clean up empty ghosts
      swimlaneRepo.deleteEmptyGhosts();

      // --- Reconcile actions ---
      const existingActions = actionRepo.list();
      const existingActionsById = new Map(existingActions.map((action) => [action.id, action]));
      const configActionIds = new Set((config.actions || []).filter((action) => action.id).map((action) => action.id!));

      for (const actionConfig of (config.actions || [])) {
        const existing = actionConfig.id ? existingActionsById.get(actionConfig.id) : undefined;

        if (existing) {
          actionRepo.update({
            id: existing.id,
            name: actionConfig.name,
            type: actionConfig.type,
            config_json: JSON.stringify(actionConfig.config),
          });
        } else {
          actionRepo.create({
            id: actionConfig.id,
            name: actionConfig.name,
            type: actionConfig.type,
            config_json: JSON.stringify(actionConfig.config),
          });
        }
      }

      // Delete actions not in config (only when config has id-tracked actions.
      // Skip when no config entries have ids to avoid wiping hand-written configs.)
      if (configActionIds.size > 0) {
        for (const existing of existingActions) {
          if (configActionIds.has(existing.id)) continue;
          actionRepo.delete(existing.id);
        }
      }

      // --- Reconcile transitions ---
      // Only delete-and-replace transitions for from+to pairs mentioned in config.
      // Transitions NOT mentioned in config are preserved.
      if (config.transitions && config.transitions.length > 0) {
        // Refresh lanes and actions after reconciliation
        const reconciledLanes = swimlaneRepo.list();
        const reconciledActions = actionRepo.list();
        const laneByName = new Map(reconciledLanes.map((lane) => [lane.name, lane]));
        const actionByName = new Map(reconciledActions.map((action) => [action.name, action]));

        for (const transitionConfig of config.transitions) {
          const toLane = laneByName.get(transitionConfig.to);
          if (!toLane) {
            warnings.push(`Transition references unknown column '${transitionConfig.to}'. Skipped.`);
            continue;
          }

          const fromId = transitionConfig.from === '*' ? '*' : laneByName.get(transitionConfig.from)?.id;
          if (!fromId) {
            warnings.push(`Transition references unknown column '${transitionConfig.from}'. Skipped.`);
            continue;
          }

          // Delete only this pair's existing transitions, then insert replacements
          db.prepare('DELETE FROM swimlane_transitions WHERE from_swimlane_id = ? AND to_swimlane_id = ?')
            .run(fromId, toLane.id);

          for (let order = 0; order < transitionConfig.actions.length; order++) {
            const actionName = transitionConfig.actions[order];
            const action = actionByName.get(actionName);
            if (!action) {
              warnings.push(`Transition references unknown action '${actionName}'. Skipped.`);
              continue;
            }

            db.prepare(
              'INSERT INTO swimlane_transitions (id, from_swimlane_id, to_swimlane_id, action_id, execution_order) VALUES (?, ?, ?, ?, ?)'
            ).run(uuidv4(), fromId, toLane.id, action.id, order);
          }
        }
      }

      // --- Resolve planExitTarget name -> UUID ---
      const finalLanes = swimlaneRepo.list();
      const finalLaneByName = new Map(finalLanes.map((lane) => [lane.name, lane]));

      for (const columnConfig of config.columns) {
        if (!columnConfig.planExitTarget) continue;
        const sourceLane = finalLaneByName.get(columnConfig.name);
        const targetLane = finalLaneByName.get(columnConfig.planExitTarget);
        if (sourceLane && targetLane) {
          swimlaneRepo.update({
            id: sourceLane.id,
            plan_exit_target_id: targetLane.id,
          });
        } else if (sourceLane && !targetLane) {
          swimlaneRepo.update({
            id: sourceLane.id,
            plan_exit_target_id: null,
          });
          warnings.push(`planExitTarget references unknown column '${columnConfig.planExitTarget}'. Cleared.`);
        }
      }
    });

    transaction();
    return { warnings };
  }

  // --- Write-back (DB -> file) ---

  writeBack(): void {
    if (this.isEphemeral) return;
    if (!this.activeProjectId || !this.activeProjectPath) return;

    // Debounce rapid sequential UI changes
    if (this.writeBackDebounceTimer) {
      clearTimeout(this.writeBackDebounceTimer);
    }

    this.writeBackDebounceTimer = setTimeout(() => {
      this.writeBackDebounceTimer = null;
      this.doWriteBack();
    }, 500);
  }

  private doWriteBack(): void {
    if (!this.activeProjectId || !this.activeProjectPath) return;

    this.isWritingBack = true;

    try {
      const db = getProjectDb(this.activeProjectId);
      const swimlaneRepo = new SwimlaneRepository(db);
      const actionRepo = new ActionRepository(db);

      const lanes = swimlaneRepo.list().filter((lane) => !lane.is_ghost);
      const actions = actionRepo.list();
      const transitions = actionRepo.listTransitions();

      // Build maps for transitions
      const laneById = new Map(lanes.map((lane) => [lane.id, lane]));
      const actionById = new Map(actions.map((action) => [action.id, action]));

      const boardConfig: BoardConfig = {
        version: CURRENT_VERSION,
        columns: lanes.map((lane) => {
          const column: BoardColumnConfig = {
            id: lane.id,
            name: lane.name,
          };
          if (lane.role) column.role = lane.role;
          if (lane.icon) column.icon = lane.icon;
          if (lane.color && lane.color !== '#3b82f6') column.color = lane.color;
          if (lane.auto_spawn) column.autoSpawn = true;
          if (!lane.auto_spawn && !lane.role) column.autoSpawn = false;
          if (lane.permission_strategy) column.permissionStrategy = lane.permission_strategy;
          if (lane.is_archived && lane.role !== 'done') column.archived = true;
          if (lane.auto_command) column.autoCommand = lane.auto_command;

          // Resolve plan_exit_target_id to target column name
          if (lane.plan_exit_target_id) {
            const target = laneById.get(lane.plan_exit_target_id);
            if (target) column.planExitTarget = target.name;
          }

          return column;
        }),
        actions: actions.map((action) => ({
          id: action.id,
          name: action.name,
          type: action.type,
          config: JSON.parse(action.config_json),
        })),
        transitions: [],
      };

      // Group transitions by from+to using column/action names
      const transitionGroups = new Map<string, { from: string; to: string; actions: string[] }>();
      for (const transition of transitions) {
        const fromLane = transition.from_swimlane_id === '*' ? null : laneById.get(transition.from_swimlane_id);
        const toLane = laneById.get(transition.to_swimlane_id);
        const action = actionById.get(transition.action_id);

        const fromName = transition.from_swimlane_id === '*' ? '*' : fromLane?.name;
        const toName = toLane?.name;
        const actionName = action?.name;

        if (!fromName || !toName || !actionName) continue;

        const key = `${fromName}\0${toName}`;
        if (!transitionGroups.has(key)) {
          transitionGroups.set(key, { from: fromName, to: toName, actions: [] });
        }
        transitionGroups.get(key)!.actions.push(actionName);
      }

      boardConfig.transitions = Array.from(transitionGroups.values());

      // Atomic write: tmp file + rename
      const teamFilePath = path.join(this.activeProjectPath, TEAM_FILE);
      const tmpPath = teamFilePath + '.tmp.' + process.pid;
      const content = JSON.stringify(boardConfig, null, 2) + os.EOL;
      fs.writeFileSync(tmpPath, content);
      fs.renameSync(tmpPath, teamFilePath);
      // Store hash after successful write so watcher echo is suppressed even if isWritingBack expires
      this.lastTeamContentHash = crypto.createHash('sha256').update(content).digest('hex');
    } catch (error) {
      console.warn('[BOARD_CONFIG] Write-back failed:', error);
    } finally {
      // Keep isWritingBack true for a bit to suppress watcher re-entry
      setTimeout(() => {
        this.isWritingBack = false;
      }, 1000);
    }
  }

  // --- Export (bootstrap kangentic.json from existing DB) ---

  exportFromDb(): void {
    if (this.isEphemeral) return;
    if (!this.activeProjectId || !this.activeProjectPath) return;
    // Write-back immediately (synchronous, no debounce).
    // doWriteBack() manages isWritingBack internally.
    this.doWriteBack();
  }

  // --- Apply pending file change (called from renderer after user confirms) ---

  applyFileChange(projectId: string, projectPath: string): { warnings: string[] } {
    const result = this.reconcile(projectId, projectPath);
    // Update hashes to suppress echo events from the reconciled content
    this.lastTeamContentHash = this.hashFileContent(path.join(projectPath, TEAM_FILE));
    this.lastLocalContentHash = this.hashFileContent(path.join(projectPath, LOCAL_FILE));
    return result;
  }

  // --- File change handler ---

  private hashFileContent(filePath: string): string | null {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return crypto.createHash('sha256').update(content).digest('hex');
    } catch {
      return null;
    }
  }

  private onFileChanged(projectId: string, source: 'team' | 'local'): void {
    // Fast path: suppress write-back echo for the active project
    if (this.isWritingBack && projectId === this.activeProjectId) return;

    if (!this.activeProjectPath) return;

    // Content hash comparison: only notify if file content actually changed
    const filePath = path.join(
      this.activeProjectPath,
      source === 'team' ? TEAM_FILE : LOCAL_FILE,
    );
    const currentHash = this.hashFileContent(filePath);
    if (currentHash === null) return;

    const lastHash = source === 'team' ? this.lastTeamContentHash : this.lastLocalContentHash;
    if (currentHash === lastHash) return;

    // Content actually changed: update stored hash and notify renderer
    if (source === 'team') {
      this.lastTeamContentHash = currentHash;
    } else {
      this.lastLocalContentHash = currentHash;
    }

    this.sendChangedEvent(projectId);
  }

  /** Send BOARD_CONFIG_CHANGED event to renderer with projectId. */
  private sendChangedEvent(projectId: string): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send(IPC.BOARD_CONFIG_CHANGED, projectId);
  }

  /** Run initial reconciliation on project open. */
  initialReconcile(): string[] {
    if (!this.activeProjectId || !this.activeProjectPath) return [];
    const result = this.reconcile(this.activeProjectId, this.activeProjectPath);
    // Seed content hashes so the first watcher event post-attach is compared correctly
    this.lastTeamContentHash = this.hashFileContent(
      path.join(this.activeProjectPath, TEAM_FILE),
    );
    this.lastLocalContentHash = this.hashFileContent(
      path.join(this.activeProjectPath, LOCAL_FILE),
    );
    return result.warnings;
  }
}

// --- Validation ---

export function validateBoardConfig(config: BoardConfig): string | null {
  if (!config.version) {
    return 'kangentic.json is missing the version field. Board loaded from local database.';
  }
  // version > CURRENT_VERSION is handled as a non-fatal warning in reconcile()
  if (!config.columns || config.columns.length === 0) {
    return 'kangentic.json has no columns defined. Board loaded from local database.';
  }

  // Check for duplicate column names
  const columnNames = new Set<string>();
  for (const column of config.columns) {
    if (columnNames.has(column.name)) {
      return `kangentic.json has duplicate column name '${column.name}'. Board loaded from local database.`;
    }
    columnNames.add(column.name);
  }

  if (config.actions) {
    const actionNames = new Set<string>();
    for (const action of config.actions) {
      if (actionNames.has(action.name)) {
        return `kangentic.json has duplicate action name '${action.name}'. Board loaded from local database.`;
      }
      actionNames.add(action.name);
    }
  }

  return null;
}

// --- Merge Logic ---

export function mergeBoardConfigs(team: BoardConfig, local: Partial<BoardConfig>): BoardConfig {
  const result: BoardConfig = { ...team };

  // Merge columns by id
  if (local.columns) {
    const mergedColumns: BoardColumnConfig[] = [];
    const usedIds = new Set<string>();

    // Start with team columns, applying local overrides
    for (const teamColumn of team.columns) {
      if (teamColumn.id) usedIds.add(teamColumn.id);
      const localColumn = local.columns.find((localColumn) => localColumn.id && localColumn.id === teamColumn.id);
      if (localColumn) {
        mergedColumns.push({ ...teamColumn, ...localColumn });
      } else {
        mergedColumns.push(teamColumn);
      }
    }

    // Add local-only columns before done
    const localOnlyColumns = local.columns.filter((localColumn) => !localColumn.id || !usedIds.has(localColumn.id));
    if (localOnlyColumns.length > 0) {
      const doneIndex = mergedColumns.findIndex((column) => column.role === 'done');
      const insertIndex = doneIndex >= 0 ? doneIndex : mergedColumns.length;
      mergedColumns.splice(insertIndex, 0, ...localOnlyColumns);
    }

    result.columns = mergedColumns;
  }

  // Merge actions by id
  if (local.actions) {
    const mergedActions = [...(team.actions || [])];
    for (const localAction of local.actions) {
      const existingIndex = mergedActions.findIndex((action) => action.id && action.id === localAction.id);
      if (existingIndex >= 0) {
        mergedActions[existingIndex] = localAction;
      } else {
        mergedActions.push(localAction);
      }
    }
    result.actions = mergedActions;
  }

  // Merge transitions by from+to
  if (local.transitions) {
    const mergedTransitions = [...(team.transitions || [])];
    for (const localTransition of local.transitions) {
      const existingIndex = mergedTransitions.findIndex(
        (transition) => transition.from === localTransition.from && transition.to === localTransition.to,
      );
      if (existingIndex >= 0) {
        mergedTransitions[existingIndex] = localTransition;
      } else {
        mergedTransitions.push(localTransition);
      }
    }
    result.transitions = mergedTransitions;
  }

  return result;
}

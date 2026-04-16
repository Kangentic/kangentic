import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { BrowserWindow } from 'electron';
import { FileWatcher } from '../pty/readers/file-watcher';
import { IPC } from '../../shared/ipc-channels';
import type {
  BoardConfig,
  ShortcutConfig,
} from '../../shared/types';
import {
  CURRENT_VERSION,
  TEAM_FILE,
  LOCAL_FILE,
  migrateBoardColumnFields,
  mergeBoardConfigs,
} from './board-config/config-helpers';
import {
  hashFilePath,
  contentMatchesFile,
  atomicWriteJson,
  computeFingerprint,
} from './board-config/atomic-write';
import { applyBoardConfigToDb } from './board-config/apply-config';
import { buildBoardConfigFromDb } from './board-config/build-config';

/**
 * Central orchestrator for shareable board configuration via kangentic.json.
 * Handles file watching, applying file state to the DB, write-back (DB -> file),
 * and ghost column lifecycle.
 *
 * The heavy lifting lives in:
 *   - `board-config/config-helpers.ts` - constants, migration, validation, merging
 *   - `board-config/apply-config.ts`   - BoardConfig -> DB (applyBoardConfigToDb)
 *   - `board-config/build-config.ts`   - DB -> BoardConfig (buildBoardConfigFromDb)
 *   - `board-config/atomic-write.ts`   - hash + atomic-rename helpers
 *
 * Only watches the active (viewed) project. When the user switches projects,
 * attach() runs applyConfigOnOpen() which picks up any changes that happened
 * while the project was inactive. No background watchers for inactive projects.
 */
export class BoardConfigManager {
  private readonly isEphemeral: boolean;
  private readonly fingerprint: string;
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
    this.fingerprint = computeFingerprint();
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
      debounceMs: 300,
    });

    this.localWatcher = new FileWatcher({
      filePath: localFilePath,
      onChange: () => this.onFileChanged(projectId, 'local'),
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
      const config = JSON.parse(raw) as BoardConfig;
      migrateBoardColumnFields(config);
      return config;
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
      const config = JSON.parse(raw) as Partial<BoardConfig>;
      if (config.columns) migrateBoardColumnFields(config as BoardConfig);
      return config;
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
   * Apply a specific project's kangentic.json (+ local overrides) to its
   * database. Accepts explicit projectId and projectPath so it can work
   * for any project, not just the active one.
   */
  applyConfig(projectId: string, projectPath: string): { warnings: string[] } {
    const config = this.getEffectiveConfigForPath(projectPath);
    return applyBoardConfigToDb(projectId, config);
  }

  // --- Default Base Branch ---

  getDefaultBaseBranch(): string | undefined {
    const config = this.getEffectiveConfig();
    return config?.defaultBaseBranch;
  }

  setDefaultBaseBranch(value: string): void {
    if (!this.activeProjectPath) return;

    const filePath = path.join(this.activeProjectPath, TEAM_FILE);

    let existing: Partial<BoardConfig> = {};
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      existing = JSON.parse(raw) as Partial<BoardConfig>;
    } catch {
      existing = { version: CURRENT_VERSION, columns: [], actions: [], transitions: [] };
    }

    existing.defaultBaseBranch = value;
    (existing as BoardConfig)._modifiedBy = this.fingerprint;

    const fileCheck = contentMatchesFile(filePath, existing);
    if (fileCheck.matches) {
      this.lastTeamContentHash = fileCheck.contentHash;
      return;
    }

    this.isWritingBack = true;
    try {
      this.lastTeamContentHash = atomicWriteJson(filePath, existing);
    } catch (error) {
      console.warn('[BOARD_CONFIG] setDefaultBaseBranch failed:', error);
    } finally {
      setTimeout(() => {
        this.isWritingBack = false;
      }, 1000);
    }
  }

  // --- Shortcuts ---

  getShortcuts(): (ShortcutConfig & { source: 'team' | 'local' })[] {
    if (!this.activeProjectPath) return [];

    const team = this.loadTeamConfig();
    const local = this.loadLocalOverrides();

    const result: (ShortcutConfig & { source: 'team' | 'local' })[] = [];
    const localOverrideIds = new Set<string>();

    if (local?.shortcuts) {
      for (const action of local.shortcuts) {
        if (action.id) localOverrideIds.add(action.id);
      }
    }

    // Team actions first (original order), skipping those overridden by local
    if (team?.shortcuts) {
      for (const action of team.shortcuts) {
        if (action.id && localOverrideIds.has(action.id)) {
          const localVersion = local!.shortcuts!.find((localAction) => localAction.id === action.id)!;
          result.push({ ...localVersion, source: 'local' });
        } else {
          result.push({ ...action, source: 'team' });
        }
      }
    }

    // Append local-only actions (those without a matching team ID)
    if (local?.shortcuts) {
      for (const action of local.shortcuts) {
        if (!action.id || !team?.shortcuts?.some((teamAction) => teamAction.id === action.id)) {
          result.push({ ...action, source: 'local' });
        }
      }
    }

    return result;
  }

  setShortcuts(actions: ShortcutConfig[], target: 'team' | 'local'): void {
    if (!this.activeProjectPath) return;

    const fileName = target === 'team' ? TEAM_FILE : LOCAL_FILE;
    const filePath = path.join(this.activeProjectPath, fileName);

    // Ensure all actions have an id
    const actionsWithIds = actions.map((action) => ({
      ...action,
      id: action.id || crypto.randomUUID(),
    }));

    let existing: Partial<BoardConfig> = {};
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      existing = JSON.parse(raw) as Partial<BoardConfig>;
    } catch {
      if (target === 'team') {
        existing = { version: CURRENT_VERSION, columns: [], actions: [], transitions: [] };
      }
    }

    existing.shortcuts = actionsWithIds;
    if (target === 'team') {
      (existing as BoardConfig)._modifiedBy = this.fingerprint;
    }

    const fileCheck = contentMatchesFile(filePath, existing);
    if (fileCheck.matches) {
      if (target === 'team') {
        this.lastTeamContentHash = fileCheck.contentHash;
      } else {
        this.lastLocalContentHash = fileCheck.contentHash;
      }
      return;
    }

    this.isWritingBack = true;
    try {
      const contentHash = atomicWriteJson(filePath, existing);
      if (target === 'team') {
        this.lastTeamContentHash = contentHash;
      } else {
        this.lastLocalContentHash = contentHash;
      }
    } catch (error) {
      console.warn(`[BOARD_CONFIG] setShortcuts(${target}) failed:`, error);
    } finally {
      setTimeout(() => {
        this.isWritingBack = false;
      }, 1000);
    }

    // No sendChangedEvent here: shortcut changes don't affect board structure
    // (columns, actions, transitions). The ShortcutsTab reloads directly via
    // loadShortcuts() after saving. Sending BOARD_CONFIG_CHANGED would trigger
    // the "Board configuration changed" reconciliation dialog unnecessarily.
  }

  // --- Write-back (DB -> file) ---

  writeBack(): void {
    if (this.isEphemeral) return;
    if (!this.activeProjectId || !this.activeProjectPath) return;

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

    try {
      const existingTeam = this.loadTeamConfig();
      const boardConfig = buildBoardConfigFromDb({
        projectId: this.activeProjectId,
        existingTeamConfig: existingTeam,
        fingerprint: this.fingerprint,
      });

      const teamFilePath = path.join(this.activeProjectPath, TEAM_FILE);

      const fileCheck = contentMatchesFile(teamFilePath, boardConfig);
      if (fileCheck.matches) {
        this.lastTeamContentHash = fileCheck.contentHash;
        return;
      }

      this.isWritingBack = true;
      this.lastTeamContentHash = atomicWriteJson(teamFilePath, boardConfig);
    } catch (error) {
      console.warn('[BOARD_CONFIG] Write-back failed:', error);
    } finally {
      // Keep isWritingBack true for a bit to suppress watcher re-entry
      if (this.isWritingBack) {
        setTimeout(() => {
          this.isWritingBack = false;
        }, 1000);
      }
    }
  }

  // --- Export (bootstrap kangentic.json from existing DB) ---

  exportFromDb(): void {
    if (this.isEphemeral) return;
    if (!this.activeProjectId || !this.activeProjectPath) return;
    this.doWriteBack();
  }

  // --- Apply pending file change (called from renderer after user confirms) ---

  applyFileChange(projectId: string, projectPath: string): { warnings: string[] } {
    const result = this.applyConfig(projectId, projectPath);
    this.lastTeamContentHash = hashFilePath(path.join(projectPath, TEAM_FILE));
    this.lastLocalContentHash = hashFilePath(path.join(projectPath, LOCAL_FILE));
    return result;
  }

  // --- File change handler ---

  private onFileChanged(projectId: string, source: 'team' | 'local'): void {
    // Fast path: suppress during active write-back
    if (this.isWritingBack && projectId === this.activeProjectId) return;
    if (!this.activeProjectPath) return;

    // Local overrides are user-specific and gitignored.
    // Never show the reconciliation dialog for local changes.
    // Just silently reload shortcuts in case they changed.
    if (source === 'local') {
      this.lastLocalContentHash = hashFilePath(
        path.join(this.activeProjectPath, LOCAL_FILE),
      );
      this.sendShortcutsChangedEvent(projectId);
      return;
    }

    // --- Team file (kangentic.json) ---
    const filePath = path.join(this.activeProjectPath, TEAM_FILE);

    // Content hash: fast path for no-change (watcher echo)
    const currentHash = hashFilePath(filePath);
    if (currentHash === null) return;
    if (currentHash === this.lastTeamContentHash) return;
    this.lastTeamContentHash = currentHash;

    // Fingerprint check: did WE write this file?
    try {
      const raw = fs.readFileSync(filePath, 'utf-8');
      const config = JSON.parse(raw);
      if (config._modifiedBy === this.fingerprint) {
        // We wrote it. Silently reload shortcuts (in case they changed)
        // but do NOT show the reconciliation dialog.
        this.sendShortcutsChangedEvent(projectId);
        return;
      }
    } catch {
      // Parse failure: treat as external change
    }

    this.sendChangedEvent(projectId);
  }

  /** Send BOARD_CONFIG_SHORTCUTS_CHANGED event for silent shortcut reload. */
  private sendShortcutsChangedEvent(projectId: string): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send(IPC.BOARD_CONFIG_SHORTCUTS_CHANGED, projectId);
  }

  /** Send BOARD_CONFIG_CHANGED event to renderer with projectId. */
  private sendChangedEvent(projectId: string): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send(IPC.BOARD_CONFIG_CHANGED, projectId);
  }

  /** Apply the active project's config to its DB on project open. */
  applyConfigOnOpen(): string[] {
    if (!this.activeProjectId || !this.activeProjectPath) return [];
    const result = this.applyConfig(this.activeProjectId, this.activeProjectPath);
    this.lastTeamContentHash = hashFilePath(path.join(this.activeProjectPath, TEAM_FILE));
    this.lastLocalContentHash = hashFilePath(path.join(this.activeProjectPath, LOCAL_FILE));
    return result.warnings;
  }
}

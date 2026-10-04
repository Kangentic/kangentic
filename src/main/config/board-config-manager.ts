import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { BrowserWindow } from 'electron';
import { FileWatcher } from '../pty/readers/file-watcher';
import { IPC } from '../../shared/ipc-channels';
import type {
  BoardConfig,
  BoardProfile,
  ShortcutConfig,
} from '../../shared/types';
import {
  CURRENT_VERSION,
  TEAM_FILE,
  LOCAL_FILE,
  migrateBoardColumnFields,
  mergeBoardConfigs,
  readObjectList,
  isJsonObject,
  validateBoardConfig,
  parseConfigJson,
  BoardConfigUnreadableError,
} from './board-config/config-helpers';
import {
  hashFilePath,
  contentMatchesFile,
  atomicWriteJson,
  computeFingerprint,
} from './board-config/atomic-write';
import { applyBoardConfigToDb } from './board-config/apply-config';
import { buildBoardConfigFromDb } from './board-config/build-config';

/** How often, and how far apart, a write-back retries a file a lock is holding. */
const WRITE_BACK_LOCK_RETRIES = 3;
const WRITE_BACK_LOCK_RETRY_MS = 500;

const NOT_AN_OBJECT_REASON = 'The file is not a JSON object.';

/**
 * The user-facing reason for a failed read: the error code only. Node's
 * message carries the absolute path, and the reason reaches the board's
 * banner, a toast, and an MCP command's error.
 */
function readErrorReason(code: string | undefined): string {
  return `Reading it failed with ${code ?? 'an unknown error'}.`;
}

/**
 * Parse a config file for the loaders, throwing when it holds valid JSON that
 * is not an object (`[]`, `"x"`). The loaders turn the throw into null, so a
 * reader treats that file as missing, which is how `readProblem` classifies it.
 */
function parseConfigObject(raw: string): Record<string, unknown> {
  const parsed = parseConfigJson(raw);
  if (!isJsonObject(parsed)) throw new Error(NOT_AN_OBJECT_REASON);
  return parsed;
}

/** What a settings save writes when kangentic.json does not exist yet. */
function emptyTeamConfig(): Partial<BoardConfig> {
  return { version: CURRENT_VERSION, columns: [], actions: [], transitions: [] };
}

/** Does this file hold a board, as opposed to a settings-save stub with no columns? */
function carriesColumns(config: BoardConfig): boolean {
  const columns: unknown = config.columns;
  if (columns === undefined || columns === null) return false;
  return !Array.isArray(columns) || columns.length > 0;
}

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
 *
 * Reads of the ACTIVE project's two files are memoized: getDefaultBaseBranch()
 * fires on every task finalization and every renderer CONFIG_GET, and used to
 * re-read + re-parse both files each time. The cache is invalidated by every
 * write path in this class and by the FileWatchers on external edits, so at
 * worst a read within the watcher's 300ms debounce window after an external
 * edit serves the previous content - acceptable, since the DB reconcile flow
 * is itself watcher-driven. Non-active paths (the MCP writeBackForProject
 * route) always bypass the cache: they have no watcher to invalidate it.
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
  /** Memoized parse of the ACTIVE project's kangentic.json / kangentic.local.json.
   *  `undefined` = not cached; `null` = file missing or unparseable. Both store
   *  and serve go through structuredClone: consumers mutate their copies
   *  (applyBoardConfigToDb renames/splices in place, mergeBoardConfigs aliases
   *  team column objects), so the cached instance must never leak. */
  private cachedTeamConfig: BoardConfig | null | undefined = undefined;
  private cachedLocalOverrides: Partial<BoardConfig> | null | undefined = undefined;
  /** The warnings of each project's last apply, kept so the renderer can fetch
   *  them. The open-time push can land before the renderer has made that project
   *  current (a launch restore, an open by folder path), and is dropped then. */
  private readonly lastWarningsByProject = new Map<string, string[]>();

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
    // New active project = unknown files. (applyConfigOnOpen runs right after
    // attach and only writes the DB, so it needs no invalidation of its own.)
    this.invalidateConfigCache();

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
    this.invalidateConfigCache();
  }

  private invalidateConfigCache(): void {
    this.cachedTeamConfig = undefined;
    this.cachedLocalOverrides = undefined;
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

  /**
   * Shared read path for both config files: serve the memo for the ACTIVE
   * project, otherwise read + parse from disk and (when active) store back.
   * Both store and serve go through structuredClone so the cached instance
   * never leaks to mutating consumers (see the cache fields' JSDoc).
   * `undefined` from `readCache` = not cached; `null` = file missing or
   * unparseable (also cached, so a missing file is not re-stat'd every read).
   */
  private readConfigFileMemoized<ConfigShape>(
    projectPath: string,
    fileName: string,
    readCache: () => ConfigShape | null | undefined,
    writeCache: (value: ConfigShape | null) => void,
    parse: (raw: string) => ConfigShape,
  ): ConfigShape | null {
    const isActivePath = projectPath === this.activeProjectPath;
    if (isActivePath) {
      const cached = readCache();
      if (cached !== undefined) {
        return cached === null ? null : structuredClone(cached);
      }
    }
    let config: ConfigShape | null;
    try {
      config = parse(fs.readFileSync(path.join(projectPath, fileName), 'utf-8'));
    } catch {
      config = null;
    }
    if (isActivePath) {
      writeCache(config === null ? null : structuredClone(config));
    }
    return config;
  }

  private loadTeamConfigForPath(projectPath: string): BoardConfig | null {
    return this.readConfigFileMemoized(
      projectPath,
      TEAM_FILE,
      () => this.cachedTeamConfig,
      (value) => { this.cachedTeamConfig = value; },
      (raw) => {
        const config = parseConfigObject(raw) as unknown as BoardConfig;
        migrateBoardColumnFields(config);
        return config;
      },
    );
  }

  loadTeamConfig(): BoardConfig | null {
    if (!this.activeProjectPath) return null;
    return this.loadTeamConfigForPath(this.activeProjectPath);
  }

  private loadLocalOverridesForPath(projectPath: string): Partial<BoardConfig> | null {
    return this.readConfigFileMemoized(
      projectPath,
      LOCAL_FILE,
      () => this.cachedLocalOverrides,
      (value) => { this.cachedLocalOverrides = value; },
      (raw) => {
        const config = parseConfigObject(raw) as Partial<BoardConfig>;
        if (config.columns) migrateBoardColumnFields(config as BoardConfig);
        return config;
      },
    );
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

  /**
   * Why a config file that exists cannot be used, or null when it is missing
   * or reads as a JSON object.
   *
   * The loaders above return null for both "missing" and "unreadable", which is
   * right for a reader and wrong for a writer. A git merge conflict leaves
   * markers in kangentic.json, and every write path here treated the file as
   * absent and replaced it: the open-time export with the local database's
   * state, a settings save with a near-empty config. The merge the user was in
   * the middle of was gone, with nothing said. Every write path checks this
   * first and refuses, and the apply path turns it into a warning the board
   * shows.
   *
   * Not memoized: it runs on an apply, a write-back, or a settings save, never
   * on a hot read path.
   *
   * A read error reports its code, never its message. Node's message carries
   * the absolute path, and the reason reaches the board's banner and a toast.
   * `transient` marks the codes a Windows lock produces (antivirus, an editor
   * mid-save, a sync client), which the write-back retries instead of dropping.
   */
  private readProblem(projectPath: string, fileName: string): { reason: string; transient: boolean } | null {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(projectPath, fileName), 'utf-8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return null;
      return {
        reason: readErrorReason(code),
        transient: code === 'EBUSY' || code === 'EPERM' || code === 'EAGAIN',
      };
    }
    // An empty file (an interrupted write, or `touch`) holds nothing to lose,
    // so it reads as missing and the next write re-creates it, as before.
    if (raw.trim() === '') return null;
    try {
      return isJsonObject(parseConfigJson(raw))
        ? null
        : { reason: NOT_AN_OBJECT_REASON, transient: false };
    } catch (error) {
      return { reason: error instanceof Error ? error.message : String(error), transient: false };
    }
  }

  /**
   * Throw before a settings save would replace a file that cannot be read.
   * It throws rather than skips. The IPC caller toasts the message and an MCP
   * command returns it as its error, where a silent skip reported success for
   * a change that never reached the file.
   */
  private assertWritable(projectPath: string, fileName: string, operation: string): void {
    const problem = this.readProblem(projectPath, fileName);
    if (problem === null) return;
    console.warn(`[BOARD_CONFIG] ${operation} refused: ${fileName} could not be read and was left as it is. ${problem.reason}`);
    throw new BoardConfigUnreadableError(fileName, problem.reason);
  }

  /**
   * Read the file a settings save is about to rewrite, or `fallback` when it
   * does not exist. Callers run `assertWritable` first, so a failure here means
   * the file changed or was locked in between. It throws the same
   * `BoardConfigUnreadableError` as `assertWritable`, never the raw error: a
   * Node read error's message carries the absolute path, and the profile prune
   * on column delete swallows only this error type.
   */
  private readExistingForWrite(projectPath: string, fileName: string, fallback: Partial<BoardConfig>): Partial<BoardConfig> {
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(projectPath, fileName), 'utf-8');
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return fallback;
      throw new BoardConfigUnreadableError(fileName, readErrorReason(code));
    }
    if (raw.trim() === '') return fallback;
    let parsed: unknown;
    try {
      parsed = parseConfigJson(raw);
    } catch (error) {
      throw new BoardConfigUnreadableError(fileName, error instanceof Error ? error.message : String(error));
    }
    if (!isJsonObject(parsed)) throw new BoardConfigUnreadableError(fileName, NOT_AN_OBJECT_REASON);
    return parsed as Partial<BoardConfig>;
  }

  // --- Reconciliation (file -> DB) ---

  /**
   * Apply a specific project's kangentic.json (+ local overrides) to its
   * database. Accepts explicit projectId and projectPath so it can work
   * for any project, not just the active one.
   */
  applyConfig(projectId: string, projectPath: string): { warnings: string[] } {
    const teamProblem = this.readProblem(projectPath, TEAM_FILE);
    if (teamProblem !== null) {
      return {
        warnings: [`${TEAM_FILE} could not be read, so board edits are not saved to it until it is fixed. ${teamProblem.reason}`],
      };
    }
    // An unreadable local file is dropped by the loader and the team file
    // applies on its own, as before. The warning is what is new.
    const warnings: string[] = [];
    const localProblem = this.readProblem(projectPath, LOCAL_FILE);
    if (localProblem !== null) {
      warnings.push(`${LOCAL_FILE} could not be read, so its overrides were not applied. ${localProblem.reason}`);
    }
    const config = this.getEffectiveConfigForPath(projectPath);
    const result = applyBoardConfigToDb(projectId, config);
    return { warnings: [...warnings, ...result.warnings] };
  }

  // --- Default Base Branch ---

  getDefaultBaseBranch(): string | undefined {
    const config = this.getEffectiveConfig();
    return config?.defaultBaseBranch;
  }

  /**
   * The team-shared default base branch of a project that is NOT the active one,
   * for the Agent Monitor's cross-project task detail (its branch picker must
   * offer that project's default, not the open board's).
   */
  getDefaultBaseBranchForPath(projectPath: string): string | undefined {
    return this.getEffectiveConfigForPath(projectPath)?.defaultBaseBranch;
  }

  setDefaultBaseBranch(value: string): void {
    if (!this.activeProjectPath) return;
    // Invalidate up front so every exit path below (content-match early
    // return, write, write failure) serves fresh reads afterwards.
    this.invalidateConfigCache();
    this.assertWritable(this.activeProjectPath, TEAM_FILE, 'setDefaultBaseBranch');

    const filePath = path.join(this.activeProjectPath, TEAM_FILE);
    const existing = this.readExistingForWrite(this.activeProjectPath, TEAM_FILE, emptyTeamConfig());

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

  // --- Board Profiles ---

  /**
   * The board's named Board Profiles (see `BoardProfile`), team config merged
   * with local overrides.
   *
   * Takes an explicit `projectPath` because spawns are not limited to the active
   * project - startup recovery resumes sessions across every open project, and
   * resolving a task's profile against the wrong board would silently hand it
   * another project's ladder. Falls back to the active project for call sites
   * that genuinely mean "the board on screen".
   *
   * Returns `[]` rather than throwing when there is no config: a board with no
   * profiles is the normal state, and every consumer treats it as "everything
   * runs the columns' own settings".
   */
  getBoardProfiles(projectPath?: string): BoardProfile[] {
    const targetPath = projectPath ?? this.activeProjectPath;
    if (!targetPath) return [];
    // Read as a list of objects: every spawn resolves its profile through here,
    // so a hand-edited `"profiles": {}` must read as none rather than throw.
    return readObjectList<BoardProfile>(this.getEffectiveConfigForPath(targetPath)?.profiles);
  }

  /**
   * Persist the board's Board Profiles to the team file, assigning a uuid to
   * any profile that lacks one (mirrors `setShortcuts`).
   *
   * Team-only, deliberately: a profile is referenced by `tasks.profile_id` on
   * every machine that opens the board, so a personal-only profile would leave
   * teammates with tasks pointing at an id they cannot resolve. Shortcuts can be
   * local because nothing else references them.
   *
   * Like `setShortcuts`, this does NOT emit BOARD_CONFIG_CHANGED: profiles do
   * not alter board structure (columns, actions, transitions), so raising the
   * reconciliation dialog would be noise.
   *
   * `projectPath` mirrors `getBoardProfiles`. An agent syncing profiles across
   * projects ("copy this board's Heavy profile into project X") targets a board
   * that is not the one on screen, and without the parameter that write would
   * either no-op or land on the wrong board. Watcher-suppression bookkeeping is
   * gated on the target actually being the active project, exactly as
   * `doWriteBack` does - an inactive project has no watcher here, so touching
   * `isWritingBack` / `lastTeamContentHash` would corrupt the active project's
   * state.
   */
  setBoardProfiles(profiles: BoardProfile[], projectPath?: string): void {
    const targetPath = projectPath ?? this.activeProjectPath;
    if (!targetPath) return;
    const isActive = targetPath === this.activeProjectPath;
    if (isActive) this.invalidateConfigCache();
    this.assertWritable(targetPath, TEAM_FILE, 'setBoardProfiles');

    const filePath = path.join(targetPath, TEAM_FILE);
    const profilesWithIds = profiles.map((profile) => ({
      ...profile,
      id: profile.id || crypto.randomUUID(),
    }));

    const existing = this.readExistingForWrite(targetPath, TEAM_FILE, emptyTeamConfig());

    // Drop the key entirely when empty rather than writing `"profiles": []`, so
    // a board that has never used the feature stays byte-identical to before.
    if (profilesWithIds.length > 0) {
      existing.profiles = profilesWithIds;
    } else {
      delete existing.profiles;
    }
    (existing as BoardConfig)._modifiedBy = this.fingerprint;

    const fileCheck = contentMatchesFile(filePath, existing);
    if (fileCheck.matches) {
      if (isActive) this.lastTeamContentHash = fileCheck.contentHash;
      return;
    }

    if (isActive) this.isWritingBack = true;
    try {
      const contentHash = atomicWriteJson(filePath, existing);
      if (isActive) this.lastTeamContentHash = contentHash;
    } catch (error) {
      console.warn('[BOARD_CONFIG] setBoardProfiles failed:', error);
    } finally {
      if (isActive) {
        setTimeout(() => {
          this.isWritingBack = false;
        }, 1000);
      }
    }
  }

  // --- Shortcuts ---

  getShortcuts(): (ShortcutConfig & { source: 'team' | 'local' })[] {
    if (!this.activeProjectPath) return [];
    return this.getShortcutsForPath(this.activeProjectPath);
  }

  /**
   * The same merge for a project that is NOT the active one, mirroring the
   * `*ForPath` reads above. Needed by the Agent Monitor, which hosts a task
   * detail (and therefore its header's custom shortcut pills) for a project
   * whose board is not open. Parameterised rather than copied so the team/local
   * precedence has exactly one implementation.
   */
  getShortcutsForPath(projectPath: string): (ShortcutConfig & { source: 'team' | 'local' })[] {
    // Read as lists of objects: a hand-edited `"shortcuts": {}` in either file
    // used to throw "is not iterable" out of every board load.
    const teamShortcuts = readObjectList<ShortcutConfig>(this.loadTeamConfigForPath(projectPath)?.shortcuts);
    const localShortcuts = readObjectList<ShortcutConfig>(this.loadLocalOverridesForPath(projectPath)?.shortcuts);

    const result: (ShortcutConfig & { source: 'team' | 'local' })[] = [];
    const localOverrideIds = new Set<string>();

    for (const action of localShortcuts) {
      if (action.id) localOverrideIds.add(action.id);
    }

    // Team actions first (original order), skipping those overridden by local
    for (const action of teamShortcuts) {
      if (action.id && localOverrideIds.has(action.id)) {
        const localVersion = localShortcuts.find((localAction) => localAction.id === action.id)!;
        result.push({ ...localVersion, source: 'local' });
      } else {
        result.push({ ...action, source: 'team' });
      }
    }

    // Append local-only actions (those without a matching team ID)
    for (const action of localShortcuts) {
      if (!action.id || !teamShortcuts.some((teamAction) => teamAction.id === action.id)) {
        result.push({ ...action, source: 'local' });
      }
    }

    return result;
  }

  setShortcuts(actions: ShortcutConfig[], target: 'team' | 'local'): void {
    if (!this.activeProjectPath) return;
    this.invalidateConfigCache();

    const fileName = target === 'team' ? TEAM_FILE : LOCAL_FILE;
    this.assertWritable(this.activeProjectPath, fileName, `setShortcuts(${target})`);
    const filePath = path.join(this.activeProjectPath, fileName);

    // Ensure all actions have an id
    const actionsWithIds = actions.map((action) => ({
      ...action,
      id: action.id || crypto.randomUUID(),
    }));

    const existing = this.readExistingForWrite(this.activeProjectPath, fileName, target === 'team' ? emptyTeamConfig() : {});

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

  /**
   * Write a specific project's current DB state to its kangentic.json,
   * regardless of which project is currently attached/active. Used by the MCP
   * command path, where a tool call can target a project other than the one
   * open in the UI (see mcp-http/project-resolver). Best-effort: never throws.
   * Writes immediately (no debounce) because MCP tool calls are discrete, not
   * the rapid successive edits a UI drag produces.
   */
  writeBackForProject(projectId: string, projectPath: string): void {
    if (this.isEphemeral) return;
    this.doWriteBack(projectId, projectPath);
  }

  private doWriteBack(
    projectId: string | null = this.activeProjectId,
    projectPath: string | null = this.activeProjectPath,
    attempt = 0,
  ): void {
    if (!projectId || !projectPath) return;

    // The watcher-suppression bookkeeping (isWritingBack / lastTeamContentHash)
    // only applies to the active project, which is the one with live file
    // watchers. A cross-project write (an MCP tool call against a non-active
    // project) has no watcher attached here, so it must not set or clobber the
    // active project's suppression state.
    const isActive =
      projectId === this.activeProjectId && projectPath === this.activeProjectPath;

    // The export runs on every project open and after every board edit, so
    // this is the path that most often met a conflicted file and replaced it.
    // Never throws, because its callers are a debounce timer and the open path. A lock
    // that clears on its own is retried a bounded number of times instead of
    // dropping the edit until the next one.
    const problem = this.readProblem(projectPath, TEAM_FILE);
    if (problem !== null) {
      if (problem.transient && attempt < WRITE_BACK_LOCK_RETRIES) {
        setTimeout(() => this.doWriteBack(projectId, projectPath, attempt + 1), WRITE_BACK_LOCK_RETRY_MS);
        return;
      }
      console.warn(`[BOARD_CONFIG] Write-back skipped: ${TEAM_FILE} could not be read and was left as it is. ${problem.reason}`);
      return;
    }

    try {
      const existingTeam = this.loadTeamConfigForPath(projectPath);
      // A file the validator rejects left the board on the database. Writing
      // the database back would replace the edit the user has to fix. Before
      // the validator reported wrong-shape lists, they threw out of the apply,
      // and the open path's catch skipped this export by accident.
      //
      // Except a file with no columns at all. A settings save on a project with
      // no kangentic.json writes a stub with `"columns": []`, which the validator
      // rejects as "no columns defined"; refusing it would block every
      // write-back from then on, and there is no board in it to lose.
      const rejection = existingTeam && carriesColumns(existingTeam) ? validateBoardConfig(existingTeam) : null;
      if (rejection !== null) {
        console.warn(`[BOARD_CONFIG] Write-back skipped: ${TEAM_FILE} was left as it is. ${rejection}`);
        return;
      }
      const boardConfig = buildBoardConfigFromDb({
        projectId,
        existingTeamConfig: existingTeam,
        fingerprint: this.fingerprint,
      });

      const teamFilePath = path.join(projectPath, TEAM_FILE);

      const fileCheck = contentMatchesFile(teamFilePath, boardConfig);
      if (fileCheck.matches) {
        if (isActive) this.lastTeamContentHash = fileCheck.contentHash;
        return;
      }

      if (isActive) this.isWritingBack = true;
      const contentHash = atomicWriteJson(teamFilePath, boardConfig);
      if (isActive) this.lastTeamContentHash = contentHash;
    } catch (error) {
      console.warn('[BOARD_CONFIG] Write-back failed:', error);
    } finally {
      // The active project's file just changed under the read memo.
      if (isActive) this.invalidateConfigCache();
      // Keep isWritingBack true for a bit to suppress watcher re-entry
      if (isActive && this.isWritingBack) {
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
    // The user confirmed an external edit: drop the memo before applyConfig
    // re-reads the files.
    this.invalidateConfigCache();
    const result = this.applyConfig(projectId, projectPath);
    this.lastTeamContentHash = hashFilePath(path.join(projectPath, TEAM_FILE));
    this.lastLocalContentHash = hashFilePath(path.join(projectPath, LOCAL_FILE));
    // A fixed file clears what the last open reported, so a later fetch does
    // not bring back a banner for a problem that is gone.
    this.lastWarningsByProject.set(projectId, result.warnings);
    return result;
  }

  // --- File change handler ---

  private onFileChanged(projectId: string, source: 'team' | 'local'): void {
    // FIRST, before any suppression fast-path can return: the file on disk
    // changed, so the read memo is stale regardless of who changed it.
    this.invalidateConfigCache();
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

    // Content hash: fast path for no-change (watcher echo). Together with the
    // isWritingBack window above, this fully suppresses the app's own write-backs.
    // Anything that gets past both filters is a genuine external edit - a teammate's
    // commit OR our own commit pulled back on this same machine - and must reconcile
    // live, so always send BOARD_CONFIG_CHANGED. The renderer's apply path re-reads
    // the file, and loadBoard() also reloads shortcuts, so the team-file shortcuts
    // case is covered here too.
    const currentHash = hashFilePath(filePath);
    if (currentHash === null) return;
    if (currentHash === this.lastTeamContentHash) return;
    this.lastTeamContentHash = currentHash;

    this.sendChangedEvent(projectId);
  }

  /** Send BOARD_CONFIG_SHORTCUTS_CHANGED event for silent shortcut reload. */
  private sendShortcutsChangedEvent(projectId: string): void {
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send(IPC.BOARD_CONFIG_SHORTCUTS_CHANGED, projectId);
  }

  /**
   * Record the project-open reconcile's warnings and push them to the renderer,
   * which shows them in the board's warning banner. Sent on every open,
   * including an empty list, so the banner a previous project raised does not
   * stay up.
   *
   * Stored BEFORE the push, and that order is why the pair cannot lose a warning. The
   * renderer drops a push for a project that is not yet current, and fetches
   * (`getLastWarnings`) each time a project becomes current. A push it dropped
   * was stored first, so the later fetch finds it; a fetch that ran before the
   * reconcile is followed by a push that arrives once the project is current.
   */
  sendOpenWarnings(projectId: string, warnings: string[]): void {
    this.lastWarningsByProject.set(projectId, warnings);
    if (!this.mainWindow || this.mainWindow.isDestroyed()) return;
    this.mainWindow.webContents.send(IPC.BOARD_CONFIG_WARNINGS, projectId, warnings);
  }

  /** The warnings of a project's last apply, or none. See `sendOpenWarnings`. */
  getLastWarnings(projectId: string): string[] {
    return this.lastWarningsByProject.get(projectId) ?? [];
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

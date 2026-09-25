import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ensureDirs } from './paths';
import type { AppConfig, DeepPartial, PermissionMode, ThemeMode } from '../../shared/types';
import { DEFAULT_CONFIG } from '../../shared/types';
import { deepMerge, deepMergeConfig } from '../../shared/object-utils';
import { safeWriteJson } from '../safe-write';
import { reportSyncWriteFailure } from './write-failure-notice';

/** Dotted paths in AppConfig that must be REPLACED wholesale on a partial update
 *  (not deep-merged), so key/window deletion and a full-blob reset both work. This
 *  covers true `Record<string, ...>` dictionaries (where merge would leak deleted
 *  keys) AND renderer-authoritative layout blobs (`commandTerminalWorkspace`,
 *  `monitorWorkspace`) the renderer always writes in full.
 *
 *  What the layout blobs actually need this for is their OBJECT-shaped fields, not
 *  their arrays: `deepMerge` already assigns an array wholesale (it recurses only
 *  into non-array objects), so the `windows` array shrinks correctly either way.
 *  The entry protects `tileTree` - collapsing a two-pane split to a single leaf
 *  would otherwise merge-leak the old split's `direction` / `children` / `sizes`
 *  onto the leaf - plus any legacy key a rewritten blob is meant to drop. Every
 *  other typed-struct field gets MERGE semantics. Update this list when adding such
 *  a field to AppConfig. */
const CONFIG_DICTIONARY_PATHS = [
  'backlog.labelColors',
  'agent.cliPaths',
  'agent.executionServers',
  'agent.execution',
  'agent.launchOptions',
  'hotkeyOverrides',
  'workspaceByProject',
  'commandTerminalWorkspace',
  'monitorWorkspace',
  'popOutBounds',
  'terminal.colors',
  'onboardingBaseline',
] as const;

/** Drop keys whose value is undefined. Returns undefined when nothing is left,
 *  so callers can skip writing empty nested objects. */
function pruneUndefined(obj: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(obj).filter(([, value]) => value !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

/**
 * The product pair's ids for the three days they existed on `main` before the pair
 * was named. No release carried them, but a dogfooding config file or a project's
 * `.kangentic/config.json` can, and a retired id paints as the classless dark palette.
 */
const RETIRED_THEME_IDS: Record<string, ThemeMode> = { 'kangentic-light': 'clay', 'kangentic-dark': 'rust' };
const THEME_ID_KEYS = ['theme', 'themeLight', 'themeDark'] as const;

/** Rewrite retired theme ids in place across the three theme keys; true when any changed. */
function renameRetiredThemeIds(target: Record<string, unknown>): boolean {
  let changed = false;
  for (const key of THEME_ID_KEYS) {
    const value = target[key];
    if (typeof value === 'string' && value in RETIRED_THEME_IDS) {
      target[key] = RETIRED_THEME_IDS[value];
      changed = true;
    }
  }
  return changed;
}

/**
 * Pick only the project-overridable keys from a config-like object. This is the
 * single definition of "what counts as a project setting". Both the global
 * defaults snapshot (getProjectOverridableDefaults) and new-project seeding
 * (getLastProjectOverrides) run through it, so non-setting keys that also live in
 * `.kangentic/config.json` - importSources, browser, backlog.labelColors, etc. -
 * are never treated as inheritable settings and never get cloned into new projects.
 *
 * Tolerates partial input: undefined leaves and empty nested objects are dropped
 * so a sparsely-configured source project produces a tidy seed.
 *
 * KEEP IN SYNC with pickOverridableSubset() in tests/ui/mock-electron-api.js
 */
export function pickOverridableSubset(source: DeepPartial<AppConfig>): Partial<AppConfig> {
  const result: Record<string, unknown> = {};

  if (source.theme !== undefined) result.theme = source.theme;
  // The follow-system trio travels with `theme`: all four are the Theme tab.
  if (source.themeFollowsSystem !== undefined) result.themeFollowsSystem = source.themeFollowsSystem;
  if (source.themeLight !== undefined) result.themeLight = source.themeLight;
  if (source.themeDark !== undefined) result.themeDark = source.themeDark;

  // terminal.* (shell, fontSize, fontFamily, scrollbackLines, cursorStyle,
  // backspaceSendsCtrlH) used to be project-overridable but is now global-only
  // (see the doc comments on AppConfig['terminal'] in shared/types.ts) - shell
  // in particular was never reliably per-project at the PTY-spawn level
  // (SessionManager caches a single configuredShell keyed to whichever project
  // is currently focused), so this function deliberately does not pick a
  // terminal block at all anymore.

  // agent.execution (local/remote mode + server working directory) is
  // deliberately NOT included here, even though it is project-scoped and
  // user-editable in Project Settings: this function also seeds a BRAND NEW
  // project's config from the most-recently-configured project
  // (getLastProjectOverrides in projects.ts), and a remote server's working
  // directory is project-specific data (like browser.defaultUrl) - it would
  // point a new project's tasks at a different project's server-side
  // directory. `agent.execution` is written directly via updateProjectOverride
  // (setting-scope.tsx), which does not go through this function.
  if (source.agent?.permissionMode !== undefined) {
    result.agent = { permissionMode: source.agent.permissionMode };
  }

  const git = pruneUndefined({
    worktreesEnabled: source.git?.worktreesEnabled,
    autoCleanup: source.git?.autoCleanup,
    defaultBaseBranch: source.git?.defaultBaseBranch,
    copyFiles: source.git?.copyFiles,
    initScript: source.git?.initScript,
    linkNodeModules: source.git?.linkNodeModules,
    prRefreshIntervalMinutes: source.git?.prRefreshIntervalMinutes,
    autoFetchIntervalMinutes: source.git?.autoFetchIntervalMinutes,
    prEvaluateBranchPolicies: source.git?.prEvaluateBranchPolicies,
    prBypassCountsAsReady: source.git?.prBypassCountsAsReady,
  });
  if (git) result.git = git;

  return result as Partial<AppConfig>;
}

export class ConfigManager {
  private config: AppConfig | null = null;

  load(): AppConfig {
    if (this.config) return this.config;

    // A failed mkdir here (dead volume) must degrade to defaults, not throw out
    // of load() - the readFileSync below already tolerates a missing directory
    // (ENOENT falls into the catch and sets configFileUnreadable), so swallowing
    // this one is enough to let the rest of the method run its normal fallback.
    // Tagged apart from the 'config' file write below on purpose: ensureDirs()
    // creates configDir, projectsDir AND modelsDir, and the models cache can
    // sit on a different volume. Sharing one tag would let a later successful
    // config-file write clear a still-broken models-directory latch, which is
    // the cross-source interleaving write-failure-notice.ts exists to prevent.
    try {
      ensureDirs();
    } catch (error) {
      reportSyncWriteFailure(error, 'config_dirs');
    }
    let parsed: Record<string, unknown> | null = null;
    // `parsed === null` covers two very different states: there is no config file
    // yet, or there is one and we could not read or parse it. The migrations below
    // save(), which rewrites the file wholesale - harmless on a fresh install, and
    // destructive on a file that is merely unparseable. Keep them apart.
    let configFileUnreadable = false;
    try {
      const raw = fs.readFileSync(PATHS.configFile, 'utf-8');
      const rawParsed: unknown = JSON.parse(raw);
      // JSON.parse can succeed on content that is valid JSON but not a usable config
      // object: `null`, an array, or a bare primitive (number/string/boolean). None of
      // those throw here, so without this guard they would fall through as if the file
      // had been read successfully - `parsed && 'claude' in parsed` below throws on a
      // primitive (the `in` operator requires an object operand), and for an array
      // deepMergeConfig silently returns a bare-defaults copy with no error at all,
      // which the unconditional windowLightDismiss migration further down would then
      // persist over the file's actual (non-object) contents. Treat this exactly like
      // an unparseable file: fall back to defaults in memory, leave the file untouched.
      if (rawParsed !== null && typeof rawParsed === 'object' && !Array.isArray(rawParsed)) {
        parsed = rawParsed as Record<string, unknown>;
        this.config = deepMergeConfig(DEFAULT_CONFIG, parsed as Partial<AppConfig>);
      } else {
        this.config = { ...DEFAULT_CONFIG };
        configFileUnreadable = true;
      }
    } catch {
      this.config = { ...DEFAULT_CONFIG };
      configFileUnreadable = fs.existsSync(PATHS.configFile);
    }

    // One-time migration: claude.* namespace -> agent.* (cliPath -> cliPaths).
    // Spread the already-merged default first so any new agent.* fields added
    // in the future are carried through without having to touch this block.
    if (parsed && 'claude' in parsed && !('agent' in parsed)) {
      const legacy = parsed.claude as Record<string, unknown>;
      const cliPath = legacy.cliPath;
      this.config.agent = {
        ...this.config.agent,
        permissionMode: (legacy.permissionMode as PermissionMode) ?? this.config.agent.permissionMode,
        cliPaths: typeof cliPath === 'string' ? { claude: cliPath } : {},
        maxConcurrentSessions: (legacy.maxConcurrentSessions as number) ?? this.config.agent.maxConcurrentSessions,
        queueOverflow: (legacy.queueOverflow as 'queue' | 'reject') ?? this.config.agent.queueOverflow,
        idleTimeoutMinutes: (legacy.idleTimeoutMinutes as number) ?? this.config.agent.idleTimeoutMinutes,
      };
      delete (this.config as unknown as Record<string, unknown>).claude;
      this.save(this.config);
    }

    // One-time migration: legacy permission mode values -> new names
    const pm = this.config.agent.permissionMode as string;
    const migrationMap: Record<string, string> = {
      'dangerously-skip': 'bypassPermissions',
      'project-settings': 'acceptEdits',
      'bypass-permissions': 'bypassPermissions',
      'manual': 'acceptEdits',
    };
    if (pm in migrationMap) {
      this.config.agent.permissionMode = migrationMap[pm] as PermissionMode;
      this.save(this.config);
    }

    // One-time migration: the product pair's retired ids -> clay / rust.
    if (parsed && renameRetiredThemeIds(this.config as unknown as Record<string, unknown>)) {
      this.save(this.config);
    }

    // One-time migration: notifyIdleOnInactiveProject -> notifications.desktop.onAgentIdle
    if (parsed && 'notifyIdleOnInactiveProject' in parsed) {
      this.config.notifications.desktop.onAgentIdle = Boolean(parsed.notifyIdleOnInactiveProject);
      delete (this.config as unknown as Record<string, unknown>).notifyIdleOnInactiveProject;
      this.save(this.config);
    }

    // One-time migration: drop a stale global terminal.scrollbackLines. The
    // setting was removed; the live xterm scrollback cap is now a fixed
    // internal constant (TERMINAL_SCROLLBACK_LINES in useTerminal.ts).
    const parsedTerminal = parsed?.terminal as Record<string, unknown> | undefined;
    if (parsedTerminal && typeof parsedTerminal === 'object' && 'scrollbackLines' in parsedTerminal) {
      delete (this.config.terminal as unknown as Record<string, unknown>).scrollbackLines;
      this.save(this.config);
    }

    // One-time migration: adopt the `focused` light-dismiss default. Changing
    // DEFAULT_CONFIG alone reaches fresh installs only, because save() writes the
    // whole blob and load() lets a persisted value beat the default - so every
    // install that ran under the old `single` default keeps it. That matters
    // rather than being cosmetic: `single` resolves to no target once a second
    // window is open, so click-outside close silently stops working there.
    //
    // A persisted `single` is indistinguishable from a deliberate choice, so this
    // knowingly overrides one made before the flip shipped. The marker bounds it
    // to a single rewrite, so re-picking `single` afterwards sticks. It runs on a
    // fresh install too (a no-op on an already-`focused` value) rather than being
    // gated on `parsed`, so the marker is persisted on the first launch instead of
    // being re-evaluated on every one until some unrelated save happens to land.
    if (!this.config.hasMigratedWindowLightDismissDefault) {
      this.config.hasMigratedWindowLightDismissDefault = true;
      if (this.config.windowLightDismiss === 'single') {
        this.config.windowLightDismiss = 'focused';
      }
      // The one exception to running unconditionally: an existing file we failed to
      // parse. Every migration above this one is `parsed`-gated, so before this block
      // an unparseable config was left on disk untouched and the session merely ran on
      // defaults. Saving here would replace it with bare defaults at launch and destroy
      // whatever was hand-recoverable in it. Deferring costs nothing - the marker is
      // still false next launch and the rewrite is idempotent.
      if (!configFileUnreadable) {
        this.save(this.config);
      }
    }

    // One-time purge: clear `discoveredModelsByAgent`. `loadAgentList` used to seed
    // that cache from each adapter's `capabilities.models` with a union that only
    // ever grew, so any model an adapter ever reported became permanent - including
    // the eight-entry hardcoded Cursor fallback list this release deletes. A seeded
    // entry is byte-identical to a learned one, so there is nothing to filter on and
    // the whole map goes. Genuinely learned models are re-learned the next time one
    // runs (`rememberDiscoveredModel`, from live status telemetry); offering models
    // the CLI no longer serves is the bug being fixed, so that trade is the point.
    //
    // This must run in MAIN, before the renderer's first read: the renderer's writers
    // spread the current value (`{ ...current, [agent]: next }`), so a renderer holding
    // a pre-purge config would write the stale map straight back. Same
    // unreadable-file deferral as the migration above, for the same reason.
    //
    // The clear must stay a mutation of `this.config` followed by saving that WHOLE
    // object. `discoveredModelsByAgent` is not in `CONFIG_DICTIONARY_PATHS`, so it gets
    // merge semantics, and `save({ discoveredModelsByAgent: {} })` would merge an empty
    // map into the populated one and purge nothing. It works here only because `current`
    // and `partial` are the same already-emptied object.
    if (!this.config.hasPurgedSeededDiscoveredModels) {
      this.config.hasPurgedSeededDiscoveredModels = true;
      this.config.discoveredModelsByAgent = {};
      if (!configFileUnreadable) {
        this.save(this.config);
      }
    }

    return this.config;
  }

  /**
   * Merges `partial` into the in-memory config and persists it. Returns whether
   * the write actually reached disk - `false` on a write failure (already
   * reported through `write-failure-notice.ts`), which callers may check, but
   * the in-memory config is updated regardless: a settings write failing must
   * not roll back a value the user just changed for THIS session, only fail to
   * carry it to the next one. DESKTOP-14/DESKTOP-13 were this method throwing
   * out of a timer (uncaught exception) and out of the `config:set` IPC handler
   * (unhandled rejection, never caught) when the data directory went unwritable.
   */
  save(partial: Partial<AppConfig>): boolean {
    const current = this.load();
    // Use merge semantics so partial updates to typed structs (e.g. contextBar)
    // preserve unmentioned keys. Dictionary paths (Record<string, ...>) still
    // replace wholesale so deletion of map entries works.
    this.config = deepMerge(current, partial, {
      replaceFlatMaps: false,
      dictionaryPaths: CONFIG_DICTIONARY_PATHS,
    });
    return safeWriteJson(PATHS.configFile, this.config, 'config');
  }

  loadProjectOverrides(projectPath: string): Partial<AppConfig> | null {
    const configPath = path.join(projectPath, '.kangentic', 'config.json');
    let overrides: Record<string, unknown> | null;
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      overrides = JSON.parse(raw);
    } catch {
      return null;
    }
    if (!overrides) return null;

    // One-time migration: claude.* -> agent.* in project overrides
    if ('claude' in overrides && !('agent' in overrides)) {
      const legacy = overrides.claude as Record<string, unknown>;
      overrides.agent = { ...legacy };
      delete (overrides.agent as Record<string, unknown>).cliPath;
      delete overrides.claude;
      this.saveProjectOverrides(projectPath, overrides as Partial<AppConfig>);
    }

    // One-time migration: terminal.{shell,fontFamily,fontSize,scrollbackLines,
    // cursorStyle,backspaceSendsCtrlH} moved from project-overridable to
    // global-only (see the doc comments on AppConfig['terminal'] in
    // shared/types.ts). Any value a project already had is dropped rather
    // than promoted to global - a user with several projects holding
    // different values would otherwise have one arbitrarily "win" depending
    // on load order. Global terminal settings simply start from
    // DEFAULT_CONFIG (or whatever the user later sets).
    const legacyTerminal = overrides.terminal as Record<string, unknown> | undefined;
    if (legacyTerminal) {
      const droppedKeys = ['shell', 'fontFamily', 'fontSize', 'scrollbackLines', 'cursorStyle', 'backspaceSendsCtrlH'] as const;
      const hadDroppedKey = droppedKeys.some((key) => key in legacyTerminal);
      if (hadDroppedKey) {
        for (const key of droppedKeys) delete legacyTerminal[key];
        if (Object.keys(legacyTerminal).length === 0) {
          delete overrides.terminal;
        }
        this.saveProjectOverrides(projectPath, overrides as Partial<AppConfig>);
      }
    }

    // One-time migration: the product pair's retired ids -> clay / rust.
    if (renameRetiredThemeIds(overrides)) {
      this.saveProjectOverrides(projectPath, overrides as Partial<AppConfig>);
    }

    return overrides as Partial<AppConfig>;
  }

  /** Same non-throwing contract as `save()`, for the per-project `.kangentic/config.json`.
   *  Returns whether the write reached disk. */
  saveProjectOverrides(projectPath: string, overrides: Partial<AppConfig>): boolean {
    const configPath = path.join(projectPath, '.kangentic', 'config.json');
    return safeWriteJson(configPath, overrides, 'config_project_override');
  }

  /** Extract the project-overridable subset of the current global config.
   *  Used to snapshot defaults when a new project is created so that
   *  future global changes don't retroactively alter existing projects.
   *  Shares its key set with getLastProjectOverrides via pickOverridableSubset.
   *  KEEP IN SYNC with snapshotOverridableDefaults() in tests/ui/mock-electron-api.js */
  getProjectOverridableDefaults(): Partial<AppConfig> {
    return pickOverridableSubset(this.load());
  }

  getEffectiveConfig(projectPath?: string): AppConfig {
    const global = this.load();
    if (!projectPath) return global;

    const overrides = this.loadProjectOverrides(projectPath);
    if (!overrides) return global;

    return deepMergeConfig(global, overrides);
  }
}

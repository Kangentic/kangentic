import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ensureDirs } from './paths';
import type { AppConfig, DeepPartial, PermissionMode } from '../../shared/types';
import { DEFAULT_CONFIG } from '../../shared/types';
import { deepMerge, deepMergeConfig } from '../../shared/object-utils';

/** Dotted paths in AppConfig that must be REPLACED wholesale on a partial update
 *  (not deep-merged), so key/window deletion and a full-blob reset both work. This
 *  covers true `Record<string, ...>` dictionaries (where merge would leak deleted
 *  keys) AND renderer-authoritative layout blobs (`commandTerminalWorkspace`) the
 *  renderer always writes in full. Every other typed-struct field gets MERGE
 *  semantics. Update this list when adding such a field to AppConfig. */
const CONFIG_DICTIONARY_PATHS = [
  'backlog.labelColors',
  'agent.cliPaths',
  'hotkeyOverrides',
  'workspaceByProject',
  'commandTerminalWorkspace',
  'popOutBounds',
] as const;

/** Drop keys whose value is undefined. Returns undefined when nothing is left,
 *  so callers can skip writing empty nested objects. */
function pruneUndefined(obj: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(obj).filter(([, value]) => value !== undefined);
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
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

  const terminal = pruneUndefined({
    shell: source.terminal?.shell,
    fontSize: source.terminal?.fontSize,
    fontFamily: source.terminal?.fontFamily,
    scrollbackLines: source.terminal?.scrollbackLines,
    cursorStyle: source.terminal?.cursorStyle,
  });
  if (terminal) result.terminal = terminal;

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
  });
  if (git) result.git = git;

  return result as Partial<AppConfig>;
}

export class ConfigManager {
  private config: AppConfig | null = null;

  load(): AppConfig {
    if (this.config) return this.config;

    ensureDirs();
    let parsed: Record<string, unknown> | null = null;
    try {
      const raw = fs.readFileSync(PATHS.configFile, 'utf-8');
      parsed = JSON.parse(raw);
      this.config = deepMergeConfig(DEFAULT_CONFIG, parsed as Partial<AppConfig>);
    } catch {
      this.config = { ...DEFAULT_CONFIG };
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

    // One-time migration: notifyIdleOnInactiveProject -> notifications.desktop.onAgentIdle
    if (parsed && 'notifyIdleOnInactiveProject' in parsed) {
      this.config.notifications.desktop.onAgentIdle = Boolean(parsed.notifyIdleOnInactiveProject);
      delete (this.config as unknown as Record<string, unknown>).notifyIdleOnInactiveProject;
      this.save(this.config);
    }

    return this.config;
  }

  save(partial: Partial<AppConfig>): void {
    const current = this.load();
    // Use merge semantics so partial updates to typed structs (e.g. contextBar)
    // preserve unmentioned keys. Dictionary paths (Record<string, ...>) still
    // replace wholesale so deletion of map entries works.
    this.config = deepMerge(current, partial, {
      replaceFlatMaps: false,
      dictionaryPaths: CONFIG_DICTIONARY_PATHS,
    });
    ensureDirs();
    fs.writeFileSync(PATHS.configFile, JSON.stringify(this.config, null, 2));
  }

  loadProjectOverrides(projectPath: string): Partial<AppConfig> | null {
    const configPath = path.join(projectPath, '.kangentic', 'config.json');
    let overrides: Record<string, unknown> | null = null;
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

    return overrides as Partial<AppConfig>;
  }

  saveProjectOverrides(projectPath: string, overrides: Partial<AppConfig>): void {
    const dir = path.join(projectPath, '.kangentic');
    fs.mkdirSync(dir, { recursive: true });
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(overrides, null, 2));
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

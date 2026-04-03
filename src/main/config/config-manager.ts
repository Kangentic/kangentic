import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ensureDirs } from './paths';
import type { AppConfig, PermissionMode } from '../../shared/types';
import { DEFAULT_CONFIG } from '../../shared/types';
import { deepMerge, deepMergeConfig } from '../../shared/object-utils';

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

    // One-time migration: claude.* namespace -> agent.* (cliPath -> cliPaths)
    if (parsed && 'claude' in parsed && !('agent' in parsed)) {
      const legacy = parsed.claude as Record<string, unknown>;
      const cliPath = legacy.cliPath;
      this.config.agent = {
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
    this.config = deepMerge(current, partial);
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
   *  KEEP IN SYNC with snapshotOverridableDefaults() in tests/ui/mock-electron-api.js */
  getProjectOverridableDefaults(): Partial<AppConfig> {
    const global = this.load();
    return {
      theme: global.theme,
      terminal: {
        shell: global.terminal.shell,
        fontSize: global.terminal.fontSize,
        fontFamily: global.terminal.fontFamily,
        scrollbackLines: global.terminal.scrollbackLines,
        cursorStyle: global.terminal.cursorStyle,
      },
      agent: {
        permissionMode: global.agent.permissionMode,
      },
      git: {
        worktreesEnabled: global.git.worktreesEnabled,
        autoCleanup: global.git.autoCleanup,
        defaultBaseBranch: global.git.defaultBaseBranch,
        copyFiles: global.git.copyFiles,
        initScript: global.git.initScript,
      },
    } as Partial<AppConfig>;
  }

  getEffectiveConfig(projectPath?: string): AppConfig {
    const global = this.load();
    if (!projectPath) return global;

    const overrides = this.loadProjectOverrides(projectPath);
    if (!overrides) return global;

    return deepMergeConfig(global, overrides);
  }
}

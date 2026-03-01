import fs from 'node:fs';
import path from 'node:path';
import { PATHS, ensureDirs } from './paths';
import type { AppConfig } from '../../shared/types';
import { DEFAULT_CONFIG } from '../../shared/types';

export class ConfigManager {
  private config: AppConfig | null = null;

  load(): AppConfig {
    if (this.config) return this.config;

    ensureDirs();
    try {
      const raw = fs.readFileSync(PATHS.configFile, 'utf-8');
      const parsed = JSON.parse(raw);
      this.config = this.merge(DEFAULT_CONFIG, parsed);
    } catch {
      this.config = { ...DEFAULT_CONFIG };
    }

    // One-time migration: legacy permission mode values → new names
    const pm = this.config.claude.permissionMode as string;
    if (pm === 'dangerously-skip' || pm === 'project-settings') {
      this.config.claude.permissionMode = pm === 'dangerously-skip' ? 'bypass-permissions' : 'default';
      this.save(this.config);
    }

    return this.config;
  }

  save(partial: Partial<AppConfig>): void {
    const current = this.load();
    this.config = this.merge(current, partial);
    ensureDirs();
    fs.writeFileSync(PATHS.configFile, JSON.stringify(this.config, null, 2));
  }

  loadProjectOverrides(projectPath: string): Partial<AppConfig> | null {
    const configPath = path.join(projectPath, '.kangentic', 'config.json');
    try {
      const raw = fs.readFileSync(configPath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  saveProjectOverrides(projectPath: string, overrides: Partial<AppConfig>): void {
    const dir = path.join(projectPath, '.kangentic');
    fs.mkdirSync(dir, { recursive: true });
    const configPath = path.join(dir, 'config.json');
    fs.writeFileSync(configPath, JSON.stringify(overrides, null, 2));
  }

  getEffectiveConfig(projectPath?: string): AppConfig {
    const global = this.load();
    if (!projectPath) return global;

    const overrides = this.loadProjectOverrides(projectPath);
    if (!overrides) return global;

    return this.merge(global, overrides);
  }

  private merge<T extends Record<string, any>>(base: T, overrides: Partial<T>): T {
    const result = { ...base };
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined && value !== null) {
        if (typeof value === 'object' && !Array.isArray(value) && typeof (result as any)[key] === 'object') {
          (result as any)[key] = this.merge((result as any)[key], value);
        } else {
          (result as any)[key] = value;
        }
      }
    }
    return result;
  }
}

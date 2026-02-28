/**
 * Unit tests for config-manager migrations.
 *
 * Uses KANGENTIC_DATA_DIR to isolate config files in a temp directory.
 * Each test gets a fresh ConfigManager instance (cache is per-instance).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tmpDir: string;
let configPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kgnt-config-'));
  fs.mkdirSync(path.join(tmpDir, 'projects'), { recursive: true });
  configPath = path.join(tmpDir, 'config.json');
  process.env.KANGENTIC_DATA_DIR = tmpDir;
});

afterEach(() => {
  delete process.env.KANGENTIC_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Create a fresh ConfigManager instance. Must be called AFTER setting
 * KANGENTIC_DATA_DIR so the paths module picks up the override.
 * Uses dynamic import to bypass module caching of the paths singleton.
 */
async function createConfigManager() {
  // The PATHS singleton caches configDir at module load time. We need to
  // re-evaluate it with the new env var. Use a workaround: write to the
  // path that PATHS resolves to (which is tmpDir via KANGENTIC_DATA_DIR).
  const { ConfigManager } = await import('../../src/main/config/config-manager');
  return new ConfigManager();
}

describe('Config Manager Migrations', () => {
  it('migrates claude.permissionMode → claude.permissionStrategy', async () => {
    fs.writeFileSync(configPath, JSON.stringify({
      claude: {
        permissionMode: 'project-settings',
        cliPath: null,
        maxConcurrentSessions: 8,
        queueOverflow: 'queue',
      },
    }));

    const cm = await createConfigManager();
    const config = cm.load();

    expect(config.claude.permissionStrategy).toBe('project-settings');
    expect((config.claude as Record<string, unknown>).permissionMode).toBeUndefined();

    // Verify it was persisted
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(raw.claude.permissionStrategy).toBe('project-settings');
    expect(raw.claude.permissionMode).toBeUndefined();
  });

  it('migrates manual → project-settings', async () => {
    fs.writeFileSync(configPath, JSON.stringify({
      claude: {
        permissionStrategy: 'manual',
        cliPath: null,
        maxConcurrentSessions: 8,
        queueOverflow: 'queue',
      },
    }));

    const cm = await createConfigManager();
    const config = cm.load();

    expect(config.claude.permissionStrategy).toBe('project-settings');
  });

  it('migrates dangerously-skip → project-settings', async () => {
    fs.writeFileSync(configPath, JSON.stringify({
      claude: {
        permissionStrategy: 'dangerously-skip',
        cliPath: null,
        maxConcurrentSessions: 8,
        queueOverflow: 'queue',
      },
    }));

    const cm = await createConfigManager();
    const config = cm.load();

    expect(config.claude.permissionStrategy).toBe('project-settings');
  });

  it('preserves project-settings without migration', async () => {
    fs.writeFileSync(configPath, JSON.stringify({
      claude: {
        permissionStrategy: 'project-settings',
        cliPath: null,
        maxConcurrentSessions: 4,
        queueOverflow: 'reject',
      },
    }));

    const cm = await createConfigManager();
    const config = cm.load();

    expect(config.claude.permissionStrategy).toBe('project-settings');
    expect(config.claude.maxConcurrentSessions).toBe(4);
    expect(config.claude.queueOverflow).toBe('reject');
  });

  it('handles both migrations: old permissionMode field with manual value', async () => {
    fs.writeFileSync(configPath, JSON.stringify({
      claude: {
        permissionMode: 'manual',
        cliPath: null,
        maxConcurrentSessions: 8,
        queueOverflow: 'queue',
      },
    }));

    const cm = await createConfigManager();
    const config = cm.load();

    // First migration renames to permissionStrategy: 'manual'
    // Second migration converts 'manual' → 'project-settings'
    expect(config.claude.permissionStrategy).toBe('project-settings');
    expect((config.claude as Record<string, unknown>).permissionMode).toBeUndefined();
  });
});

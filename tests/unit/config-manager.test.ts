/**
 * Unit tests for ConfigManager migrations.
 *
 * Uses KANGENTIC_DATA_DIR to isolate config files in a temp directory.
 * Each test gets a fresh ConfigManager via vi.resetModules() + dynamic import
 * (the PATHS singleton caches configDir at module load time).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

let tmpDir: string;
let configPath: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-config-'));
  fs.mkdirSync(path.join(tmpDir, 'projects'), { recursive: true });
  configPath = path.join(tmpDir, 'config.json');
  process.env.KANGENTIC_DATA_DIR = tmpDir;
  vi.resetModules();
});

afterEach(() => {
  delete process.env.KANGENTIC_DATA_DIR;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Create a fresh ConfigManager (resets module cache so PATHS picks up new env). */
async function createConfigManager() {
  const { ConfigManager } = await import('../../src/main/config/config-manager');
  return new ConfigManager();
}

describe('Config Manager -- Permission Mode Migration', () => {
  it("migrates 'dangerously-skip' to 'bypassPermissions'", async () => {
    fs.writeFileSync(configPath, JSON.stringify({
      agent: { permissionMode: 'dangerously-skip' },
    }));

    const cm = await createConfigManager();
    const config = cm.load();

    expect(config.agent.permissionMode).toBe('bypassPermissions');

    // Verify persisted to disk
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(raw.agent.permissionMode).toBe('bypassPermissions');
  });

  it("migrates 'project-settings' to 'acceptEdits'", async () => {
    fs.writeFileSync(configPath, JSON.stringify({
      agent: { permissionMode: 'project-settings' },
    }));

    const cm = await createConfigManager();
    const config = cm.load();

    expect(config.agent.permissionMode).toBe('acceptEdits');

    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(raw.agent.permissionMode).toBe('acceptEdits');
  });

  it("preserves 'default' without re-migration", async () => {
    fs.writeFileSync(configPath, JSON.stringify({
      agent: { permissionMode: 'default', maxConcurrentSessions: 4 },
    }));

    const cm = await createConfigManager();
    const config = cm.load();

    expect(config.agent.permissionMode).toBe('default');
    expect(config.agent.maxConcurrentSessions).toBe(4);
  });

  it("migrates 'bypass-permissions' to 'bypassPermissions'", async () => {
    fs.writeFileSync(configPath, JSON.stringify({
      agent: { permissionMode: 'bypass-permissions' },
    }));

    const cm = await createConfigManager();
    const config = cm.load();

    expect(config.agent.permissionMode).toBe('bypassPermissions');

    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(raw.agent.permissionMode).toBe('bypassPermissions');
  });

  it("migrates 'manual' to 'acceptEdits'", async () => {
    fs.writeFileSync(configPath, JSON.stringify({
      agent: { permissionMode: 'manual' },
    }));

    const cm = await createConfigManager();
    const config = cm.load();

    expect(config.agent.permissionMode).toBe('acceptEdits');

    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(raw.agent.permissionMode).toBe('acceptEdits');
  });

  it("preserves valid modes: plan, acceptEdits, dontAsk, bypassPermissions", async () => {
    for (const mode of ['plan', 'acceptEdits', 'dontAsk', 'bypassPermissions'] as const) {
      // Reset modules for each sub-case so PATHS re-reads env
      vi.resetModules();
      fs.writeFileSync(configPath, JSON.stringify({
        agent: { permissionMode: mode },
      }));

      const { ConfigManager } = await import('../../src/main/config/config-manager');
      const cm = new ConfigManager();
      const config = cm.load();

      expect(config.agent.permissionMode).toBe(mode);
    }
  });

  it("fresh config (no file) defaults to 'acceptEdits'", async () => {
    // No config file written -- should fall back to DEFAULT_CONFIG
    const cm = await createConfigManager();
    const config = cm.load();

    expect(config.agent.permissionMode).toBe('acceptEdits');
  });
});

describe('Config Manager -- claude.* to agent.* namespace migration', () => {
  it('migrates legacy claude.* to agent.* on load', async () => {
    fs.writeFileSync(configPath, JSON.stringify({
      claude: {
        permissionMode: 'default',
        cliPath: '/usr/bin/claude',
        maxConcurrentSessions: 4,
        queueOverflow: 'reject',
        idleTimeoutMinutes: 5,
      },
    }));

    const cm = await createConfigManager();
    const config = cm.load();

    expect(config.agent.permissionMode).toBe('default');
    expect(config.agent.cliPaths).toEqual({ claude: '/usr/bin/claude' });
    expect(config.agent.maxConcurrentSessions).toBe(4);
    expect(config.agent.queueOverflow).toBe('reject');
    expect(config.agent.idleTimeoutMinutes).toBe(5);

    // Verify claude key is gone from persisted file
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(raw.claude).toBeUndefined();
    expect(raw.agent).toBeDefined();
    expect(raw.agent.cliPaths).toEqual({ claude: '/usr/bin/claude' });
  });

  it('migrates claude.cliPath null to empty cliPaths', async () => {
    fs.writeFileSync(configPath, JSON.stringify({
      claude: { cliPath: null, permissionMode: 'default' },
    }));

    const cm = await createConfigManager();
    const config = cm.load();

    expect(config.agent.cliPaths).toEqual({});
  });

  it('applies both namespace and permission mode migrations', async () => {
    fs.writeFileSync(configPath, JSON.stringify({
      claude: { permissionMode: 'dangerously-skip', cliPath: '/usr/bin/claude' },
    }));

    const cm = await createConfigManager();
    const config = cm.load();

    // Namespace migration runs first, then permission mode migration
    expect(config.agent.permissionMode).toBe('bypassPermissions');
    expect(config.agent.cliPaths).toEqual({ claude: '/usr/bin/claude' });
  });

  it('does not re-migrate when agent key already exists', async () => {
    fs.writeFileSync(configPath, JSON.stringify({
      agent: { permissionMode: 'default', cliPaths: { gemini: '/usr/bin/gemini' }, maxConcurrentSessions: 4, queueOverflow: 'queue', idleTimeoutMinutes: 0 },
    }));

    const cm = await createConfigManager();
    const config = cm.load();

    expect(config.agent.cliPaths).toEqual({ gemini: '/usr/bin/gemini' });
    expect(config.agent.maxConcurrentSessions).toBe(4);
  });
});

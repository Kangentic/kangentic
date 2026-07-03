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
import { DEFAULT_CONFIG } from '../../src/shared/types';

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

describe('Config Manager -- terminalBlockCopy default', () => {
  // The block-copy affordance ships OFF by default (it was flipped from an
  // earlier opt-out default). Pin the literal so a revert to `true` fails here
  // rather than only surfacing through the UI spec's explicit opt-in override.
  it('DEFAULT_CONFIG.terminalBlockCopy is false', () => {
    expect(DEFAULT_CONFIG.terminalBlockCopy).toBe(false);
  });

  it('a fresh config (no file on disk) resolves terminalBlockCopy to false', async () => {
    const cm = await createConfigManager();
    const config = cm.load();

    expect(config.terminalBlockCopy).toBe(false);
  });
});

describe('Config Manager -- commandTerminalWorkspace replace semantics', () => {
  it('set({ commandTerminalWorkspace: null }) REPLACES the previous blob, not deep-merges it', async () => {
    // A realistic minimal serialized-workspace blob (shape mirrors SerializedWorkspace).
    const initialWorkspace = {
      version: 1,
      windows: [
        {
          taskId: 'slot-1',
          title: 'Command Terminal',
          geometry: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
          restoreGeometry: null,
          state: 'floating',
        },
      ],
      tileTree: null,
      tileTreeRect: { x: 0, y: 0, w: 1, h: 1 },
      focusedTaskId: 'slot-1',
    };

    const cm = await createConfigManager();
    // Write the initial non-null blob.
    cm.save({ commandTerminalWorkspace: initialWorkspace as Parameters<typeof cm.save>[0]['commandTerminalWorkspace'] });
    const afterFirstWrite = cm.load();
    expect(afterFirstWrite.commandTerminalWorkspace).not.toBeNull();
    expect(afterFirstWrite.commandTerminalWorkspace?.windows).toHaveLength(1);

    // Now null it out. With deep-merge semantics (no replace), a null-overlay would be
    // merged INTO the object, leaving the prior blob intact. With replace semantics the
    // field is set to null wholesale.
    cm.save({ commandTerminalWorkspace: null });
    const afterNullWrite = cm.load();
    expect(afterNullWrite.commandTerminalWorkspace).toBeNull();

    // Verify the on-disk file also reflects null, not the previous blob.
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(raw.commandTerminalWorkspace).toBeNull();
  });

  it('writing a new commandTerminalWorkspace blob REPLACES stale sub-fields rather than merging them in', async () => {
    // Write a blob that has an EXTRA sub-key not present in the second write.
    // With deep-merge semantics (no replace), the stale key leaks into the merged
    // result. With replace semantics the whole blob is swapped out and only the new
    // keys survive.
    const firstBlob = {
      version: 1,
      windows: [],
      tileTree: null,
      tileTreeRect: { x: 0, y: 0, w: 1, h: 1 },
      focusedTaskId: 'slot-old',
      // Extra key not in SerializedWorkspace - simulates a field that will be absent
      // from the next write.
      _staleKey: 'should-be-gone',
    };
    const secondBlob = {
      version: 1,
      windows: [],
      tileTree: null,
      tileTreeRect: { x: 0, y: 0, w: 1, h: 1 },
      focusedTaskId: 'slot-new',
      // _staleKey intentionally absent - in merge semantics it would survive from
      // the first blob; in replace semantics it is gone.
    };

    const cm = await createConfigManager();
    // Use a cast to bypass TypeScript's strict-shape check for the test-extra key.
    cm.save({ commandTerminalWorkspace: firstBlob as Parameters<typeof cm.save>[0]['commandTerminalWorkspace'] });
    cm.save({ commandTerminalWorkspace: secondBlob as Parameters<typeof cm.save>[0]['commandTerminalWorkspace'] });

    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    // Replace semantics: the stale key from the first blob must not survive.
    expect(raw.commandTerminalWorkspace._staleKey).toBeUndefined();
    // The new focusedTaskId must reflect the second write.
    expect(raw.commandTerminalWorkspace.focusedTaskId).toBe('slot-new');
  });
});

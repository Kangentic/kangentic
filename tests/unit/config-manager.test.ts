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

describe('Config Manager -- mobileBridge relay resolution across the default merge', () => {
  // Regression: DEFAULT_CONFIG.mobileBridge used to seed relayMode: 'hosted'.
  // mobileBridge is not a CONFIG_DICTIONARY_PATHS entry, so load() merges it
  // key-by-key with the parsed file rather than replacing it wholesale - which
  // meant that seeded 'hosted' filled in over a config written before
  // relayMode existed, defeating resolveRelayUrl's "relayMode missing but
  // relayUrl set => custom" inference and silently moving every upgrading
  // self-hoster onto the Kangentic-hosted relay.
  //
  // These assert through ConfigManager.load() on purpose. tests/unit/relay-url.test.ts
  // covers the same inference, but it hand-builds the mobileBridge object and so
  // never sees the default merge - it stayed green while the shipped path was broken.

  it('keeps dialing a pre-relayMode custom relay after the default merge', async () => {
    fs.writeFileSync(configPath, JSON.stringify({
      mobileBridge: { enabled: true, relayUrl: 'wss://self-hosted.example.com' },
    }));

    const cm = await createConfigManager();
    const config = cm.load();
    const { resolveRelayUrl } = await import('../../src/shared/relay');

    expect(config.mobileBridge?.relayMode).toBeUndefined();
    expect(resolveRelayUrl(config.mobileBridge)).toBe('wss://self-hosted.example.com/');
  });

  it('resolves to the hosted relay for a fresh config with no relay settings', async () => {
    const cm = await createConfigManager();
    const config = cm.load();
    const { KANGENTIC_HOSTED_RELAY_URL, resolveRelayUrl } = await import('../../src/shared/relay');

    expect(resolveRelayUrl(config.mobileBridge)).toBe(KANGENTIC_HOSTED_RELAY_URL);
  });

  it('honors an explicit hosted choice even when a stale relayUrl is still on disk', async () => {
    fs.writeFileSync(configPath, JSON.stringify({
      mobileBridge: { enabled: true, relayMode: 'hosted', relayUrl: 'wss://self-hosted.example.com' },
    }));

    const cm = await createConfigManager();
    const config = cm.load();
    const { KANGENTIC_HOSTED_RELAY_URL, resolveRelayUrl } = await import('../../src/shared/relay');

    expect(resolveRelayUrl(config.mobileBridge)).toBe(KANGENTIC_HOSTED_RELAY_URL);
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

describe('Config Manager -- terminal.* project-override migration', () => {
  // terminal.{shell,fontFamily,fontSize,scrollbackLines,cursorStyle} moved from
  // project-overridable to global-only (see AppConfig['terminal'] doc comments
  // in shared/types.ts). loadProjectOverrides() must strip any of these a
  // project already has on disk rather than silently keep applying them with
  // no UI left to see or clear them.
  function projectOverridesPath(projectDir: string): string {
    return path.join(projectDir, '.kangentic', 'config.json');
  }

  function writeProjectOverrides(projectDir: string, overrides: Record<string, unknown>): void {
    fs.mkdirSync(path.join(projectDir, '.kangentic'), { recursive: true });
    fs.writeFileSync(projectOverridesPath(projectDir), JSON.stringify(overrides));
  }

  it('strips the migrated keys but keeps other terminal.* and non-terminal settings', async () => {
    const projectDir = path.join(tmpDir, 'proj-a');
    writeProjectOverrides(projectDir, {
      theme: 'forest',
      terminal: { shell: 'pwsh.exe', fontSize: 16, colors: { background: '#111' } },
      git: { worktreesEnabled: true },
    });

    const cm = await createConfigManager();
    const overrides = cm.loadProjectOverrides(projectDir);

    expect(overrides?.theme).toBe('forest');
    expect(overrides?.git).toEqual({ worktreesEnabled: true });
    expect(overrides?.terminal).toEqual({ colors: { background: '#111' } });

    const raw = JSON.parse(fs.readFileSync(projectOverridesPath(projectDir), 'utf-8'));
    expect(raw.terminal).toEqual({ colors: { background: '#111' } });
  });

  it('deletes the terminal key entirely when nothing survives the strip', async () => {
    const projectDir = path.join(tmpDir, 'proj-b');
    writeProjectOverrides(projectDir, {
      theme: 'ember',
      terminal: { shell: 'bash', fontFamily: 'Consolas', scrollbackLines: 2000, cursorStyle: 'bar' },
    });

    const cm = await createConfigManager();
    const overrides = cm.loadProjectOverrides(projectDir);

    expect(overrides).not.toHaveProperty('terminal');

    const raw = JSON.parse(fs.readFileSync(projectOverridesPath(projectDir), 'utf-8'));
    expect(raw).not.toHaveProperty('terminal');
  });

  it('does not rewrite the file when there is nothing to migrate', async () => {
    const projectDir = path.join(tmpDir, 'proj-c');
    writeProjectOverrides(projectDir, { theme: 'sky', terminal: { colors: { background: '#222' } } });
    const before = fs.statSync(projectOverridesPath(projectDir)).mtimeMs;

    const cm = await createConfigManager();
    cm.loadProjectOverrides(projectDir);

    const after = fs.statSync(projectOverridesPath(projectDir)).mtimeMs;
    expect(after).toBe(before);
  });

  it('does not re-migrate on a second load (idempotent)', async () => {
    const projectDir = path.join(tmpDir, 'proj-d');
    writeProjectOverrides(projectDir, { terminal: { shell: 'zsh' } });

    const cm = await createConfigManager();
    cm.loadProjectOverrides(projectDir);
    const overrides = cm.loadProjectOverrides(projectDir);

    expect(overrides).not.toHaveProperty('terminal');
  });

  it('strips a legacy terminal.backspaceSendsCtrlH override in isolation, keeping its sibling terminal.* key', async () => {
    // backspaceSendsCtrlH joined the other 5 legacy keys (shell/fontFamily/
    // fontSize/scrollbackLines/cursorStyle) as global-only in this same
    // change (it was merged in from an upstream PR as project-scoped and
    // rescoped during conflict resolution). Isolate it from its siblings so
    // this test only goes red if backspaceSendsCtrlH specifically falls out
    // of the migration's droppedKeys list, not if some other key does.
    const projectDir = path.join(tmpDir, 'proj-e');
    writeProjectOverrides(projectDir, {
      terminal: { backspaceSendsCtrlH: false, colors: { background: '#333' } },
    });

    const cm = await createConfigManager();
    const overrides = cm.loadProjectOverrides(projectDir);

    expect(overrides?.terminal).toEqual({ colors: { background: '#333' } });

    const raw = JSON.parse(fs.readFileSync(projectOverridesPath(projectDir), 'utf-8'));
    expect(raw.terminal).toEqual({ colors: { background: '#333' } });
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

describe('Config Manager -- agent.launchOptions replace semantics', () => {
  // Coverage hole: 'agent.launchOptions' is a CONFIG_DICTIONARY_PATHS entry
  // (config-manager.ts), which makes save() REPLACE the whole two-level
  // agent-name -> option-id -> enabled map wholesale instead of deep-merging
  // it, so deleting a previously-stored agent's entry actually works. No prior
  // test in this file (or deep-merge.test.ts, which only exercises the
  // generic deepMerge mechanism with a hand-supplied dictionaryPaths list
  // decoupled from this constant) drives a save() call through this specific
  // entry, so removing 'agent.launchOptions' from CONFIG_DICTIONARY_PATHS
  // currently goes undetected.
  it('save({ agent: { launchOptions } }) REPLACES the previous two-level map, not deep-merges it', async () => {
    const cm = await createConfigManager();

    // First write: two agents both carry a launchOptions entry, plus a
    // sibling agent.* field (cliPaths) that must survive the second write.
    cm.save({
      agent: {
        cliPaths: { claude: '/usr/bin/claude' },
        launchOptions: {
          claude: { foo: true },
          codex: { disableApps: false },
        },
      } as Parameters<typeof cm.save>[0]['agent'],
    });
    const afterFirstWrite = cm.load();
    expect(afterFirstWrite.agent.launchOptions).toEqual({
      claude: { foo: true },
      codex: { disableApps: false },
    });

    // Second write: only codex.disableApps is mentioned. With deep-merge
    // semantics the prior 'claude' entry would survive; with replace
    // semantics the whole map is swapped out and 'claude' is gone.
    cm.save({
      agent: {
        launchOptions: {
          codex: { disableApps: true },
        },
      } as Parameters<typeof cm.save>[0]['agent'],
    });
    const afterSecondWrite = cm.load();

    // Red: commenting out 'agent.launchOptions' in CONFIG_DICTIONARY_PATHS
    // (config-manager.ts) makes this deep-merge instead, so the 'claude'
    // entry from the first write survives and this fails.
    expect(afterSecondWrite.agent.launchOptions).toEqual({ codex: { disableApps: true } });
    expect('claude' in afterSecondWrite.agent.launchOptions).toBe(false);

    // Sibling agent.* fields (untouched by the second, launchOptions-only
    // save) must survive: cliPaths from the first write, permissionMode from
    // DEFAULT_CONFIG.
    expect(afterSecondWrite.agent.cliPaths).toEqual({ claude: '/usr/bin/claude' });
    expect(afterSecondWrite.agent.permissionMode).toBe('acceptEdits');

    // Verify the on-disk file also reflects replace semantics, not the
    // previous map.
    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(raw.agent.launchOptions).toEqual({ codex: { disableApps: true } });
    expect('claude' in raw.agent.launchOptions).toBe(false);
  });
});

describe('Config Manager -- terminal.scrollbackLines global migration', () => {
  // The scrollbackLines setting was removed; the live xterm scrollback cap
  // is now a fixed internal constant (TERMINAL_SCROLLBACK_LINES in
  // useTerminal.ts). load() must one-time-strip a stale global
  // terminal.scrollbackLines left over from before the removal.

  it('strips scrollbackLines from the loaded config and rewrites the file, keeping sibling terminal.* keys', async () => {
    fs.writeFileSync(configPath, JSON.stringify({
      terminal: { scrollbackLines: 5000, cursorStyle: 'underline' },
    }));

    const cm = await createConfigManager();
    const config = cm.load();

    expect(config.terminal).not.toHaveProperty('scrollbackLines');
    expect(config.terminal.cursorStyle).toBe('underline');

    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(raw.terminal).not.toHaveProperty('scrollbackLines');
    expect(raw.terminal.cursorStyle).toBe('underline');
  });

  it('does not re-migrate on a second load of the already-clean file', async () => {
    fs.writeFileSync(configPath, JSON.stringify({
      terminal: { scrollbackLines: 3000, cursorStyle: 'block' },
    }));

    const cm = await createConfigManager();
    cm.load();
    const config = cm.load();

    expect(config.terminal).not.toHaveProperty('scrollbackLines');
    expect(config.terminal.cursorStyle).toBe('block');
  });
});

describe('Config Manager -- terminal.colors replace semantics', () => {
  it('removing a slot key from a later save() actually clears it, not deep-merges it back', async () => {
    const cm = await createConfigManager();

    cm.save({ terminal: { colors: { background: '#fff', foreground: '#000' } } });
    const afterFirstWrite = cm.load();
    expect(afterFirstWrite.terminal.colors).toEqual({ background: '#fff', foreground: '#000' });

    // Save again WITHOUT foreground. With dictionaryPaths replace semantics the
    // whole terminal.colors map is swapped out, so foreground is gone. With
    // deep-merge semantics (replaceFlatMaps: false, no dictionaryPaths entry)
    // the previous foreground would survive the merge instead.
    cm.save({ terminal: { colors: { background: '#fff' } } });
    const afterSecondWrite = cm.load();
    expect(afterSecondWrite.terminal.colors.foreground).toBeUndefined();
    expect(afterSecondWrite.terminal.colors.background).toBe('#fff');

    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(raw.terminal.colors).not.toHaveProperty('foreground');
  });

  it('saving an empty colors map clears every previously-set slot', async () => {
    const cm = await createConfigManager();

    cm.save({ terminal: { colors: { background: '#fff', foreground: '#000', cursor: '#abc' } } });
    cm.save({ terminal: { colors: {} } });

    const config = cm.load();
    expect(config.terminal.colors).toEqual({});

    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(raw.terminal.colors).toEqual({});
  });
});

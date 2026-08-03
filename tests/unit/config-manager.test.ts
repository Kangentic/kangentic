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
import type { SerializedWorkspace } from '../../src/shared/types';

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

describe('Config Manager -- monitorWorkspace replace semantics', () => {
  // 'monitorWorkspace' is a CONFIG_DICTIONARY_PATHS entry (config-manager.ts) for the
  // same reason as its sibling 'commandTerminalWorkspace' above: the renderer always
  // writes the FULL SerializedWorkspace blob (config-store.ts's saveMonitorWorkspace /
  // flushMonitorWorkspace), so save() must REPLACE the stored blob wholesale rather
  // than deep-merge it - otherwise a detail window closed in one save could reappear
  // after a later, unrelated save merges the stale entry back in.

  it('set({ monitorWorkspace: null }) REPLACES the previous blob, not deep-merges it', async () => {
    // Mirrors the commandTerminalWorkspace null-write test above for structural
    // consistency, and null-write IS a real code path (all windows closed). But
    // unlike the tileTree-collapse test below, this assertion does NOT by itself pin
    // 'monitorWorkspace' in CONFIG_DICTIONARY_PATHS: deepMerge's null branch
    // (`value !== null` failing) assigns `null` directly regardless of
    // dictionaryPaths membership, so this passes even with the entry removed. The
    // regression guard for the array-shrink hole is the next test.
    const initialWorkspace: SerializedWorkspace = {
      version: 1,
      windows: [
        {
          taskId: 'proj-a:task-1',
          kind: 'task-detail',
          title: 'Fix the thing',
          geometry: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 },
          restoreGeometry: null,
          state: 'floating',
        },
      ],
      tileTree: null,
      tileTreeRect: { x: 0, y: 0, w: 1, h: 1 },
      focusedTaskId: 'proj-a:task-1',
    };

    const cm = await createConfigManager();
    cm.save({ monitorWorkspace: initialWorkspace });
    const afterFirstWrite = cm.load();
    expect(afterFirstWrite.monitorWorkspace).not.toBeNull();
    expect(afterFirstWrite.monitorWorkspace?.windows).toHaveLength(1);

    cm.save({ monitorWorkspace: null });
    const afterNullWrite = cm.load();
    expect(afterNullWrite.monitorWorkspace).toBeNull();

    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(raw.monitorWorkspace).toBeNull();
  });

  it('closing a tiled monitor window collapses windows AND tileTree on save, not merges the stale split back in', async () => {
    // This is the assertion that actually pins 'monitorWorkspace' in
    // CONFIG_DICTIONARY_PATHS. A plain windows-array shrink alone does NOT: deepMerge
    // always assigns an array value wholesale (its recursion guard requires
    // `!Array.isArray(value)`), so `windows: []` replaces correctly whether or not
    // 'monitorWorkspace' is a dictionary path - confirmed empirically against the
    // real deepMerge, both with and without the entry present. tileTree IS the
    // discriminator: it is a plain object (SerializedTileNode), so it's reached by
    // the recursive merge path. Collapsing a two-pane 'split' down to a single
    // 'leaf' would, under merge semantics, leak the old split's
    // direction/children/sizes onto the new leaf - the persisted layout would still
    // describe the closed window's tiling, which is exactly the "closed details keep
    // reappearing" failure the CONFIG_DICTIONARY_PATHS comment describes.
    const twoWindowSplit: SerializedWorkspace = {
      version: 1,
      windows: [
        {
          taskId: 'proj-a:task-1',
          kind: 'task-detail',
          title: 'Fix the thing',
          geometry: { x: 0, y: 0, w: 0.5, h: 1 },
          restoreGeometry: null,
          state: 'tiled',
        },
        {
          taskId: 'proj-a:task-2',
          kind: 'task-detail',
          title: 'Also fix this',
          geometry: { x: 0.5, y: 0, w: 0.5, h: 1 },
          restoreGeometry: null,
          state: 'tiled',
        },
      ],
      tileTree: {
        kind: 'split',
        direction: 'horizontal',
        children: [
          { kind: 'leaf', taskId: 'proj-a:task-1' },
          { kind: 'leaf', taskId: 'proj-a:task-2' },
        ],
        sizes: [0.5, 0.5],
      },
      tileTreeRect: { x: 0, y: 0, w: 1, h: 1 },
      focusedTaskId: 'proj-a:task-2',
    };
    const oneWindowLeaf: SerializedWorkspace = {
      version: 1,
      windows: [
        {
          taskId: 'proj-a:task-1',
          kind: 'task-detail',
          title: 'Fix the thing',
          geometry: { x: 0, y: 0, w: 1, h: 1 },
          restoreGeometry: null,
          state: 'tiled',
        },
      ],
      tileTree: { kind: 'leaf', taskId: 'proj-a:task-1' },
      tileTreeRect: { x: 0, y: 0, w: 1, h: 1 },
      focusedTaskId: 'proj-a:task-1',
    };

    const cm = await createConfigManager();
    cm.save({ monitorWorkspace: twoWindowSplit });
    const afterFirstWrite = cm.load();
    expect(afterFirstWrite.monitorWorkspace?.windows).toHaveLength(2);

    cm.save({ monitorWorkspace: oneWindowLeaf });
    const afterSecondWrite = cm.load();

    // Red: removing 'monitorWorkspace' from CONFIG_DICTIONARY_PATHS makes this
    // deep-merge instead. windows still shrinks to 1 (arrays always replace), but
    // tileTree would merge the leaf's own two keys into the OLD split object,
    // leaving 'direction' / 'children' / 'sizes' behind from the closed window's split.
    expect(afterSecondWrite.monitorWorkspace?.windows).toHaveLength(1);
    expect(afterSecondWrite.monitorWorkspace?.tileTree).toEqual({ kind: 'leaf', taskId: 'proj-a:task-1' });

    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(raw.monitorWorkspace.windows).toHaveLength(1);
    expect(raw.monitorWorkspace.tileTree).toEqual({ kind: 'leaf', taskId: 'proj-a:task-1' });
  });

  it('writing a new monitorWorkspace blob REPLACES stale sub-fields rather than merging them in', async () => {
    // Mirrors the commandTerminalWorkspace stale-sub-field test above: an extra key
    // present in an earlier blob but absent from a later one must not survive.
    const firstBlob = {
      version: 1,
      windows: [],
      tileTree: null,
      tileTreeRect: { x: 0, y: 0, w: 1, h: 1 },
      focusedTaskId: 'proj-a:task-old',
      // Extra key not in SerializedWorkspace - simulates a field that will be absent
      // from the next write.
      _staleKey: 'should-be-gone',
    };
    const secondBlob = {
      version: 1,
      windows: [],
      tileTree: null,
      tileTreeRect: { x: 0, y: 0, w: 1, h: 1 },
      focusedTaskId: 'proj-a:task-new',
      // _staleKey intentionally absent - in merge semantics it would survive from
      // the first blob; in replace semantics it is gone.
    };

    const cm = await createConfigManager();
    // Use a cast to bypass TypeScript's strict-shape check for the test-extra key.
    cm.save({ monitorWorkspace: firstBlob as Parameters<typeof cm.save>[0]['monitorWorkspace'] });
    cm.save({ monitorWorkspace: secondBlob as Parameters<typeof cm.save>[0]['monitorWorkspace'] });

    const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    // Replace semantics: the stale key from the first blob must not survive.
    expect(raw.monitorWorkspace._staleKey).toBeUndefined();
    // The new focusedTaskId must reflect the second write.
    expect(raw.monitorWorkspace.focusedTaskId).toBe('proj-a:task-new');
  });
});

describe('Config Manager -- divergent-cache clobber across instances (characterization)', () => {
  // Characterizes a footgun that shipped live: src/main/index.ts keeps a
  // module-scope `windowConfigManager` whose cache is populated at startup (by
  // resolveWindowBounds), separate from the ipc-context ConfigManager that
  // config:set writes through. ConfigManager.save() always deep-merges into its
  // OWN cached config and rewrites the WHOLE file, so a save() through the
  // stale-cached instance silently reverts every field written through the
  // other instance since that cache was populated.
  //
  // This bit the debounced window-bounds writer specifically: it used to always
  // save() through windowConfigManager, so any renderer-driven config write
  // made after launch (an update to lastWhatsNewShownVersion, in the observed
  // incident) was reverted back to its pre-launch value on the next window
  // move or resize. The fix (src/main/index.ts) makes that call site prefer
  // `getOptionalIpcContext()?.configManager ?? windowConfigManager` - the SAME
  // pattern the pop-out bounds writer already used - so it merges into the
  // fresher, IPC-authoritative cache instead.
  //
  // The fresh-install seed a few lines above that same call site
  // (`windowConfigManager.save({ lastWhatsNewShownVersion: app.getVersion() })`
  // in app.whenReady()) is NOT a case of this hazard: it runs before
  // createWindow(), before any IPC context exists and before anything else has
  // written config, so there is no fresher cache yet to clobber.
  //
  // This test does NOT exercise src/main/index.ts (a startup file the unit
  // tier cannot import) and does NOT guard the call-site fix itself - reverting
  // that fix leaves this test green, since it only characterizes
  // ConfigManager's own save()/load() contract. Its value is narrower: it names
  // the hazard for whoever next adds a THIRD long-lived ConfigManager instance,
  // or "simplifies" an existing one back to a single shared save() call.
  it("a stale-cached instance's save() reverts a field written by a fresher instance in the meantime", async () => {
    const staleCached = await createConfigManager();
    // Populate this instance's cache now, before the other instance writes
    // anything - mirrors windowConfigManager reading config at startup.
    staleCached.load();

    const { ConfigManager } = await import('../../src/main/config/config-manager');
    const fresher = new ConfigManager();
    fresher.save({ lastWhatsNewShownVersion: '0.32.0' });

    // The fresher instance's write landed on disk.
    let raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(raw.lastWhatsNewShownVersion).toBe('0.32.0');

    // An unrelated save through the stale-cached instance (standing in for the
    // debounced window-bounds writer) merges its partial update into ITS OWN
    // outdated cache and rewrites the whole file, so the write succeeds but
    // reverts lastWhatsNewShownVersion back to the default it saw at load time.
    staleCached.save({ windowBounds: { x: 0, y: 0, width: 800, height: 600 } });

    raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    // Red if ConfigManager ever stopped caching per-instance (e.g. a shared
    // module-level cache): this would then read '0.32.0' instead.
    expect(raw.lastWhatsNewShownVersion).toBe('');
    // The stale-cached instance's own write still succeeds - this is a silent
    // clobber, not a failed write, which is what makes it dangerous.
    expect(raw.windowBounds).toEqual({ x: 0, y: 0, width: 800, height: 600 });
  });
});

describe('Config Manager -- monitor deep-merge (NOT a CONFIG_DICTIONARY_PATHS entry)', () => {
  // 'monitor' is deliberately absent from CONFIG_DICTIONARY_PATHS: it is a typed
  // MonitorView struct (layout/groupBy/sort/liveOnly/projectFilter/stateFilter/
  // textFilter), not a renderer-authoritative dictionary, so a partial write must
  // MERGE and preserve the other six keys. These tests guard both directions of
  // that contract: an on-disk config missing 'monitor' entirely must still populate
  // every key from DEFAULT_CONFIG.monitor (a renderer reading `.layout` off
  // `undefined` would crash), and a partial on-disk 'monitor' block must merge in
  // the rest of the defaults rather than replace the whole struct.

  it('loads with monitor populated from DEFAULT_CONFIG.monitor when the on-disk config has no monitor key at all', async () => {
    fs.writeFileSync(configPath, JSON.stringify({ theme: 'dark' }));

    const cm = await createConfigManager();
    const config = cm.load();
    const { DEFAULT_CONFIG } = await import('../../src/shared/types');

    expect(config.monitor).toEqual(DEFAULT_CONFIG.monitor);
    expect(config.monitor.layout).toBe('cards');
  });

  it('a partial on-disk monitor override merges rather than replaces, preserving the other MonitorView keys', async () => {
    fs.writeFileSync(configPath, JSON.stringify({
      monitor: { layout: 'rows' },
    }));

    const cm = await createConfigManager();
    const config = cm.load();

    // The explicit override survives.
    expect(config.monitor.layout).toBe('rows');
    // Every other MonitorView key is preserved from DEFAULT_CONFIG.monitor, not
    // dropped. Red if 'monitor' were ever added to CONFIG_DICTIONARY_PATHS (or
    // deepMergeConfig's own narrower dictionaryPaths list): a partial write would
    // then replace the whole struct, and these would come back undefined/empty in
    // a way that doesn't match the defaults below.
    expect(config.monitor.groupBy).toBe('project');
    expect(config.monitor.sort).toBe('longest-running');
    expect(config.monitor.liveOnly).toBe(false);
    expect(config.monitor.projectFilter).toEqual([]);
    expect(config.monitor.stateFilter).toEqual([]);
    expect(config.monitor.textFilter).toBe('');
  });
});

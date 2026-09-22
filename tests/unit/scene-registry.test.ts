/**
 * The scene registry (tests/captures/scenes.ts) is data that two consumers build from and one
 * more reads: the web build boots each entry, the capture rig shoots it, and the site embeds it
 * by name with the alt text the entry carries. Nothing typechecks it in CI (tsconfig includes
 * src/** only), and most of its fields are loose records, so a typo'd config key, a task id the
 * sample install does not seed, or a reach tag that disagrees with the steps all no-op silently.
 * This test pins each of those against the real sources rather than a re-declared list, and it
 * is the only writing-style check the alt strings get: the character scan excludes tests/, and
 * an alt ships to a docs page.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import * as ts from 'typescript';
import { SCENES, isRigStep, type DemoBootStep, type RigStep, type SceneDefinition } from '../../tests/captures/scenes';
import { DEMO_SESSIONS, DEMO_TASKS, demoLaneIds } from '../../tests/captures/helpers/demo-dataset';
import { DEFAULT_CONFIG, type SerializedTileNode, type SerializedWorkspace } from '../../src/shared/types';
import { SETTINGS_TABS } from '../../src/renderer/components/settings/settings-tabs';
import { SETTINGS_REGISTRY } from '../../src/renderer/components/settings/settings-registry';

const REPO_ROOT = path.resolve(__dirname, '../..');
const DEMO_BOOT_PATH = path.join(REPO_ROOT, 'demo/boot.js');
const DEMO_VITE_CONFIG_PATH = path.join(REPO_ROOT, 'demo/vite.config.mts');
const SHARED_TYPES_PATH = path.join(REPO_ROOT, 'src/shared/types.ts');

/**
 * Every top-level member `AppConfig` declares, OPTIONAL ones included.
 *
 * `Object.keys(DEFAULT_CONFIG)` is not the same set and using it rejected a legitimate key: an
 * optional block like `developer` has no runtime default, so a scene that switches on a developer
 * flag looked like a typo. The point of the check is that the renderer never reads the key, and a
 * declared member is read; a misspelling still is not.
 */
function declaredAppConfigKeys(): Set<string> {
  const sourceFile = ts.createSourceFile(
    SHARED_TYPES_PATH,
    fs.readFileSync(SHARED_TYPES_PATH, 'utf-8'),
    ts.ScriptTarget.Latest,
    true,
  );
  for (const statement of sourceFile.statements) {
    if (!ts.isInterfaceDeclaration(statement) || statement.name.text !== 'AppConfig') continue;
    const names = statement.members
      .map((member) => member.name)
      .filter((name): name is ts.Identifier | ts.StringLiteral => name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name)))
      .map((name) => name.text);
    if (names.length === 0) break;
    return new Set(names);
  }
  throw new Error(
    'scene-registry: no top-level `interface AppConfig` with members in src/shared/types.ts. '
    + 'If it moved or was renamed, update declaredAppConfigKeys() in tests/unit/scene-registry.test.ts.',
  );
}

const DEMO_STATE_KEYS = ['config', 'tasks', 'sessions', 'seeds', 'steps'];
/** The keys a boot step may carry: a click, typed text, or a held hotkey, each with an optional wait. */
const BOOT_STEP_KEYS = ['click', 'type', 'text', 'press', 'waitFor'];

/** The tells the writing-style scan bans, plus the `--` separator it cannot tell from a CLI flag. */
const BANNED_CHARACTERS = /[—–‘’“”]|--/;

const entries = Object.entries(SCENES);
const scenes = entries.map(([, scene]) => scene);

function stepsOf(scene: SceneDefinition): Array<DemoBootStep | RigStep> {
  return scene.steps ?? [];
}

/** The anchors a tile tree's leaves name, in order. */
function tileLeaves(node: SerializedTileNode | null): string[] {
  if (!node) return [];
  if (node.kind === 'leaf') return [node.taskId];
  return node.children.flatMap(tileLeaves);
}

/** Every workspace blob a scene restores: the board layer's per-project map and the Command Terminal's global one. */
function workspacesOf(scene: SceneDefinition): Array<{ where: string; workspace: SerializedWorkspace }> {
  const config = scene.config ?? {};
  const restored: Array<{ where: string; workspace: SerializedWorkspace }> = [];
  for (const [projectId, workspace] of Object.entries((config.workspaceByProject ?? {}) as Record<string, SerializedWorkspace>)) {
    restored.push({ where: `workspaceByProject.${projectId}`, workspace });
  }
  if (config.commandTerminalWorkspace) restored.push({ where: 'commandTerminalWorkspace', workspace: config.commandTerminalWorkspace as SerializedWorkspace });
  return restored;
}

describe('scene registry', () => {
  it('is a plausible catalog', () => {
    // Vacuity guard: an import that resolved to an empty map would pass every check below.
    expect(scenes.length).toBeGreaterThanOrEqual(20);
    expect(SCENES.board).toBeDefined();
    expect(SCENES.monitor).toBeDefined();
  });

  it('keys every entry by its name', () => {
    for (const [key, scene] of entries) expect(scene.name, `SCENES.${key}`).toBe(key);
  });

  it('carries the fields the consumers read', () => {
    for (const scene of scenes) {
      expect(scene.description.trim(), `${scene.name}.description`).not.toBe('');
      expect(scene.alt.trim(), `${scene.name}.alt`).not.toBe('');
      expect(scene.ready.trim(), `${scene.name}.ready`).not.toBe('');
      // An alt is one or two sentences a screen reader speaks, not a paragraph.
      expect(scene.alt.length, `${scene.name}.alt is too long for alt text`).toBeLessThanOrEqual(260);
    }
  });

  it('writes its alt strings in house style', () => {
    for (const scene of scenes) {
      expect(scene.alt, `${scene.name}.alt carries a dash or a curly quote`).not.toMatch(BANNED_CHARACTERS);
      expect(scene.description, `${scene.name}.description carries a dash or a curly quote`).not.toMatch(BANNED_CHARACTERS);
    }
  });

  it('tags reach by what the steps need', () => {
    for (const scene of scenes) {
      const steps = stepsOf(scene);
      const rigSteps = steps.filter(isRigStep);
      if (scene.reach === 'state') {
        expect(steps, `${scene.name} is state but has steps`).toEqual([]);
      } else if (scene.reach === 'boot') {
        expect(steps.length, `${scene.name} is boot but clicks nothing; tag it state`).toBeGreaterThan(0);
        expect(rigSteps, `${scene.name} is boot but carries a rig-only step; tag it driver`).toEqual([]);
        for (const step of steps) {
          const extra = Object.keys(step).filter((key) => !BOOT_STEP_KEYS.includes(key));
          expect(extra, `${scene.name} boot step has keys boot.js would refuse`).toEqual([]);
        }
      } else {
        expect(rigSteps.length, `${scene.name} is driver but every step is a click; tag it boot`).toBeGreaterThan(0);
      }
    }
  });

  it('patches only rows the sample install seeds', () => {
    const taskIds = new Set(DEMO_TASKS.map((task) => task.id));
    const sessionIds = new Set(DEMO_SESSIONS.map((session) => session.id));
    for (const scene of scenes) {
      for (const patch of scene.tasks ?? []) {
        expect(taskIds.has(patch.id), `${scene.name} patches unknown task ${patch.id}`).toBe(true);
      }
      for (const sessionId of Object.keys(scene.sessions ?? {})) {
        expect(sessionIds.has(sessionId), `${scene.name} patches unknown session ${sessionId}`).toBe(true);
      }
    }
  });

  it('restores windows only on rows the sample install seeds, and tiles only windows it restores', () => {
    // deserializeWorkspace drops a window whose anchor is unknown and, if that window was tiled,
    // the whole tile tree with it, silently: a tiled scene naming a stray id would boot to two
    // floating windows or none, and its ready selector would time out rather than say why.
    const taskIds = new Set(DEMO_TASKS.map((task) => task.id));
    const sessionIds = new Set(DEMO_SESSIONS.map((session) => session.id));
    let restoredWindows = 0;
    for (const scene of scenes) {
      for (const { where, workspace } of workspacesOf(scene)) {
        const anchors = new Set<string>();
        for (const window of workspace.windows) {
          restoredWindows += 1;
          const kind = window.kind ?? 'task-detail';
          if (kind === 'task-detail') expect(taskIds.has(window.taskId), `${scene.name} ${where} restores a task window on unknown task ${window.taskId}`).toBe(true);
          if (kind === 'conversation') expect(sessionIds.has(window.taskId), `${scene.name} ${where} restores a conversation window on unknown session ${window.taskId}`).toBe(true);
          if (kind === 'command-terminal') expect(window.taskId, `${scene.name} ${where} anchors a Command Terminal on something other than a slot`).toMatch(/^slot-\d+$/);
          anchors.add(window.taskId);
        }
        for (const leaf of tileLeaves(workspace.tileTree)) {
          expect(anchors.has(leaf), `${scene.name} ${where} tiles a leaf with no window: ${leaf}`).toBe(true);
        }
        if (workspace.focusedTaskId) expect(anchors.has(workspace.focusedTaskId), `${scene.name} ${where} focuses a window it does not restore`).toBe(true);
      }
    }
    // Vacuity guard: the task, changes, and tiled scenes all restore windows.
    expect(restoredWindows).toBeGreaterThan(5);
  });

  it('overrides only real config keys', () => {
    // The mock's Object.assign would accept any key and the renderer would never read it.
    const configKeys = declaredAppConfigKeys();
    // Vacuity guard: a parse that resolved no members would accept every typo.
    expect(configKeys.size).toBeGreaterThan(Object.keys(DEFAULT_CONFIG).length / 2);
    for (const key of Object.keys(DEFAULT_CONFIG)) {
      expect(configKeys.has(key), `AppConfig no longer declares ${key}; declaredAppConfigKeys() is parsing the wrong thing`).toBe(true);
    }
    for (const scene of scenes) {
      for (const key of Object.keys(scene.config ?? {})) {
        expect(configKeys.has(key), `${scene.name}.config.${key} is not an AppConfig key`).toBe(true);
      }
    }
  });

  it('spells a nested config block whole, because a scene REPLACES one', () => {
    // boot.js merges a scene's config with a shallow Object.assign, and so does the mock, so a
    // nested block a scene names replaces the default's WHOLE. Naming one field of it therefore
    // leaves every sibling undefined, on settings the scene never meant to touch and that no
    // frame shows. The key-set check is what makes that loud; the VALUES are the scene's business.
    //
    // A block with no populated default (an optional one like `developer`, or a map keyed by
    // project id like `workspaceByProject`) has no shape to match and is skipped.
    const defaults = DEFAULT_CONFIG as unknown as Record<string, unknown>;
    const isPlainObject = (value: unknown): value is Record<string, unknown> =>
      typeof value === 'object' && value !== null && !Array.isArray(value);
    let checked = 0;
    for (const scene of scenes) {
      for (const [key, override] of Object.entries(scene.config ?? {})) {
        const fallback = defaults[key];
        if (!isPlainObject(fallback) || !isPlainObject(override)) continue;
        if (Object.keys(fallback).length === 0) continue;
        checked += 1;
        expect(
          Object.keys(override).sort(),
          `${scene.name}.config.${key} replaces the whole block, so it must name every field DEFAULT_CONFIG.${key} has`,
        ).toEqual(Object.keys(fallback).sort());
      }
    }
    // Vacuity guard: the monitor and notification scenes both replace a populated block.
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  it('seeds column ids the sample install actually has', () => {
    // A `tasks` or `sessions` patch is checked above; a `__mock*` seed is not, and a typo'd
    // column id fails SILENTLY in the worst way available: the Column Manager still opens, the
    // automation slot still reads Add automation, the scene's ready selector still resolves, and
    // the alt written from that frame is wrong. The ids come from demoLaneId, which the seed
    // itself uses, so this cannot drift from what the install writes.
    const laneIds = new Set(demoLaneIds());
    // Vacuity guard: a formula change that returned nothing, or collided every id into one, would
    // otherwise leave the loop below asserting against an empty set. The sample install seeds two
    // projects off DEFAULT_LANES, so the real count is comfortably above this floor; the floor is
    // deliberately loose so adding or retiring one column does not fail an unrelated test.
    expect(laneIds.size).toBeGreaterThan(6);
    let checked = 0;
    for (const scene of scenes) {
      const seeds = (scene.seeds ?? {}) as {
        __mockSwimlanePatches?: Record<string, unknown>;
        __mockAutomations?: Array<{ swimlane_id?: string }>;
      };
      for (const laneId of Object.keys(seeds.__mockSwimlanePatches ?? {})) {
        checked += 1;
        expect(laneIds.has(laneId), `${scene.name} patches unknown column ${laneId}`).toBe(true);
      }
      for (const automation of seeds.__mockAutomations ?? []) {
        checked += 1;
        expect(
          automation.swimlane_id !== undefined && laneIds.has(automation.swimlane_id),
          `${scene.name} seeds an automation on unknown column ${String(automation.swimlane_id)}`,
        ).toBe(true);
      }
    }
    // Vacuity guard: the column-automation and column-handoff scenes both seed one.
    expect(checked).toBeGreaterThanOrEqual(2);
  });

  it('seeds only __mock globals', () => {
    for (const scene of scenes) {
      for (const key of Object.keys(scene.seeds ?? {})) {
        expect(key.startsWith('__mock'), `${scene.name}.seeds.${key}`).toBe(true);
      }
    }
  });

  it('has one settings scene per settings tab, and no other', () => {
    const tabIds = SETTINGS_TABS.map((tab) => tab.id).sort();
    const settingsScenes = scenes.filter((scene) => scene.name.startsWith('settings-'));
    expect(settingsScenes.map((scene) => scene.name.slice('settings-'.length)).sort()).toEqual(tabIds);

    const registryById = new Map(SETTINGS_REGISTRY.map((setting) => [setting.id, setting]));
    for (const scene of settingsScenes) {
      const tab = scene.name.slice('settings-'.length);
      // Each is the gear and then that tab's button, which shared.tsx stamps by id.
      const clicks = stepsOf(scene).map((step) => ('click' in step ? step.click : ''));
      expect(clicks, `${scene.name} steps`).toEqual(['[data-testid="settings-button"]', `[data-testid="settings-tab-${tab}"]`]);
      // A `setting-row-<id>` marker names a registry row that lives on this tab; a tab-level
      // marker (hotkeys-tab, add-shortcut) is pinned by the smoke tier instead.
      const marker = scene.ready.match(/^\[data-testid="setting-row-(.+)"\]$/);
      if (marker) {
        const setting = registryById.get(marker[1]);
        expect(setting, `${scene.name} waits on a registry row that does not exist: ${marker[1]}`).toBeDefined();
        expect(setting?.tabId, `${scene.name} waits on a row from another tab`).toBe(tab);
      }
    }
  });

  it('agrees with the keys demo/boot.js accepts in a state= blob', () => {
    const boot = fs.readFileSync(DEMO_BOOT_PATH, 'utf-8');
    const keysMatch = boot.match(/var STATE_KEYS = \[([^\]]*)\]/);
    if (!keysMatch) throw new Error('STATE_KEYS not found in demo/boot.js');
    const bootKeys = Array.from(keysMatch[1].matchAll(/'([a-zA-Z]+)'/g), (match) => match[1]);
    expect(bootKeys.sort()).toEqual([...DEMO_STATE_KEYS].sort());
    // The step allowlist boot.js enforces on a blob is the boot-step shape, and nothing more.
    const stepKeysMatch = boot.match(/var BOOT_STEP_KEYS = \[([^\]]*)\]/);
    if (!stepKeysMatch) throw new Error('BOOT_STEP_KEYS not found in demo/boot.js');
    const bootStepKeys = Array.from(stepKeysMatch[1].matchAll(/'([a-zA-Z]+)'/g), (match) => match[1]);
    expect(bootStepKeys.sort()).toEqual([...BOOT_STEP_KEYS].sort());
    // The two fields the consumers wait on and report are read by name.
    expect(boot).toContain('scene.ready');
    expect(boot).toContain('scene.focus');
    // The nested-block shape the build emits, and the guard that reads it. boot.js is a classic
    // script and cannot import AppConfig, so the two halves only agree by name.
    const viteConfig = fs.readFileSync(DEMO_VITE_CONFIG_PATH, 'utf-8');
    expect(viteConfig, 'the build emits the nested config shape').toContain('window.__demoConfigShape =');
    expect(boot, 'boot.js validates a state= blob against it').toContain('window.__demoConfigShape');
  });

  it('guards the escape message on markers the renderer still stamps', () => {
    // boot.js decides "does the app own this Escape" by looking for these in the DOM, mirroring
    // PopOutWindowFrame's own ladder. A renamed marker would not fail anything: the frame would
    // simply stop posting, or start posting over an open dialog, and the site's figure would
    // quietly get the wrong behaviour. Anchored on the renderer so a rename fails here instead.
    const boot = fs.readFileSync(DEMO_BOOT_PATH, 'utf-8');
    const markers: Array<{ marker: string; source: string }> = [
      { marker: 'data-dismissable-layer', source: 'src/renderer/components/dialogs/BaseDialog.tsx' },
      // The prefix, not the whole JSX attribute: the selector depends on the prefix alone, and
      // pinning the attribute would fail on a reformat of WindowFrame.tsx rather than a rename.
      { marker: 'window-frame-', source: 'src/renderer/window-manager/components/WindowFrame.tsx' },
      { marker: 'xterm-helper-textarea', source: 'src/renderer/utils/terminal-clipboard.ts' },
    ];
    for (const { marker, source } of markers) {
      const rendererSource = fs.readFileSync(path.join(REPO_ROOT, source), 'utf-8');
      expect(rendererSource, `${source} no longer stamps ${marker}`).toContain(marker);
    }
    expect(boot).toContain('[data-dismissable-layer]');
    expect(boot).toContain('[data-testid^="window-frame-"]');
    expect(boot).toContain('xterm-helper-textarea');
    expect(boot, 'the escape message is still posted').toContain('kangentic-demo-escape');
  });

  it('is emitted into the demo build as scenes.json', () => {
    const viteConfig = fs.readFileSync(DEMO_VITE_CONFIG_PATH, 'utf-8');
    expect(viteConfig).toContain("fileName: 'scenes.json'");
    // The manifest carries what the site needs and reads it off the same entries the page boots.
    for (const field of ['name', 'reach', 'alt', 'description']) {
      expect(viteConfig, `scenes.json carries ${field}`).toMatch(new RegExp(`${field}: scene\\.${field}`));
    }
  });
});

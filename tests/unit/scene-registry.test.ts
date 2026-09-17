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
import { SCENES, isRigStep, type DemoBootStep, type RigStep, type SceneDefinition } from '../../tests/captures/scenes';
import { DEMO_SESSIONS, DEMO_TASKS } from '../../tests/captures/helpers/demo-dataset';
import { DEFAULT_CONFIG } from '../../src/shared/types';
import { SETTINGS_TABS } from '../../src/renderer/components/settings/settings-tabs';
import { SETTINGS_REGISTRY } from '../../src/renderer/components/settings/settings-registry';

const REPO_ROOT = path.resolve(__dirname, '../..');
const DEMO_BOOT_PATH = path.join(REPO_ROOT, 'demo/boot.js');
const DEMO_VITE_CONFIG_PATH = path.join(REPO_ROOT, 'demo/vite.config.mts');

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

  it('overrides only real config keys', () => {
    // The mock's Object.assign would accept any key and the renderer would never read it.
    const configKeys = new Set(Object.keys(DEFAULT_CONFIG));
    for (const scene of scenes) {
      for (const key of Object.keys(scene.config ?? {})) {
        expect(configKeys.has(key), `${scene.name}.config.${key} is not an AppConfig key`).toBe(true);
      }
    }
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

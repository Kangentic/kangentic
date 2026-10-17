/**
 * sceneUrl (tests/captures/helpers/scene-page.ts) is the pure half of the capture rig's page
 * open: it builds the URL every scene boots through, `view=` and a still. A held gesture is a
 * choreography's pose, which demo/boot.js plays in the page, so no scene travels as a `state=`
 * blob any more. This pins that contract without driving a real page.
 */
import { describe, it, expect } from 'vitest';
import { SCENE_THEMES, sceneUrl, type OpenSceneOptions } from '../../tests/captures/helpers/scene-page';
import type { SceneDefinition } from '../../tests/captures/scenes';

const options: OpenSceneOptions = { baseUrl: 'http://127.0.0.1:4173/demo/', theme: 'sand' };

const stateScene: SceneDefinition = {
  name: 'scene-url-state-sample',
  description: 'Fixture scene for the sceneUrl pin tests.',
  alt: 'A fixture scene used only to test sceneUrl.',
  ready: '[data-testid="scene-url-ready"]',
  reach: 'state',
};

const bootScene: SceneDefinition = {
  name: 'scene-url-boot-sample',
  description: 'Fixture scene for the sceneUrl pin tests.',
  alt: 'A fixture scene used only to test sceneUrl.',
  ready: '[data-testid="scene-url-ready"]',
  reach: 'boot',
  steps: [{ click: '[data-testid="scene-url-click-target"]' }],
};

const posedScene: SceneDefinition = {
  name: 'scene-url-posed-sample',
  description: 'Fixture scene for the sceneUrl pin tests.',
  alt: 'A fixture scene used only to test sceneUrl.',
  ready: '[data-testid="scene-url-ready"]',
  reach: 'boot',
  config: { theme: 'dark' },
  tasks: [{ id: 'task-1', title: 'Sample task' }],
  choreography: [{ contextmenu: '[data-testid="scene-url-context-target"]' }, { pose: true }],
};

describe('sceneUrl', () => {
  it('boots a state scene through view=, with no state param', () => {
    const url = new URL(sceneUrl(stateScene, options));
    expect(url.searchParams.get('view')).toBe('scene-url-state-sample');
    expect(url.searchParams.get('embed')).toBe('1');
    expect(url.searchParams.get('still')).toBe('1');
    expect(url.searchParams.get('stage')).toBe('0');
    expect(url.searchParams.get('theme')).toBe('sand');
    expect(url.searchParams.has('state')).toBe(false);
  });

  it('boots a boot scene through view=, with no state param', () => {
    const url = new URL(sceneUrl(bootScene, options));
    expect(url.searchParams.get('view')).toBe('scene-url-boot-sample');
    expect(url.searchParams.has('state')).toBe(false);
  });

  it('preserves the base URL trailing slash', () => {
    const url = sceneUrl(stateScene, options);
    expect(url.startsWith('http://127.0.0.1:4173/demo/?')).toBe(true);
  });

  // The theme travels to demo/boot.js verbatim, which resolves the aliases itself. The rig
  // validates CAPTURE_THEMES against this same list, and the poster set shoots clay and rust
  // through it, so the product pair has to be here and has to pass through untouched.
  it('passes every rig theme through as theme=, the product pair included', () => {
    expect(SCENE_THEMES).toContain('clay');
    expect(SCENE_THEMES).toContain('rust');
    for (const theme of SCENE_THEMES) {
      const url = new URL(sceneUrl(stateScene, { ...options, theme }));
      expect(url.searchParams.get('theme')).toBe(theme);
    }
  });

  // A held gesture used to need the rig's own mouse and a state= blob, because boot.js refused the
  // scene by name. Its pose is now played by boot.js in the still, so it boots by name like any other.
  it('boots a scene with a pose through view=, as a still, with no state param', () => {
    const url = new URL(sceneUrl(posedScene, options));
    expect(url.searchParams.get('view')).toBe('scene-url-posed-sample');
    expect(url.searchParams.get('still')).toBe('1');
    expect(url.searchParams.has('state')).toBe(false);
  });
});

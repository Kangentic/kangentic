/**
 * sceneUrl (tests/captures/helpers/scene-page.ts) is the pure half of the capture rig's page
 * open: it builds the URL a state or boot scene boots through `view=`, and the URL a driver
 * scene carries as a `state=` blob (never a `view=`, since demo/boot.js refuses a driver scene
 * by name). This pins that contract without driving a real page.
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

const driverSceneFullyLoaded: SceneDefinition = {
  name: 'scene-url-driver-full-sample',
  description: 'Fixture scene for the sceneUrl pin tests.',
  alt: 'A fixture scene used only to test sceneUrl.',
  ready: '[data-testid="scene-url-ready"]',
  reach: 'driver',
  config: { theme: 'dark' },
  tasks: [{ id: 'task-1', title: 'Sample task' }],
  sessions: { 'session-1': { activity: 'idle' } },
  seeds: { __mockSomething: true },
  steps: [{ hover: '[data-testid="scene-url-hover-target"]' }],
};

const driverScenePartiallyLoaded: SceneDefinition = {
  name: 'scene-url-driver-partial-sample',
  description: 'Fixture scene for the sceneUrl pin tests.',
  alt: 'A fixture scene used only to test sceneUrl.',
  ready: '[data-testid="scene-url-ready"]',
  reach: 'driver',
  tasks: [{ id: 'task-2', title: 'Partial task' }],
  steps: [{ contextmenu: '[data-testid="scene-url-context-target"]' }],
};

function decodeStateParam(url: URL): unknown {
  const encoded = url.searchParams.get('state');
  if (encoded === null) throw new Error('The URL carries no state param to decode');
  return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf-8'));
}

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

  it('carries a driver scene through state=, with no view param', () => {
    const url = new URL(sceneUrl(driverSceneFullyLoaded, options));
    expect(url.searchParams.has('view')).toBe(false);
    const decoded = decodeStateParam(url);
    expect(decoded).toEqual({
      config: { theme: 'dark' },
      tasks: [{ id: 'task-1', title: 'Sample task' }],
      sessions: { 'session-1': { activity: 'idle' } },
      seeds: { __mockSomething: true },
    });
  });

  it('carries only the keys the driver scene actually set, never steps or the descriptive fields', () => {
    const url = new URL(sceneUrl(driverScenePartiallyLoaded, options));
    const decoded = decodeStateParam(url);
    expect(Object.keys(decoded as Record<string, unknown>)).toEqual(['tasks']);
    expect(decoded).toEqual({ tasks: [{ id: 'task-2', title: 'Partial task' }] });
  });
});

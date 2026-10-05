/**
 * Open one registry scene (tests/captures/scenes.ts) in the BUILT web demo and play its steps.
 *
 * The rig is the registry's second consumer, and it deliberately carries no applier of its own:
 * demo/boot.js applies config, rows, seeds, and boot steps for the site and for this rig alike,
 * so a still shot here is literally a frame of what the site embeds. What only the rig adds is
 * the gesture a `driver` scene needs (a drag, a right-click, a hover), played with Playwright's
 * mouse after the frame reports ready. A driver scene is refused at `view=`, so its declarative
 * half travels as a `state=` blob with NO steps, and the rig plays every step itself in order:
 * a click step a boot scene would run in the page runs here through Playwright, so a driver
 * scene's clicks and gestures keep their authored order.
 */
import { expect, type Page } from '@playwright/test';
import { isRigStep, type DemoBootStep, type DemoState, type RigStep, type SceneDefinition } from '../scenes';

/** demo/boot.js gives itself 10s to reach the reveal; the cold module load rides on top. */
const READY_TIMEOUT_MS = 20_000;
const STEP_TIMEOUT_MS = 10_000;

/**
 * The `theme=` values the rig may ask demo/boot.js for: the two site names (`night` is the app's
 * dark theme, `sand` a light one), the product pair the site's figures embed with (`clay`, `rust`),
 * and the pair's earlier spellings, which boot.js still resolves. One list so the rig can refuse a
 * theme name the page would answer with its error card, rather than shooting the card.
 */
export const SCENE_THEMES = ['night', 'sand', 'clay', 'rust', 'kangentic-light', 'kangentic-dark'] as const;
export type SceneTheme = (typeof SCENE_THEMES)[number];

export interface OpenSceneOptions {
  /** The served build's base URL, e.g. http://127.0.0.1:PORT/demo/ (a trailing slash). */
  baseUrl: string;
  theme: SceneTheme;
}

function encodeState(state: DemoState): string {
  return Buffer.from(JSON.stringify(state)).toString('base64url');
}

/** The URL that boots the scene: `view=` for a bootable one, its state alone for a driver one. */
export function sceneUrl(scene: SceneDefinition, options: OpenSceneOptions): string {
  const url = new URL(options.baseUrl);
  url.searchParams.set('embed', '1');
  url.searchParams.set('still', '1');
  url.searchParams.set('stage', '0');
  url.searchParams.set('theme', options.theme);
  if (scene.reach === 'driver') {
    const state: DemoState = {};
    if (scene.config) state.config = scene.config;
    if (scene.tasks) state.tasks = scene.tasks;
    if (scene.sessions) state.sessions = scene.sessions;
    if (scene.seeds) state.seeds = scene.seeds;
    url.searchParams.set('state', encodeState(state));
  } else {
    url.searchParams.set('view', scene.name);
  }
  return url.toString();
}

async function pointFor(page: Page, target: string | { x: number; y: number }): Promise<{ x: number; y: number }> {
  if (typeof target !== 'string') {
    const viewport = page.viewportSize();
    if (!viewport) throw new Error('The page has no viewport to place a drag point in');
    return { x: viewport.width * target.x, y: viewport.height * target.y };
  }
  const locator = page.locator(target).first();
  await locator.waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  const box = await locator.boundingBox();
  if (!box) throw new Error(`No bounding box for ${target}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function playRigStep(page: Page, step: RigStep): Promise<void> {
  if ('hover' in step) {
    await page.locator(step.hover).first().hover();
    return;
  }
  if ('contextmenu' in step) {
    await page.locator(step.contextmenu).first().click({ button: 'right' });
    return;
  }
  // The dnd-kit PointerSensor pattern the walkthrough capture uses: press, a short move past
  // the activation distance, then the travel. A window drag needs the same shape (useWindowDrag
  // arms on pointer down and follows pointer moves), so one sequence serves both.
  const from = await pointFor(page, step.drag.from);
  const to = await pointFor(page, step.drag.to);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 10, from.y + 4, { steps: 3 });
  await page.mouse.move(to.x, to.y, { steps: 20 });
  if (!step.drag.hold) await page.mouse.up();
}

/** A held hotkey: a mouse button the registry names, or a keyboard combo in Playwright's spelling. */
async function pressCombo(page: Page, combo: string): Promise<void> {
  const mouseButtons: Record<string, 'left' | 'middle' | 'right' | 'back' | 'forward'> = { 'Mouse:Middle': 'middle', 'Mouse:Back': 'back', 'Mouse:Forward': 'forward' };
  const button = mouseButtons[combo];
  if (button) {
    const viewport = page.viewportSize();
    if (viewport) await page.mouse.move(viewport.width / 2, viewport.height / 2);
    await page.mouse.down({ button });
    return;
  }
  // Modifiers first, then the key, all left down: Playwright's `press` would release them.
  // `Mod` is Control whatever the host: the demo's bridge reports `win32` unless a scene sets
  // `__mockPlatform` (tests/ui/mock-electron-api.js), so the renderer's matcher wants ctrlKey
  // there even on a Mac, as demo/boot.js's own pressCombo already sends.
  const keyNames: Record<string, string> = { Mod: 'Control', Ctrl: 'Control', Cmd: 'Meta' };
  for (const token of combo.split('+')) await page.keyboard.down(keyNames[token] ?? token);
}

async function playStep(page: Page, step: DemoBootStep | RigStep): Promise<void> {
  if (isRigStep(step)) await playRigStep(page, step);
  else if ('press' in step) await pressCombo(page, step.press);
  else if ('type' in step) await page.locator(step.type).first().fill(step.text);
  else await page.locator(step.click).first().click();
  if (step.waitFor) await page.locator(step.waitFor).first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
}

/**
 * What a 3D view (the Knowledge Graph map) shows in place of its drawing when the browser gives it
 * no WebGL context. A poster of one is a picture of the fallback, never of the feature, so the rig
 * refuses to write it.
 */
export const NO_GPU_FALLBACKS = ['[data-testid="knowledge-graph-webgl-unavailable"]'] as const;

/** How long a scene's `settle` elements must hold still before the frame counts as settled. */
const SETTLE_QUIET_MS = 500;
/**
 * And across how many animation frames. Time alone is not enough: a stalled frame loop (a loaded
 * runner, software WebGL) lets the clock pass with no frame drawn, which would read as still.
 */
const SETTLE_QUIET_FRAMES = 10;
/**
 * The headless shell draws WebGL through SwiftShader whatever the machine (its renderer string
 * names the SwiftShader device even with a GPU present), so the poster job's Linux runner and a
 * local run take the same software path. Measured there at the rig's 2x: the Knowledge Graph's
 * camera flight settles in 1.2 to 1.8 seconds after ready. This leaves room for a slow runner.
 */
const SETTLE_TIMEOUT_MS = 15_000;

/**
 * Wait for a scene's `settle` elements (SceneBase.settle) to be shown and hold still: at least one
 * with a non-zero opacity, and no rect or opacity among them changing for SETTLE_QUIET_MS and
 * SETTLE_QUIET_FRAMES animation frames, whichever is longer. Throws when they never do, naming the
 * no-GPU card when it is up, so a poster or a smoke run fails loudly instead of capturing a map
 * mid-flight or never drawn. `timeoutMs` is for a test of the failure path, which would otherwise
 * wait out the full budget.
 */
export async function waitForSettled(page: Page, selector: string, timeoutMs: number = SETTLE_TIMEOUT_MS): Promise<void> {
  const outcome = await page.evaluate(({ selector: settleSelector, quietMs, quietFrames, timeoutMs }) => new Promise<{ settled: boolean; shown: number; count: number }>((resolve) => {
    const startedAt = performance.now();
    let previous = '';
    let quietSince = startedAt;
    let quietFrameCount = 0;
    const tick = (): void => {
      const now = performance.now();
      const elements = Array.from(document.querySelectorAll<HTMLElement>(settleSelector));
      let shown = 0;
      const signature = elements.map((element) => {
        const rect = element.getBoundingClientRect();
        const opacity = Number(getComputedStyle(element).opacity);
        if (opacity > 0) shown += 1;
        return `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)},${opacity.toFixed(2)}`;
      }).join('|');
      if (signature !== previous) {
        previous = signature;
        quietSince = now;
        quietFrameCount = 0;
      } else {
        quietFrameCount += 1;
      }
      if (shown > 0 && now - quietSince >= quietMs && quietFrameCount >= quietFrames) {
        resolve({ settled: true, shown, count: elements.length });
        return;
      }
      if (now - startedAt > timeoutMs) {
        resolve({ settled: false, shown, count: elements.length });
        return;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }), { selector, quietMs: SETTLE_QUIET_MS, quietFrames: SETTLE_QUIET_FRAMES, timeoutMs });
  if (outcome.settled) return;
  const fallbacks: string[] = [];
  for (const fallback of NO_GPU_FALLBACKS) if (await page.locator(fallback).count() > 0) fallbacks.push(fallback);
  throw new Error(
    `${selector} did not settle in ${timeoutMs / 1000}s (${outcome.count} element(s), ${outcome.shown} shown)`
    + (fallbacks.length > 0 ? `: the page shows ${fallbacks.join(', ')}, so it got no WebGL context` : ''),
  );
}

/**
 * Navigate to the scene, wait for the frame to report ready and for the scene's `ready` element,
 * and (for a driver scene) play its steps. A scene that names `settle` is waited on until its
 * moving elements hold still. Returns once the frame is the scene, fonts loaded.
 */
export async function openScene(page: Page, scene: SceneDefinition, options: OpenSceneOptions): Promise<void> {
  await page.goto(sceneUrl(scene, options));
  await expect(page.locator('html')).toHaveAttribute('data-demo-ready', '1', { timeout: READY_TIMEOUT_MS });
  if (scene.reach === 'driver') {
    for (const step of scene.steps) await playStep(page, step);
  }
  await page.locator(scene.ready).first().waitFor({ state: 'visible', timeout: STEP_TIMEOUT_MS });
  await page.evaluate(() => document.fonts.ready);
  if (scene.settle) await waitForSettled(page, scene.settle);
}

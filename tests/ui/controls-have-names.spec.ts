/**
 * Every control keeps an accessible name with no native `title` in the page.
 *
 * Chromium names an element by its `title` when nothing else names it, so an
 * icon-only button can be named by its tooltip alone. HoverTip never names its
 * trigger (the trigger keeps its own name, and the tip only describes it), so a
 * control that leaned on that fallback goes nameless the moment its `title`
 * becomes a HoverTip. Nothing visible changes, but screen readers announce
 * "button", and every `getByRole(..., { name })` lookup on it stops matching.
 *
 * Each test turns every `title` write into a no-op before React renders, visits
 * one surface, and reads Chromium's own accessibility tree for controls that
 * have no name.
 */
import { test, expect, type Page } from '@playwright/test';
import { launchPage, createProject, createTask, waitForBoard, settleFrames } from './helpers';

test.describe.configure({ mode: 'parallel' });

/** Roles a person activates, which must say what they do. */
const CONTROL_ROLES = new Set([
  'button', 'link', 'tab', 'switch', 'checkbox', 'radio',
  'menuitem', 'menuitemcheckbox', 'menuitemradio',
]);

async function stripTitles(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const setAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function setAttributeWithoutTitle(this: Element, name: string, value: string) {
      if (name.toLowerCase() === 'title') return;
      setAttribute.call(this, name, value);
    };
    Object.defineProperty(HTMLElement.prototype, 'title', {
      configurable: true,
      get: () => '',
      set: () => {},
    });
  });
}

async function launchWithoutTitles() {
  const launched = await launchPage({ beforeLoad: stripTitles });
  // Both write paths are dead, or a nameless control would borrow its title and pass.
  const probe = await launched.page.evaluate(() => {
    const button = document.createElement('button');
    button.setAttribute('title', 'by attribute');
    button.title = 'by property';
    return [button.hasAttribute('title'), button.title];
  });
  expect(probe).toEqual([false, '']);
  return launched;
}

/** Rendered controls with no accessible name, described for the failure message. */
async function namelessControls(page: Page): Promise<string[]> {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('DOM.enable');
    await session.send('Accessibility.enable');
    const { nodes } = await session.send('Accessibility.getFullAXTree');
    const offenders: string[] = [];
    for (const node of nodes) {
      if (node.ignored) continue;
      const role = node.role?.value;
      if (typeof role !== 'string' || !CONTROL_ROLES.has(role)) continue;
      const name = node.name?.value;
      if (typeof name === 'string' && name.trim() !== '') continue;
      if (node.backendDOMNodeId === undefined) {
        offenders.push(`${role} (no DOM node)`);
        continue;
      }
      const { object } = await session.send('DOM.resolveNode', { backendNodeId: node.backendDOMNodeId });
      const { result } = await session.send('Runtime.callFunctionOn', {
        objectId: object.objectId,
        returnByValue: true,
        functionDeclaration: `function describe() {
          const host = this.closest('[data-testid]');
          const where = host ? 'in [data-testid="' + host.getAttribute('data-testid') + '"] ' : '';
          return where + this.outerHTML.slice(0, 200);
        }`,
      });
      offenders.push(`${role}: ${String(result.value)}`);
    }
    return offenders;
  } finally {
    await session.detach();
  }
}

async function expectAllControlsNamed(page: Page, surface: string): Promise<void> {
  // The renderer writes no native title (tests/unit/native-title.test.ts), and the strip catches
  // any a library or a dev overlay writes, so a title surviving here means the strip broke.
  expect(await page.locator('[title]').count(), `${surface}: a native title survived the strip`).toBe(0);
  const offenders = await namelessControls(page);
  expect(offenders, `${surface}: controls with no accessible name once title is gone`).toEqual([]);
}

test('board, sidebar and title bar', async () => {
  const { browser, page } = await launchWithoutTitles();
  try {
    await createProject(page, `Names board ${Date.now()}`);
    await createTask(page, 'Names board task');
    await waitForBoard(page);
    await expectAllControlsNamed(page, 'board');
  } finally {
    await browser.close();
  }
});

test('task detail', async () => {
  const { browser, page } = await launchWithoutTitles();
  try {
    await createProject(page, `Names detail ${Date.now()}`);
    await createTask(page, 'Names detail task');
    await page.locator('text=Names detail task').first().click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 5000 });
    await expectAllControlsNamed(page, 'task detail');
  } finally {
    await browser.close();
  }
});

test('every settings tab', async () => {
  const { browser, page } = await launchWithoutTitles();
  try {
    await createProject(page, `Names settings ${Date.now()}`);
    await page.locator('[data-testid="settings-button"]').click();
    const tabs = page.locator('[data-testid="settings-tab-list"] [data-testid^="settings-tab-"]');
    await tabs.first().waitFor({ state: 'visible', timeout: 5000 });
    const tabIds = await tabs.evaluateAll((elements) => elements.map((element) => element.getAttribute('data-testid') ?? ''));
    expect(tabIds.length).toBeGreaterThan(10);
    for (const tabId of tabIds) {
      await page.locator(`[data-testid="${tabId}"]`).click();
      await settleFrames(page);
      await expectAllControlsNamed(page, tabId);
    }
  } finally {
    await browser.close();
  }
});

test('backlog, workflows and monitor', async () => {
  const { browser, page } = await launchWithoutTitles();
  try {
    await createProject(page, `Names views ${Date.now()}`);
    await page.locator('[data-testid="view-toggle-backlog"]').click();
    await page.locator('[data-testid="new-backlog-task-btn"]').waitFor({ state: 'visible', timeout: 5000 });
    await expectAllControlsNamed(page, 'backlog');

    await page.locator('[data-testid="view-toggle-workflows"]').click();
    await settleFrames(page);
    await expectAllControlsNamed(page, 'workflows');

    await page.locator('[data-testid="agent-monitor-button"]').click();
    await page.locator('[data-testid="monitor-grid"]').waitFor({ state: 'visible', timeout: 10000 });
    await expectAllControlsNamed(page, 'monitor');
  } finally {
    await browser.close();
  }
});

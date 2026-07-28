/**
 * UI tests for the per-project Command Terminal indicator in the project sidebar.
 *
 * Command Terminal PTYs stay alive when the layer is hidden AND across project
 * switches, so before this indicator the only signal that a project still had
 * terminals running was the title-bar glyph, which only ever reflects the project
 * you are currently looking at. These tests pin the two properties that make the
 * sidebar version trustworthy:
 *
 * - It reads the unscoped session list, so a BACKGROUND project's terminals show
 *   up without visiting that project's board.
 * - It sits beside the agent thinking/idle counts without disturbing them: a
 *   Command Terminal is not a task agent, and the two must read side by side.
 */
import { test, expect } from '@playwright/test';
import { chromium, type Browser, type Page } from '@playwright/test';
import path from 'node:path';
import { waitForViteReady } from './helpers';

// Each test launches its own browser/page, so the file can fan out across workers.
test.describe.configure({ mode: 'parallel' });

const MOCK_SCRIPT = path.join(__dirname, 'mock-electron-api.js');
const VITE_URL = `http://localhost:${process.env.PLAYWRIGHT_VITE_PORT || '5173'}`;

const PROJECT_A_ID = 'ct-proj-a';
const PROJECT_B_ID = 'ct-proj-b';

interface TerminalFixture {
  /** Project the transient PTY belongs to. */
  project: string;
  id: string;
  activity?: 'idle' | 'thinking' | 'permission';
  status?: 'running' | 'exited';
}

/**
 * Two projects (Alpha active, Beta background) plus whatever transient sessions
 * the test needs. `agentIdleOnAlpha` adds a NON-transient idle session so a test
 * can assert the agent counts and the terminal indicator coexist.
 */
function preConfig(options?: {
  terminals?: TerminalFixture[];
  agentIdleOnAlpha?: boolean;
}): string {
  const terminals = options?.terminals ?? [];
  const agentIdleOnAlpha = options?.agentIdleOnAlpha ?? false;
  const terminalScript = terminals.map((terminal) => `
      state.sessions.push({
        id: '${terminal.id}',
        taskId: 'task-${terminal.id}',
        projectId: '${terminal.project}',
        pid: 2001,
        status: '${terminal.status ?? 'running'}',
        shell: 'bash',
        cwd: '/mock/project',
        startedAt: ts,
        exitCode: null,
        transient: true,
      });
      ${terminal.activity ? `state.activityCache['${terminal.id}'] = '${terminal.activity}';` : ''}
  `).join('\n');

  return `
    window.__mockPreConfigure(function (state) {
      var ts = new Date().toISOString();

      state.projects.push({
        id: '${PROJECT_A_ID}',
        name: 'Project Alpha',
        path: '/mock/project-alpha',
        github_url: null,
        default_agent: 'claude',
        group_id: null,
        position: 0,
        last_opened: ts,
        created_at: ts,
      });

      state.projects.push({
        id: '${PROJECT_B_ID}',
        name: 'Project Beta',
        path: '/mock/project-beta',
        github_url: null,
        default_agent: 'claude',
        group_id: null,
        position: 1,
        last_opened: ts,
        created_at: ts,
      });

      state.DEFAULT_SWIMLANES.forEach(function (s, i) {
        state.swimlanes.push(Object.assign({}, s, {
          id: 'ct-lane-' + i,
          position: i,
          created_at: ts,
        }));
      });

      ${agentIdleOnAlpha ? `
      state.sessions.push({
        id: 'ct-agent-a',
        taskId: 'ct-task-agent-a',
        projectId: '${PROJECT_A_ID}',
        pid: 1001,
        status: 'running',
        shell: 'bash',
        cwd: '/mock/project-alpha',
        startedAt: ts,
        exitCode: null,
      });
      state.activityCache['ct-agent-a'] = 'idle';
      ` : ''}

      ${terminalScript}

      return { currentProjectId: '${PROJECT_A_ID}' };
    });
  `;
}

async function launchWithState(preConfigScript: string): Promise<{ browser: Browser; page: Page }> {
  await waitForViteReady(VITE_URL);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
  const page = await context.newPage();

  await page.addInitScript({ path: MOCK_SCRIPT });
  await page.addInitScript(preConfigScript);

  await page.goto(VITE_URL);
  await page.waitForLoadState('load');
  await page.waitForSelector('text=Kangentic', { timeout: 15000 });
  await page.locator('[data-swimlane-name="To Do"]').waitFor({ state: 'visible', timeout: 15000 });

  return { browser, page };
}

test.describe('Sidebar Command Terminal indicator', () => {
  test('no indicator for a project with no Command Terminals', async () => {
    const { browser, page } = await launchWithState(preConfig());

    try {
      await expect(page.locator(`[data-testid="project-terminals-${PROJECT_A_ID}"]`)).toHaveCount(0);
      await expect(page.locator(`[data-testid="project-terminals-${PROJECT_B_ID}"]`)).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('a single terminal renders the glyph with its count', async () => {
    const { browser, page } = await launchWithState(preConfig({
      terminals: [{ project: PROJECT_A_ID, id: 'ct-a1', activity: 'idle' }],
    }));

    try {
      const indicator = page.locator(`[data-testid="project-terminals-${PROJECT_A_ID}"]`);
      await expect(indicator).toBeVisible();
      await expect(indicator).toHaveAttribute('data-count', '1');
      // The digit prints even at 1, so this reads as an icon+digit pair matching the
      // agent counts beside it rather than a lone glyph missing its number.
      await expect(indicator).toHaveText('1');
      await expect(indicator.locator(`[data-testid="project-terminal-icon-${PROJECT_A_ID}"]`)).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('two terminals render a count digit', async () => {
    const { browser, page } = await launchWithState(preConfig({
      terminals: [
        { project: PROJECT_A_ID, id: 'ct-a1', activity: 'idle' },
        { project: PROJECT_A_ID, id: 'ct-a2', activity: 'idle' },
      ],
    }));

    try {
      const indicator = page.locator(`[data-testid="project-terminals-${PROJECT_A_ID}"]`);
      await expect(indicator).toHaveAttribute('data-count', '2');
      await expect(indicator).toHaveText('2');
    } finally {
      await browser.close();
    }
  });

  test('tone is amber when a terminal needs the user', async () => {
    const { browser, page } = await launchWithState(preConfig({
      terminals: [{ project: PROJECT_A_ID, id: 'ct-a1', activity: 'idle' }],
    }));

    try {
      const indicator = page.locator(`[data-testid="project-terminals-${PROJECT_A_ID}"]`);
      await expect(indicator).toHaveAttribute('data-activity', 'idle');
      await expect(indicator.locator('svg.text-attention')).toHaveCount(1);
    } finally {
      await browser.close();
    }
  });

  test('a permission-blocked terminal reads as needing the user, not working', async () => {
    const { browser, page } = await launchWithState(preConfig({
      terminals: [{ project: PROJECT_A_ID, id: 'ct-a1', activity: 'permission' }],
    }));

    try {
      const indicator = page.locator(`[data-testid="project-terminals-${PROJECT_A_ID}"]`);
      await expect(indicator).toHaveAttribute('data-activity', 'idle');
    } finally {
      await browser.close();
    }
  });

  test('working wins over needs-you across a project\'s terminals', async () => {
    const { browser, page } = await launchWithState(preConfig({
      terminals: [
        { project: PROJECT_A_ID, id: 'ct-a1', activity: 'idle' },
        { project: PROJECT_A_ID, id: 'ct-a2', activity: 'thinking' },
      ],
    }));

    try {
      const indicator = page.locator(`[data-testid="project-terminals-${PROJECT_A_ID}"]`);
      await expect(indicator).toHaveAttribute('data-activity', 'thinking');
      await expect(indicator.locator('svg.text-active')).toHaveCount(1);
    } finally {
      await browser.close();
    }
  });

  test('a live terminal with no activity yet still shows, at rest', async () => {
    // Presence is the point: a resting terminal is exactly the invisible
    // CPU/memory consumer this indicator exists to surface.
    const { browser, page } = await launchWithState(preConfig({
      terminals: [{ project: PROJECT_A_ID, id: 'ct-a1' }],
    }));

    try {
      const indicator = page.locator(`[data-testid="project-terminals-${PROJECT_A_ID}"]`);
      await expect(indicator).toBeVisible();
      await expect(indicator).toHaveAttribute('data-activity', 'rest');
    } finally {
      await browser.close();
    }
  });

  test('an exited terminal does not count', async () => {
    const { browser, page } = await launchWithState(preConfig({
      terminals: [{ project: PROJECT_A_ID, id: 'ct-a1', activity: 'idle', status: 'exited' }],
    }));

    try {
      await expect(page.locator(`[data-testid="project-terminals-${PROJECT_A_ID}"]`)).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('a background project\'s terminals are visible without switching to it', async () => {
    // The whole point of the feature: Alpha is active, Beta's PTYs are running
    // invisibly, and the sidebar says so.
    const { browser, page } = await launchWithState(preConfig({
      terminals: [
        { project: PROJECT_B_ID, id: 'ct-b1', activity: 'thinking' },
        { project: PROJECT_B_ID, id: 'ct-b2', activity: 'idle' },
      ],
    }));

    try {
      const betaIndicator = page.locator(`[data-testid="project-terminals-${PROJECT_B_ID}"]`);
      await expect(betaIndicator).toBeVisible();
      await expect(betaIndicator).toHaveAttribute('data-count', '2');
      await expect(betaIndicator).toHaveAttribute('data-activity', 'thinking');
      // Alpha has none of its own.
      await expect(page.locator(`[data-testid="project-terminals-${PROJECT_A_ID}"]`)).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('terminal indicator and agent counts read side by side', async () => {
    const { browser, page } = await launchWithState(preConfig({
      agentIdleOnAlpha: true,
      terminals: [{ project: PROJECT_A_ID, id: 'ct-a1', activity: 'thinking' }],
    }));

    try {
      const alphaRow = page.locator('[role="button"]:has-text("Project Alpha")');

      // The agent count is unchanged by the presence of a terminal: still one
      // amber idle agent, and no green agent count.
      const idleCountSpan = alphaRow.locator('span.text-attention');
      await expect(idleCountSpan).toBeVisible();
      await expect(idleCountSpan).toContainText('1');
      await expect(alphaRow.locator('span.text-active')).toHaveCount(0);

      // ...while the terminal indicator sits beside it with its own tone.
      const indicator = alphaRow.locator(`[data-testid="project-terminals-${PROJECT_A_ID}"]`);
      await expect(indicator).toHaveAttribute('data-activity', 'thinking');
    } finally {
      await browser.close();
    }
  });

  test('clicking a background project\'s indicator switches project and opens the layer', async () => {
    const { browser, page } = await launchWithState(preConfig({
      terminals: [{ project: PROJECT_B_ID, id: 'ct-b1', activity: 'idle' }],
    }));

    try {
      await page.locator(`[data-testid="project-terminals-${PROJECT_B_ID}"]`).click();

      await expect.poll(async () => {
        return page.evaluate(async () => {
          const project = await window.electronAPI.projects.getCurrent();
          return project?.id ?? null;
        });
      }, { timeout: 5000 }).toBe(PROJECT_B_ID);

      // "New terminal" renders only while the Command Terminal layer is open, so
      // its presence is the cheap signal that the layer reopened on the new project.
      await expect(page.locator('[data-testid="quick-session-new-terminal"]')).toBeVisible({ timeout: 5000 });
    } finally {
      await browser.close();
    }
  });

  test('clicking the ACTIVE project\'s indicator opens the layer without a project switch', async () => {
    // The common case: you are already on the project. No openProject call, so the
    // pending-open flag alone has to reach useCommandBar's effect.
    const { browser, page } = await launchWithState(preConfig({
      terminals: [{ project: PROJECT_A_ID, id: 'ct-a1', activity: 'idle' }],
    }));

    try {
      await page.locator(`[data-testid="project-terminals-${PROJECT_A_ID}"]`).click();

      await expect(page.locator('[data-testid="quick-session-new-terminal"]')).toBeVisible({ timeout: 5000 });

      // Still on the same project - the click must not have re-opened anything.
      const currentProjectId = await page.evaluate(async () => {
        const project = await window.electronAPI.projects.getCurrent();
        return project?.id ?? null;
      });
      expect(currentProjectId).toBe(PROJECT_A_ID);
    } finally {
      await browser.close();
    }
  });

  test('clicking the indicator does not trigger the row rename or context menu', async () => {
    // The row is a dnd-kit sortable with its own onClick; the indicator has to
    // stop propagation or a click would also re-select the row.
    const { browser, page } = await launchWithState(preConfig({
      terminals: [{ project: PROJECT_A_ID, id: 'ct-a1', activity: 'idle' }],
    }));

    try {
      await page.locator(`[data-testid="project-terminals-${PROJECT_A_ID}"]`).click();
      await expect(page.locator('[data-testid="project-context-menu"]')).toHaveCount(0);
      await expect(page.locator(`[data-testid="project-terminals-${PROJECT_A_ID}"]`)).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('clicking a background project\'s indicator calls openProject exactly once', async () => {
    // Pins the stopPropagation guard on the indicator's onClick/onPointerDown.
    // ProjectListItem's row has onSelect={openProject}; without the guard, a
    // click on the indicator bubbles to the row (which calls openProject once)
    // AND runs handleOpenCommandTerminals (which calls openProject again for a
    // background project), firing two concurrent opens instead of one.
    const { browser, page } = await launchWithState(preConfig({
      terminals: [{ project: PROJECT_B_ID, id: 'ct-b1', activity: 'idle' }],
    }));

    try {
      await page.evaluate(() => {
        window.electronAPI.projects.__openCalls.length = 0;
      });

      await page.locator(`[data-testid="project-terminals-${PROJECT_B_ID}"]`).click();

      await expect.poll(async () => {
        return page.evaluate(async () => {
          const project = await window.electronAPI.projects.getCurrent();
          return project?.id ?? null;
        });
      }, { timeout: 5000 }).toBe(PROJECT_B_ID);

      const openCalls = await page.evaluate(() => window.electronAPI.projects.__openCalls as string[]);
      expect(openCalls).toEqual([PROJECT_B_ID]);
    } finally {
      await browser.close();
    }
  });

  test('the sidebar renders the terminal icon at 14px, not the title bar\'s default 20px', async () => {
    // CommandTerminalIcon defaults size to 20 (the title bar toggle); the
    // sidebar passes size={14} explicitly. Pins that the prop is actually
    // threaded through rather than the icon silently rendering at the default.
    const { browser, page } = await launchWithState(preConfig({
      terminals: [{ project: PROJECT_A_ID, id: 'ct-a1', activity: 'idle' }],
    }));

    try {
      const icon = page.locator(`[data-testid="project-terminal-icon-${PROJECT_A_ID}"]`);
      await expect(icon).toHaveAttribute('width', '14');
      await expect(icon).toHaveAttribute('height', '14');
    } finally {
      await browser.close();
    }
  });

  test('labelFor pins the singular noun and "needs you" wording for a lone idle terminal', async () => {
    const { browser, page } = await launchWithState(preConfig({
      terminals: [{ project: PROJECT_A_ID, id: 'ct-a1', activity: 'idle' }],
    }));

    try {
      const indicator = page.locator(`[data-testid="project-terminals-${PROJECT_A_ID}"]`);
      await expect(indicator).toHaveAttribute('aria-label', /1 Command Terminal running \(needs you\)/);
      await expect(indicator).toHaveAttribute('title', /1 Command Terminal running \(needs you\)/);
    } finally {
      await browser.close();
    }
  });

  test('labelFor pins the plural noun and "working" wording for two thinking terminals', async () => {
    const { browser, page } = await launchWithState(preConfig({
      terminals: [
        { project: PROJECT_A_ID, id: 'ct-a1', activity: 'thinking' },
        { project: PROJECT_A_ID, id: 'ct-a2', activity: 'thinking' },
      ],
    }));

    try {
      const indicator = page.locator(`[data-testid="project-terminals-${PROJECT_A_ID}"]`);
      await expect(indicator).toHaveAttribute('aria-label', /2 Command Terminals running \(working\)/);
    } finally {
      await browser.close();
    }
  });

  test('labelFor says "resting", never "idle", for a terminal with no activity yet (red-green for FIX A)', async () => {
    // FIX A: the rest branch used to render the word "idle", which is this
    // app's word for "needs you". A lone resting terminal must not read as
    // needing the user. This fails if the rest branch regresses to "idle".
    const { browser, page } = await launchWithState(preConfig({
      terminals: [{ project: PROJECT_A_ID, id: 'ct-a1' }],
    }));

    try {
      const indicator = page.locator(`[data-testid="project-terminals-${PROJECT_A_ID}"]`);
      await expect(indicator).toHaveAttribute('aria-label', /1 Command Terminal running \(resting\)/);
      const ariaLabel = await indicator.getAttribute('aria-label');
      expect(ariaLabel).not.toContain('idle');
    } finally {
      await browser.close();
    }
  });
});

test.describe('Collapsed rail Command Terminal dot', () => {
  async function collapseSidebar(page: Page): Promise<void> {
    await page.locator('button[title^="Hide sidebar"]').click();
    await page.locator('[data-testid="sidebar-expand-button"]').waitFor({ state: 'attached', timeout: 5000 });
  }

  test('a project with terminals gets a tone dot; one without does not', async () => {
    const { browser, page } = await launchWithState(preConfig({
      terminals: [{ project: PROJECT_B_ID, id: 'ct-b1', activity: 'thinking' }],
    }));

    try {
      await collapseSidebar(page);

      const betaDot = page.locator(`[data-testid="rail-project-terminals-${PROJECT_B_ID}"]`);
      await expect(betaDot).toBeVisible();
      await expect(betaDot).toHaveAttribute('data-activity', 'thinking');
      await expect(betaDot).toHaveClass(/bg-active/);

      await expect(page.locator(`[data-testid="rail-project-terminals-${PROJECT_A_ID}"]`)).toHaveCount(0);
    } finally {
      await browser.close();
    }
  });

  test('the rail dot is a plain span, never the arc-bearing glyph', async () => {
    // The rail deliberately carries no icon: at 28px a partial-arc glyph reads as
    // a broken icon overflowing the project initial. The dot must not reintroduce
    // one, and must not shadow the agent-activity absence assertions either.
    const { browser, page } = await launchWithState(preConfig({
      terminals: [{ project: PROJECT_A_ID, id: 'ct-a1', activity: 'idle' }],
    }));

    try {
      await collapseSidebar(page);

      const alphaButton = page.locator(`[data-testid="rail-project-${PROJECT_A_ID}"]`);
      await expect(alphaButton.locator('svg.text-attention')).toHaveCount(0);
      await expect(alphaButton.locator('svg.text-active')).toHaveCount(0);
      await expect(alphaButton.locator(`[data-testid="rail-project-terminals-${PROJECT_A_ID}"]`)).toBeVisible();
    } finally {
      await browser.close();
    }
  });

  test('the rail tooltip stays the plain project name', async () => {
    // Guards the existing regression rule: the title must not grow a compound
    // "Alpha - 1 terminal" form. Terminal state rides on aria-label instead.
    const { browser, page } = await launchWithState(preConfig({
      terminals: [{ project: PROJECT_A_ID, id: 'ct-a1', activity: 'idle' }],
    }));

    try {
      await collapseSidebar(page);

      const alphaButton = page.locator(`[data-testid="rail-project-${PROJECT_A_ID}"]`);
      await expect(alphaButton).toHaveAttribute('title', 'Project Alpha');
      await expect(alphaButton).toHaveAttribute('aria-label', /Project Alpha.*Command Terminals/);
    } finally {
      await browser.close();
    }
  });

  test('a resting terminal gets the muted rail dot', async () => {
    // RAIL_DOT_CLASS.rest had zero direct coverage: the existing rest-tone test
    // ('the rail dot is a plain span...') only asserts the absence of an icon,
    // not this dot's own color class.
    const { browser, page } = await launchWithState(preConfig({
      terminals: [{ project: PROJECT_B_ID, id: 'ct-b1' }],
    }));

    try {
      await collapseSidebar(page);

      const betaDot = page.locator(`[data-testid="rail-project-terminals-${PROJECT_B_ID}"]`);
      await expect(betaDot).toBeVisible();
      await expect(betaDot).toHaveAttribute('data-activity', 'rest');
      await expect(betaDot).toHaveClass(/bg-fg-muted/);
    } finally {
      await browser.close();
    }
  });

  test('a needs-you terminal gets the amber rail dot', async () => {
    // RAIL_DOT_CLASS.idle had zero direct coverage; mirrors the existing
    // thinking-tone test's toHaveClass(/bg-active/) assertion.
    const { browser, page } = await launchWithState(preConfig({
      terminals: [{ project: PROJECT_B_ID, id: 'ct-b1', activity: 'idle' }],
    }));

    try {
      await collapseSidebar(page);

      const betaDot = page.locator(`[data-testid="rail-project-terminals-${PROJECT_B_ID}"]`);
      await expect(betaDot).toBeVisible();
      await expect(betaDot).toHaveAttribute('data-activity', 'idle');
      await expect(betaDot).toHaveClass(/bg-attention/);
    } finally {
      await browser.close();
    }
  });

  test('the rail aria-label speaks "needs you" for an idle terminal (red-green for FIX B)', async () => {
    // FIX B: the rail button's aria-label used to be the tone-blind
    // "<name>, Command Terminals running". It now speaks the tone via
    // RAIL_TERMINAL_LABEL. This fails if the label regresses to the
    // tone-blind string. title stays the bare project name either way.
    const { browser, page } = await launchWithState(preConfig({
      terminals: [{ project: PROJECT_A_ID, id: 'ct-a1', activity: 'idle' }],
    }));

    try {
      await collapseSidebar(page);

      const alphaButton = page.locator(`[data-testid="rail-project-${PROJECT_A_ID}"]`);
      await expect(alphaButton).toHaveAttribute('title', 'Project Alpha');
      await expect(alphaButton).toHaveAttribute(
        'aria-label',
        /Project Alpha, Command Terminals running \(needs you\)/,
      );
    } finally {
      await browser.close();
    }
  });

  test('the rail aria-label speaks "working" for a thinking terminal', async () => {
    const { browser, page } = await launchWithState(preConfig({
      terminals: [{ project: PROJECT_A_ID, id: 'ct-a1', activity: 'thinking' }],
    }));

    try {
      await collapseSidebar(page);

      const alphaButton = page.locator(`[data-testid="rail-project-${PROJECT_A_ID}"]`);
      await expect(alphaButton).toHaveAttribute('title', 'Project Alpha');
      await expect(alphaButton).toHaveAttribute('aria-label', /\(working\)/);
    } finally {
      await browser.close();
    }
  });
});

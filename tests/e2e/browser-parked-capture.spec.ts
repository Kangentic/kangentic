/**
 * E2E coverage: an agent's screenshot of a pane whose window is born parked
 * (Sentry DESKTOP-46 on Linux).
 *
 * `kangentic_browser_open_pane` on a task with no window mounts one PARKED:
 * in the DOM, at `opacity: 0`, with nothing on screen
 * (`.claude/rules/agent-driven-focus.md`). A capture of that guest needs the
 * hold in `src/main/browser/cdp/guest-capture-hold.ts` to keep the guest and
 * the host compositor drawing. Two 0.61.0 events from one Debian install timed
 * out on exactly this surface (`surface=parked`, `guest_hold=none`), and every
 * earlier measurement of it was Windows.
 *
 * The wiring only this tier has: a live `<webview>` guest in a born-parked
 * window, captured through the real MCP tool as the task's own agent. The unit
 * tier has no composited guest. CI runs this under xvfb, which is X11 with no
 * compositor, so it is the X11 measurement and says nothing about Wayland
 * (decision 44 in `docs/architecture/embedded-browser/decision-log.md`).
 *
 * The page repaints every frame, so a capture cannot pass on a frame drawn
 * before the window parked. A second case is the control: the user opens the
 * task, the same window un-parks with the same guest, and the capture runs on
 * a showing pane (`surface=pane`).
 *
 * Network-free: the page is served from a loopback server the test owns.
 */
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Page } from '@playwright/test';
import { test, expect } from './shared-app';
import { createTask, getTaskIdByTitle } from './helpers';
import type { Session } from '../../src/shared/types';

const runId = Date.now();

/** A page that changes colour every frame, so only a fresh frame can be captured. */
const PAINTING_PAGE = `<!doctype html><html><body style="margin:0">
<div id="swatch" style="width:100vw;height:100vh"></div>
<script>
  let frame = 0;
  const swatch = document.getElementById('swatch');
  const paint = () => {
    frame += 1;
    swatch.style.background = 'hsl(' + (frame % 360) + ', 70%, 50%)';
    requestAnimationFrame(paint);
  };
  requestAnimationFrame(paint);
</script></body></html>`;

async function startPageServer(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(PAINTING_PAGE);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function dragTaskToColumn(page: Page, taskTitle: string, targetColumn: string): Promise<void> {
  const card = page.locator('[data-testid="swimlane"]').locator(`text=${taskTitle}`).first();
  await card.waitFor({ state: 'visible', timeout: 5000 });
  const target = page.locator(`[data-swimlane-name="${targetColumn}"]`);
  await target.waitFor({ state: 'visible', timeout: 5000 });

  const cardBox = await card.boundingBox();
  const targetBox = await target.boundingBox();
  if (!cardBox || !targetBox) throw new Error('Could not get bounding boxes');

  await page.mouse.move(cardBox.x + cardBox.width / 2, cardBox.y + cardBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(cardBox.x + 10, cardBox.y, { steps: 3 });
  await page.waitForTimeout(100);
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + 80, { steps: 15 });
  await page.waitForTimeout(200);
  await page.mouse.up();
  await page.waitForTimeout(500);
}

/** The running session of one task: the agent `open_pane` serves. */
async function runningSessionIdFor(page: Page, taskId: string): Promise<string> {
  let sessionId: string | null = null;
  await expect.poll(async () => {
    sessionId = await page.evaluate(async (id: string) => {
      const sessions: Session[] = await window.electronAPI.sessions.list();
      return sessions.find((session) => session.taskId === id && session.status === 'running')?.id ?? null;
    }, taskId);
    return sessionId;
  }, { timeout: 15000 }).not.toBeNull();
  if (!sessionId) throw new Error(`No running session for task ${taskId}`);
  return sessionId;
}

/**
 * Connect as the task's own agent. `open_pane` is caller-scoped and takes no
 * task id, so the URL has to name the session (`/mcp/<projectId>/<sessionId>`,
 * `src/main/agent/mcp-http/caller-url.ts`), as the agent's own `mcp.json` does.
 */
async function connectAsSession(projectDir: string, sessionId: string): Promise<Client> {
  const configPath = path.join(projectDir, '.kangentic', 'mcp-config.json');
  await expect.poll(() => fs.existsSync(configPath), { timeout: 10000 }).toBe(true);
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
    mcpServers: { kangentic: { url: string; headers: Record<string, string> } };
  };
  const server = config.mcpServers.kangentic;
  const transport = new StreamableHTTPClientTransport(new URL(`${server.url}/${sessionId}`), {
    requestInit: { headers: server.headers },
  });
  const client = new Client({ name: 'e2e-parked-capture', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

interface ToolOutcome {
  isError: boolean;
  text: string;
  imageCount: number;
}

async function callTool(client: Client, name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const result = await client.callTool({ name, arguments: args });
  const content = (result.content ?? []) as Array<{ type: string; text?: string }>;
  return {
    isError: result.isError === true,
    text: content.filter((part) => part.type === 'text').map((part) => part.text ?? '').join(' '),
    // A large capture is written to a file and comes back as a link to it.
    imageCount: content.filter((part) => part.type === 'image' || part.type === 'resource_link').length,
  };
}

async function paneVisibility(client: Client, taskId: string): Promise<string | null> {
  const listed = await callTool(client, 'kangentic_browser_list_panes', {});
  const payload = JSON.parse(listed.text) as { panes: Array<{ taskId: string; visibility?: string }> };
  return payload.panes.find((pane) => pane.taskId === taskId)?.visibility ?? null;
}

/** Whether the task's detail window is mounted but hidden, as a parked window is (`WindowFrame.tsx`). */
async function detailWindowIsHidden(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const dialog = document.querySelector('[data-testid="task-detail-dialog"]');
    return dialog !== null && dialog.closest('[aria-hidden="true"]') !== null;
  });
}

/** The capture bound is 5 s (`SCREENSHOT_TIMEOUT_MS`); this sits above it so a timeout reports as itself. */
const CAPTURE_WAIT_MS = 8000;

async function captureWithin(client: Client): Promise<{ outcome: ToolOutcome; elapsedMs: number }> {
  const startedAt = Date.now();
  const outcome = await Promise.race([
    callTool(client, 'kangentic_browser_screenshot', {}),
    new Promise<never>((_resolve, reject) => {
      setTimeout(() => reject(new Error(`kangentic_browser_screenshot did not return within ${CAPTURE_WAIT_MS} ms`)), CAPTURE_WAIT_MS);
    }),
  ]);
  return { outcome, elapsedMs: Date.now() - startedAt };
}

test.describe('Screenshot of a born-parked Browser pane', () => {
  test('captures a pane whose window was born parked, and the same pane once the user shows it', async ({ freshProject }) => {
    const { page, tmpDir } = freshProject;
    const pageServer = await startPageServer();
    const title = `Parked Capture ${runId}`;
    await createTask(page, title, 'parked capture');
    await dragTaskToColumn(page, title, 'Code Review');
    const taskId = await getTaskIdByTitle(page, title);
    const sessionId = await runningSessionIdFor(page, taskId);

    const client = await connectAsSession(tmpDir, sessionId);
    try {
      // The task's window was never opened, so the pane mounts born parked.
      const opened = await callTool(client, 'kangentic_browser_open_pane', {
        url: pageServer.url,
        purpose: 'for-user',
        reason: 'checking a parked capture',
      });
      expect(opened.isError, opened.text).toBe(false);
      // Asserted before the capture, so a change that shows the window cannot
      // quietly turn this case into the control below.
      await expect.poll(() => paneVisibility(client, taskId), { timeout: 10000 }).toBe('parked');
      // The parked window stays mounted at `opacity: 0`, which Playwright counts
      // as visible, so read the frame's own hidden marker instead.
      await expect.poll(() => detailWindowIsHidden(page)).toBe(true);

      const parked = await captureWithin(client);
      test.info().annotations.push({ type: 'parked-capture-ms', description: String(parked.elapsedMs) });
      expect(parked.outcome.isError, parked.outcome.text).toBe(false);
      expect(parked.outcome.imageCount).toBe(1);

      // Control: the user opens the task, which un-parks the same window.
      await page.locator('[data-swimlane-name="Code Review"]').locator(`text=${title}`).first().click();
      await expect.poll(() => detailWindowIsHidden(page)).toBe(false);
      await expect.poll(() => paneVisibility(client, taskId), { timeout: 10000 }).toBe('showing');

      const showing = await captureWithin(client);
      test.info().annotations.push({ type: 'showing-capture-ms', description: String(showing.elapsedMs) });
      expect(showing.outcome.isError, showing.outcome.text).toBe(false);
      expect(showing.outcome.imageCount).toBe(1);
    } finally {
      await client.close();
      await pageServer.close();
    }
  });
});

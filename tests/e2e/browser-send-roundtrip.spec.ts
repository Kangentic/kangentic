/**
 * E2E coverage: BrowserPane Send button -> paste-engine -> mock-claude
 * round-trip.
 *
 * Drives the real Electron <webview>, real PTY, and real paste-engine. The
 * webview's initial src is a data: URL, which the main-process hardening
 * rewrites to about:blank (will-attach-webview policy). That is fine for
 * coverage purposes -- capturePage() works on about:blank, returning a
 * blank PNG. The point of the test is the IPC -> file -> paste-engine ->
 * mock-claude PTY chain, not the rendered page content.
 *
 * Migrated to shared-app fixture (2026-06-08): boots once per worker instead
 * of once per spec file, saving ~3-5s of Electron launch overhead.
 */
import { test, expect } from './shared-app';
import {
  createTask,
  waitForRunningSession,
  waitForTaskScrollback,
  getTaskIdByTitle,
} from './helpers';
import type { Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';

const runId = Date.now();

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

/**
 * Wait until the Browser pane's guest answers a script, which needs it attached
 * and past dom-ready, and which is what Send itself needs.
 *
 * The loading cover is not proof the guest is up: BrowserPane lifts it on
 * dom-ready or on a 2.5s fallback timer, so on a slow runner it lifts before
 * the guest has attached. Send then runs capturePage() and executeJavaScript()
 * on an unattached <webview>, which throws. handleSend reports that as a toast
 * and pastes nothing, and a test learns of it only when its scrollback wait
 * runs out.
 */
async function waitForGuestReady(page: Page): Promise<void> {
  await expect.poll(
    () => page.evaluate(async () => {
      const webview = document.querySelector('[data-testid="browser-pane"] webview') as
        (HTMLElement & { executeJavaScript?: (code: string) => Promise<unknown> }) | null;
      if (!webview || typeof webview.executeJavaScript !== 'function') return false;
      try {
        const state = await Promise.race([
          webview.executeJavaScript('document.readyState'),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 1000)),
        ]);
        return state === 'complete' || state === 'interactive';
      } catch {
        // Thrown synchronously until the guest attaches.
        return false;
      }
    }),
    { timeout: 20000, intervals: [200, 500, 1000] },
  ).toBe(true);
}

/** How many capture PNGs Send has written under any session of the project. */
function countCapturePngs(tmpDir: string): number {
  const sessionsDir = path.join(tmpDir, '.kangentic', 'sessions');
  if (!fs.existsSync(sessionsDir)) return 0;
  let total = 0;
  for (const sessionDir of fs.readdirSync(sessionsDir)) {
    const captures = path.join(sessionsDir, sessionDir, 'captures');
    if (!fs.existsSync(captures)) continue;
    total += fs.readdirSync(captures).filter((file) => file.endsWith('.png')).length;
  }
  return total;
}

/**
 * Waits for the pasted envelope to be echoed by THIS task's agent session, and
 * on a timeout says why. A bare "Timed out waiting for scrollback" cannot tell
 * a Send that never reached main from a paste the PTY did not echo from a Send
 * that failed in the renderer, so the failure carries the pane's inline send
 * error, the capture count and the tail of the session's scrollback.
 */
async function waitForEnvelope(page: Page, tmpDir: string, taskId: string, marker: string): Promise<string> {
  try {
    const { scrollback } = await waitForTaskScrollback(page, taskId, marker, 20000);
    return scrollback;
  } catch (caught) {
    const sendError = page.locator('[data-testid="browser-send-error"]');
    const inlineError = (await sendError.count()) > 0 ? await sendError.first().innerText() : 'none';
    const tail = await page.evaluate(async (id: string) => {
      const sessions = await window.electronAPI.sessions.list();
      const session = sessions.find((candidate) => candidate.taskId === id);
      if (!session) return '(no session for the task)';
      return (await window.electronAPI.sessions.getScrollback(session.id)).slice(-600);
    }, taskId);
    const reason = caught instanceof Error ? caught.message : String(caught);
    throw new Error(
      `${reason}\ninline send error: ${inlineError}\ncapture PNGs written: ${countCapturePngs(tmpDir)}\nscrollback tail: ${tail}`,
      { cause: caught },
    );
  }
}

test.describe('Claude Agent -- Browser Send round-trip', () => {
  // Windows-only platform limitation: this test asserts the paste content
  // (`<browser_context>` envelope) appears in PTY scrollback, relying on
  // line-discipline echo of pasted bytes. ConPTY does not echo input the
  // way Linux/macOS PTYs do - it absorbs bracketed-paste markers and does
  // not surface the wrapped content as visible terminal output. The IPC
  // handler -> capture-file -> paste-engine wiring is covered at unit tier
  // (`tests/unit/browser-handler-error-translation.test.ts` and
  // `browser-capture-send-agent-cwd`); the capture-file existence path is also covered
  // by the `eats-first-cr` case in `browser-evidence-retry.spec.ts`. This
  // E2E remains valuable on POSIX PTYs to prove the full round-trip.
  test('Send composites capture and submits the prompt envelope to the agent PTY', async ({ freshProject }) => {
    test.fixme(process.platform === 'win32', 'ConPTY does not echo paste content into scrollback; round-trip covered at unit tier.');
    const { page, tmpDir } = freshProject;
    // Unique per attempt, so a CI retry on the same worker never resolves back onto the failed
    // attempt's leftover task or session (see waitForTaskScrollback).
    const title = `Browser Send ${runId} r${test.info().retry}`;
    const description = 'browser send round-trip';
    await createTask(page, title, description);
    await dragTaskToColumn(page, title, 'Code Review');
    await waitForRunningSession(page);

    const taskId = await getTaskIdByTitle(page, title);
    // A running session row only proves the PTY spawned. The paste goes into
    // the mock's terminal, so wait until the mock itself has started and
    // printed its marker. This task's own session, never another's.
    await waitForTaskScrollback(page, taskId, 'MOCK_CLAUDE_SESSION:', 20000);

    // Seed the task URL so BrowserPane skips its empty state and mounts the
    // active branch with the <webview>. data: URLs are rewritten to
    // about:blank by the main-process hardening, which is fine -- the test
    // only needs SOME page rendered so capturePage() returns a NativeImage.
    await page.evaluate(async (id: string) => {
      await window.electronAPI.browser.setTaskUrl(
        id,
        'data:text/html,<h1>kangentic-browser-send-roundtrip</h1>',
      );
    }, taskId);

    // Open the task detail dialog by clicking the card.
    const card = page
      .locator('[data-swimlane-name="Code Review"]')
      .locator(`text=${title}`)
      .first();
    await card.click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 5000 });

    // Toggle Browser pane.
    await page.locator('[data-testid="browser-toggle"]').click();
    await page.locator('[data-testid="browser-pane"]').waitFor({ state: 'visible', timeout: 5000 });

    // The loading cover lifts on the guest's first dom-ready, or on its 2.5s
    // fallback timer with no guest yet. So wait for the cover, then for the
    // guest itself, which is what capturePage() needs.
    await expect(page.locator('[data-testid="browser-pane-page-loading"]')).toHaveCount(0, { timeout: 10000 });
    await waitForGuestReady(page);

    // Click Send. Dialog has the terminal subscribed via TERMINAL_SUBSCRIBE,
    // so the paste-engine has the session in focusedSessionIds when invoked.
    await page.locator('[data-testid="browser-send"]').click();

    // Capture file is written under <projectRoot>/.kangentic/sessions/<sid>/captures/
    await expect.poll(
      () => countCapturePngs(tmpDir),
      { timeout: 15000, intervals: [200, 500, 1000] },
    ).toBeGreaterThanOrEqual(1);

    // The paste-engine should have shipped the XML-tagged prompt to the
    // mock's PTY. Mock-claude does not interpret the prompt -- but the
    // bracketed-paste packet bytes traverse the PTY and PTY echo (line
    // discipline) reflects them in scrollback, where we can grep the XML
    // envelope tags.
    const scrollback = await waitForEnvelope(page, tmpDir, taskId, '<browser_context>');
    expect(scrollback).toContain('<browser_context>');
    expect(scrollback).toContain('<url>');
  });

  // The page layer only runs in a real guest: the UI tier's stand-in answers
  // its calls from a script. This draws one annotation over a live <webview>,
  // so the layer script is injected and answers for real, and checks the
  // numbered envelope reaches the agent.
  test('a drawn annotation goes to the agent as a numbered annotation with its note', async ({ freshProject }) => {
    test.fixme(process.platform === 'win32', 'ConPTY does not echo paste content into scrollback; covered at unit and UI tiers.');
    const { page, tmpDir } = freshProject;
    // Unique per attempt, as in the test above.
    const title = `Browser Annotate ${runId} r${test.info().retry}`;
    await createTask(page, title, 'browser annotation round-trip');
    await dragTaskToColumn(page, title, 'Code Review');
    await waitForRunningSession(page);

    const taskId = await getTaskIdByTitle(page, title);
    // The paste is echoed by the mock's terminal, so wait until the mock has
    // started and printed its marker (this task's session, not any other's).
    await waitForTaskScrollback(page, taskId, 'MOCK_CLAUDE_SESSION:', 20000);
    await page.evaluate(async (id: string) => {
      await window.electronAPI.browser.setTaskUrl(id, 'data:text/html,<h1>kangentic-browser-annotate</h1>');
    }, taskId);

    await page.locator('[data-swimlane-name="Code Review"]').locator(`text=${title}`).first().click();
    await page.locator('[data-testid="task-detail-dialog"]').waitFor({ state: 'visible', timeout: 5000 });
    await page.locator('[data-testid="browser-toggle"]').click();
    await page.locator('[data-testid="browser-pane"]').waitFor({ state: 'visible', timeout: 5000 });
    await waitForGuestReady(page);

    await page.locator('[data-testid="browser-draw-toggle"]').click();
    const box = await page.locator('[data-testid="browser-overlay"]').boundingBox();
    if (!box) throw new Error('no draw canvas');
    await page.mouse.move(box.x + 60, box.y + 160);
    await page.mouse.down();
    await page.mouse.move(box.x + 180, box.y + 220, { steps: 6 });
    await page.mouse.up();

    const note = page.locator('[data-testid="annotation-note-1"]');
    await expect(note).toBeVisible({ timeout: 5000 });
    await note.fill('kangentic-annotation-note');
    await page.locator('[data-testid="browser-send"]').click();

    // Send reached main once it wrote its screenshot. Waiting on that first
    // makes a Send that never left the pane fail here, by name, instead of as
    // a bare scrollback timeout.
    await expect.poll(
      () => countCapturePngs(tmpDir),
      { timeout: 15000, intervals: [200, 500, 1000] },
    ).toBeGreaterThanOrEqual(1);

    const scrollback = await waitForEnvelope(page, tmpDir, taskId, '<annotations');
    expect(scrollback).toContain('<annotation n="1">');
    expect(scrollback).toContain('kangentic-annotation-note');
    expect(scrollback).toContain('<drawing strokes="1"');
  });
});

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

/**
 * Wait until a capture of the guest comes back with pixels.
 *
 * `waitForGuestReady` proves the guest answers a script, not that it has painted.
 * The pane's own capture of an annotation can come back empty, or never settle,
 * while a young guest has not produced its first frame, and it gives up after a
 * fixed number of tries (`CAPTURE_ATTEMPTS` in `useBrowserAnnotations.ts`). On a
 * runner busy with other Electron instances that budget can run out before the
 * first frame, and the annotation then has no picture to save. This is the same
 * read the pane makes, so passing it means the pane's first try can succeed.
 */
async function waitForGuestPainted(page: Page): Promise<void> {
  await expect.poll(
    () => page.evaluate(async () => {
      const webview = document.querySelector('[data-testid="browser-pane"] webview') as
        (HTMLElement & { capturePage?: () => Promise<{ toDataURL: () => string }> }) | null;
      if (!webview || typeof webview.capturePage !== 'function') return false;
      try {
        const image = await Promise.race([
          webview.capturePage(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
        ]);
        if (!image) return false;
        return image.toDataURL().replace(/^data:image\/png;base64,/, '').length > 0;
      } catch {
        return false;
      }
    }),
    {
      message: 'the guest never produced a frame that a capture could read',
      timeout: 20000,
      intervals: [200, 500, 1000],
    },
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
 * How many page captures the pane has saved for a task's annotation draft
 * (`<project>/.kangentic/browser-annotations/<taskId>/capture-<id>.png`).
 *
 * Each item that joins an annotation makes the pane capture the page once and
 * save it here, so an annotation that later scrolls away still goes with a
 * picture of it. The write is atomic (a `.tmp` file, then a rename), so a name
 * matching the pattern is a finished capture. These are not the Send
 * screenshots `countCapturePngs` counts, which live under `sessions/`.
 */
function countDraftCaptures(tmpDir: string, taskId: string): number {
  const draftFolder = path.join(tmpDir, '.kangentic', 'browser-annotations', taskId);
  if (!fs.existsSync(draftFolder)) return 0;
  return fs.readdirSync(draftFolder).filter((file) => /^capture-[0-9a-f]{16}\.png$/.test(file)).length;
}

/**
 * Where a Send that has been clicked stands, as one word a failed assertion
 * can print. A bare "0 capture PNGs" cannot tell a Send that threw (the pane
 * shows its inline error) from one still waiting on the guest (the button stays
 * disabled with its spinner) from a click that did nothing at all.
 */
async function readSendOutcome(page: Page, tmpDir: string): Promise<string> {
  if (countCapturePngs(tmpDir) >= 1) return 'sent';
  const sendError = page.locator('[data-testid="browser-send-error"]');
  if ((await sendError.count()) > 0) return `error: ${await sendError.first().innerText()}`;
  const sendButton = page.locator('[data-testid="browser-send"]');
  if ((await sendButton.count()) > 0 && (await sendButton.first().isDisabled())) return 'still sending';
  return 'nothing sent';
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
    // The annotation's own capture needs a painted guest. Without this, a guest
    // that is slow to paint spends the pane's whole retry budget on empty frames.
    await waitForGuestPainted(page);

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

    // The stroke is committed once its row says it holds one drawing. Send
    // reads the session as it stands, so this is the state the click sends.
    await expect(page.locator('[data-testid="annotation-items-1"]')).toBeVisible({ timeout: 5000 });

    // Adding the stroke makes the pane capture the page for the annotation
    // (a second capturePage on the same guest, then a save). That capture runs
    // on its own timeline, so a Send clicked straight after `fill` would run
    // its own capturePage and guest scripts on top of it. Wait for it to land,
    // so the click starts a Send with nothing else in flight on the guest.
    //
    // The pane tries a capture up to four times, 3s each with 500ms between, so
    // a capture that is going to land can take about 13.5s. The bound is that
    // budget plus room for the save round trip, not a hope that it is fast. It
    // stays under the project's 45s test timeout, so a miss fails by name.
    await expect.poll(
      () => countDraftCaptures(tmpDir, taskId),
      {
        message: "the drawn annotation's own page capture never reached the draft folder",
        timeout: 20000,
        intervals: [200, 500, 1000],
      },
    ).toBeGreaterThanOrEqual(1);

    const sendButton = page.locator('[data-testid="browser-send"]');
    await expect(sendButton).toBeEnabled();
    await sendButton.click();

    // Send reached main once it wrote its screenshot. The poll reads where the
    // Send stands rather than a bare count, so a Send that threw, one still
    // waiting on the guest and a click that did nothing each fail by name.
    await expect.poll(
      () => readSendOutcome(page, tmpDir),
      { timeout: 15000, intervals: [200, 500, 1000] },
    ).toBe('sent');

    const scrollback = await waitForEnvelope(page, tmpDir, taskId, '<annotations');
    expect(scrollback).toContain('<annotation n="1">');
    expect(scrollback).toContain('kangentic-annotation-note');
    expect(scrollback).toContain('<drawing strokes="1"');
  });
});

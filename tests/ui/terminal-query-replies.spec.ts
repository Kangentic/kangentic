/**
 * The renderer terminal sends no XTVERSION or color-scheme reply into the PTY.
 * `useTerminal` swallows the first and turns the second off
 * (src/renderer/utils/terminal-query-replies.ts says why).
 *
 * The color-scheme reply comes from the browser core alone, so the unit tier's
 * headless terminal cannot show it; this spec runs the real browser bundle and
 * reads what the terminal wrote back through the mock's sessions.write log.
 * A device-attributes query is both the positive control (replies do reach the
 * log) and the fence (its reply means every query before it in the same chunk
 * has been parsed). See .claude/rules/xterm-query-replies.md.
 */
import { test, expect } from '@playwright/test';
import {
  fireSessionData,
  launchWithTransientTerminal,
  openTransientCommandTerminal,
  writtenToSession,
} from './helpers';

test.describe.configure({ mode: 'parallel' });

const TRANSIENT_SESSION_ID = 'sess-query-replies-1';
/** Primary device attributes, which xterm always answers. */
const DEVICE_ATTRIBUTES_QUERY = '\x1b[c';
const DEVICE_ATTRIBUTES_REPLY = /\x1b\[\?[\d;]+c/gu;

function countDeviceAttributeReplies(written: string): number {
  return [...written.matchAll(DEVICE_ATTRIBUTES_REPLY)].length;
}

test('the terminal answers device attributes but not XTVERSION or the color-scheme query', async () => {
  const { browser, page } = await launchWithTransientTerminal({
    projectId: 'proj-query-replies',
    projectName: 'Query Replies Project',
    sessionId: TRANSIENT_SESSION_ID,
  });
  try {
    await openTransientCommandTerminal(page, TRANSIENT_SESSION_ID);

    // Re-fired inside the poll: a chunk that lands during the mount replay is
    // superseded by the replay's frame.
    await expect.poll(async () => {
      await fireSessionData(page, TRANSIENT_SESSION_ID, DEVICE_ATTRIBUTES_QUERY);
      return countDeviceAttributeReplies(await writtenToSession(page, TRANSIENT_SESSION_ID));
    }, { timeout: 10000, intervals: [250] }).toBeGreaterThan(0);

    const fenceRepliesBefore = countDeviceAttributeReplies(await writtenToSession(page, TRANSIENT_SESSION_ID));
    await fireSessionData(page, TRANSIENT_SESSION_ID, `\x1b[>q\x1b[>0q\x1b[?996n${DEVICE_ATTRIBUTES_QUERY}`);
    await expect.poll(
      async () => countDeviceAttributeReplies(await writtenToSession(page, TRANSIENT_SESSION_ID)),
      { timeout: 5000 },
    ).toBeGreaterThan(fenceRepliesBefore);

    const written = await writtenToSession(page, TRANSIENT_SESSION_ID);
    // XTVERSION's reply: ESC P >|xterm.js(<version>) ESC \
    expect(written).not.toContain('>|xterm.js(');
    // The color-scheme reply: CSI ? 997 ; 1 n (dark) or ; 2 n (light).
    expect(written).not.toContain('\x1b[?997;');
  } finally {
    await browser.close();
  }
});

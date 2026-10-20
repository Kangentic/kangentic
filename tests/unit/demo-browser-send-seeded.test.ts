/**
 * The web demo's Browser pane Send plays what the matrix recorded: a session's finished conversation
 * resumed and sent a note from the pane, the payload pasted as the paste engine pastes it, and the
 * agent's reply. So every send the manifest lists has to be on disk and whole, has to start from the
 * frame the session rests on, has to play only for the note it was recorded with, and has to reach
 * the seed. A send that went missing would leave the browser scene's Send waiting on an agent that
 * never starts, and one whose note drifted from the scene's would echo words the visitor never typed.
 *
 * Re-record one with `node scripts/capture-demo-sessions.mjs --only send-<sessionId>`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEMO_ALL_SESSIONS, buildDemoPreConfig, buildDemoSendFrameScripts } from '../captures/helpers/demo-dataset';
import { loadDemoRecordings, loadDemoSendFrames } from '../captures/helpers/demo-scrollback';
import { BROWSER_SEND_NOTE, SCENES } from '../captures/scenes';

const FIXTURES = path.resolve(__dirname, '..', 'captures', 'fixtures', 'demo');
const DATASET = path.resolve(__dirname, '..', 'captures', 'helpers', 'demo-dataset.ts');
const VITE_CONFIG = path.resolve(__dirname, '..', '..', 'demo', 'vite.config.mts');
const BOOT = path.resolve(__dirname, '..', '..', 'demo', 'boot.js');

interface BrowserSend { file: string; sessionId: string; recording: string; note: string }
interface Manifest {
  browserSends?: BrowserSend[];
  captures: Array<{ file: string; sessionId: string }>;
  geometry: { taskWindowTiled: { cols: number; rows: number } };
}
interface SendRecording {
  cols: number;
  rows: number;
  stopReason: string;
  stream: Array<{ t: number; data: string }>;
  messageTrail: Array<{ t: number; text: string }>;
  paste?: { atMs: number; enterAtMs: number; text: string; frame: string };
}

const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'manifest.json'), 'utf-8')) as Manifest;
const sends = manifest.browserSends ?? [];
const rerecord = (send: BrowserSend): string => `re-record it with "node scripts/capture-demo-sessions.mjs --only ${send.file.replace(/\.json$/, '')}"`;
const readSend = (send: BrowserSend): SendRecording => JSON.parse(fs.readFileSync(path.join(FIXTURES, send.file), 'utf-8')) as SendRecording;

describe('the web demo plays a recorded Browser pane Send', () => {
  it('lists a send, so the checks below are not vacuous', () => {
    expect(sends.length).toBeGreaterThan(0);
  });

  it('records each against a dataset session and the recording whose conversation it resumes', () => {
    const problems: string[] = [];
    for (const send of sends) {
      if (send.file !== `send-${send.sessionId}.json`) problems.push(`${send.file} is not named send-${send.sessionId}.json, which is how the loader keys it`);
      if (!DEMO_ALL_SESSIONS.some((session) => session.id === send.sessionId)) problems.push(`${send.sessionId} is not a dataset session`);
      if (!manifest.captures.some((capture) => capture.sessionId === send.sessionId && capture.file === send.recording)) problems.push(`${send.recording} is not ${send.sessionId}'s recording`);
      if (!fs.existsSync(path.join(FIXTURES, send.file))) problems.push(`${send.file} is missing; ${rerecord(send)}`);
    }
    expect(problems).toEqual([]);
  });

  it('pastes the note, enters it after, and runs to the agent\'s own end at the tiled pane\'s grid', () => {
    const problems: string[] = [];
    for (const send of sends) {
      const recording = readSend(send);
      const paste = recording.paste;
      if (!paste) { problems.push(`${send.file} carries no paste; ${rerecord(send)}`); continue; }
      if (!paste.text.startsWith(send.note)) problems.push(`${send.file} pasted text that does not open with its note`);
      if (!paste.text.includes('<browser_context>')) problems.push(`${send.file} pasted no browser context, which is not the payload Send builds`);
      if (!(paste.atMs > 0 && paste.enterAtMs > paste.atMs)) problems.push(`${send.file} has Enter at ${paste.enterAtMs} ms, not after the paste at ${paste.atMs} ms`);
      // The paste engine never enters sooner than this after the paste (MIN_GAP_MS).
      if (paste.enterAtMs - paste.atMs < 1000) problems.push(`${send.file} entered ${paste.enterAtMs - paste.atMs} ms after the paste, sooner than the paste engine does`);
      if (recording.stopReason !== 'idle' && recording.stopReason !== 'exited') problems.push(`${send.file} stopped on ${recording.stopReason}, not where the agent finished`);
      const tiled = manifest.geometry.taskWindowTiled;
      if (recording.cols !== tiled.cols || recording.rows !== tiled.rows) problems.push(`${send.file} is ${recording.cols}x${recording.rows}, not the tiled pane's ${tiled.cols}x${tiled.rows}`);
      if (recording.messageTrail.length === 0) problems.push(`${send.file} carries no message trail, so the card would not say what the agent answered`);
    }
    expect(problems).toEqual([]);
  });

  it('starts from a frame of the finished conversation, before the note went in', () => {
    const frames = loadDemoSendFrames();
    for (const send of sends) {
      const frame = frames[send.sessionId];
      expect(frame, `${send.file} has no frame before its paste; ${rerecord(send)}`).toBeTruthy();
      expect(frame).not.toContain('browser_context');
      // Nothing streamed in the 100 ms window that could carry the paste's own echo into it.
      const paste = readSend(send).paste;
      expect(readSend(send).stream.filter((window) => paste && window.t <= paste.atMs && window.t > paste.atMs - 100)).toEqual([]);
    }
    expect(Object.keys(loadDemoRecordings().sends).sort()).toEqual(sends.map((send) => send.sessionId).sort());
  });

  it('is sent by the browser scene with exactly its note, from a session at rest', () => {
    const middleware = sends.find((send) => send.sessionId === 'sess-cw-middleware');
    expect(middleware, 'the browser scene sends the middleware session\'s recorded note').toBeTruthy();
    expect(BROWSER_SEND_NOTE).toBe(middleware?.note);
    const scene = SCENES.browser;
    expect(scene.sessions?.['sess-cw-middleware']?.activity, 'a working session has no frame to rest on').toBe('idle');
    const steps = scene.choreography ?? [];
    expect(steps.some((step) => 'type' in step && step.type.text === BROWSER_SEND_NOTE)).toBe(true);
    expect(steps.some((step) => 'click' in step && step.click === '[data-testid="browser-send"]')).toBe(true);
  });

  it('reaches the seed, which plays it on Send and takes it back at the cut', () => {
    const dataset = fs.readFileSync(DATASET, 'utf-8');
    expect(dataset).toContain('window.electronAPI.browser.captureAndSend = function');
    expect(dataset).toContain("getAttribute('data-demo-cut') === 'reset') rewindSends()");
    // Executed, so the generated seed is proven to carry the frame, not just the source.
    const scrollback = Object.fromEntries(DEMO_ALL_SESSIONS.map((session) => [session.id, 'frame']));
    const sendFrames = loadDemoSendFrames();
    const seed = buildDemoPreConfig({ scrollback, sendFrames });
    for (const frame of Object.values(sendFrames)) expect(seed).toContain(JSON.stringify(frame).slice(1, 200));
  });

  it('keeps the rest frame out of the seed every frame loads, in a script only its scene writes', () => {
    // Inline, the frame was heap in every frame on a page; the web build ships it beside the seed
    // and demo/boot.js writes it in only where a scene shows the session finished.
    const scrollback = Object.fromEntries(DEMO_ALL_SESSIONS.map((session) => [session.id, 'frame']));
    const sendFrames = loadDemoSendFrames();
    const seed = buildDemoPreConfig({ scrollback, sendFrames: 'separate' });
    for (const frame of Object.values(sendFrames)) expect(seed).not.toContain(JSON.stringify(frame).slice(1, 200));
    expect(seed).toContain('window.__demoSendFrames || {}');
    const scripts = buildDemoSendFrameScripts(sendFrames);
    for (const [sessionId, frame] of Object.entries(sendFrames)) expect(scripts[sessionId]).toContain(JSON.stringify(frame));
    expect(fs.readFileSync(VITE_CONFIG, 'utf-8')).toContain("sendFrames: 'separate'");
    const boot = fs.readFileSync(BOOT, 'utf-8');
    expect(boot).toContain('window.__demoSendFrameScripts');
    expect(boot).toContain("effective.sessions[sessionId].activity !== 'idle'");
  });
});

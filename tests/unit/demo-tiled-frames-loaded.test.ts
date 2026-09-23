/**
 * loadDemoTiledFrames paints a still for a session whose window mounted at the tiled width: the
 * tiled recording's own final frame, and for a thinking session the frame at the moment the live
 * frame opens it, on the SINGLE recording's own clock (tests/captures/helpers/demo-scrollback.ts),
 * with every row above the screen that the backfill cut it with.
 * A named tiled sibling whose recording carries no serialized frame is refused rather than
 * silently falling back to the single recording's frame, which would paint the wrong terminal in
 * every tiled scene with no visible sign anything was wrong.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/headless';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { loadDemoTiledFrames } from '../captures/helpers/demo-scrollback';
import { DEMO_SESSIONS, SESSION_API_CLIENT, SESSION_CONTOSO_TERMINAL, SESSION_MIDDLEWARE } from '../captures/helpers/demo-dataset';
import { serializePhysicalRows } from '../../scripts/lib/demo-frame-serializer.js';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FIXTURES_DIR = path.join(REPO_ROOT, 'tests', 'captures', 'fixtures', 'demo');

interface DemoManifestFixtureEntry {
  file: string;
  sessionId: string;
  tiled?: string;
}

interface DemoManifestFixture {
  liveTailMs?: number;
  captures: DemoManifestFixtureEntry[];
}

interface RawCaptureRecordFixture {
  cols: number;
  rows: number;
  serialized: string;
  stream?: Array<{ t: number; data: string }>;
  frameTimeline?: Array<{ t: number; frame: string }>;
}

function readManifestFixture(): DemoManifestFixture {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, 'manifest.json'), 'utf-8')) as DemoManifestFixture;
}

function readRawRecording(file: string): RawCaptureRecordFixture {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf-8')) as RawCaptureRecordFixture;
}

/**
 * The tiled recording at the moment the single recording's clock opens the session, replayed
 * from the raw stream on disk in a headless terminal and serialized with every row above the
 * screen, rather than read through loadDemoTiledFrames, so the expectation is not anchored on the
 * loader's own arithmetic or on the backfill that cut the stored frame.
 */
async function computeExpectedOpenFrame(
  baseFile: string,
  tiledFile: string,
  liveTailMs: number,
): Promise<{ opensAtMs: number; tiledDurationMs: number; serialized: string }> {
  const base = readRawRecording(baseFile);
  const tiled = readRawRecording(tiledFile);
  const stream = Array.isArray(base.stream) ? base.stream : [];
  const singleDurationMs = stream.length > 0 ? stream[stream.length - 1].t : 0;
  const opensAtMs = Math.max(0, singleDurationMs - liveTailMs);
  const timeline = Array.isArray(tiled.frameTimeline) ? tiled.frameTimeline : [];
  if (timeline.length === 0) throw new Error(`${tiledFile} carries no frame timeline`);
  const tiledDurationMs = timeline[timeline.length - 1].t;
  if (opensAtMs >= tiledDurationMs) return { opensAtMs, tiledDurationMs, serialized: tiled.serialized };
  const terminal = new Terminal({ cols: tiled.cols, rows: tiled.rows, allowProposedApi: true, scrollback: 5000 });
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = '11';
  const tiledStream = Array.isArray(tiled.stream) ? tiled.stream : [];
  const played = tiledStream.filter((window) => window.t <= opensAtMs).map((window) => window.data).join('');
  await new Promise<void>((resolve) => terminal.write(played, () => resolve()));
  const serialized = serializePhysicalRows(terminal, { scrollback: 5000 });
  terminal.dispose();
  return { opensAtMs, tiledDurationMs, serialized };
}

describe('loadDemoTiledFrames', () => {
  it('keys are exactly the manifest entries that carry a tiled sibling', () => {
    const manifest = readManifestFixture();
    const expectedSessionIds = manifest.captures
      .filter((entry) => typeof entry.tiled === 'string' && entry.tiled.length > 0)
      .map((entry) => entry.sessionId)
      .sort();
    const tiledFrames = loadDemoTiledFrames();
    expect(Object.keys(tiledFrames).sort()).toEqual(expectedSessionIds);
  });

  it("gives the idle Command Terminal session a null openFrame and the tiled recording's own final frame", () => {
    const tiledFrames = loadDemoTiledFrames();
    const terminalFrames = tiledFrames[SESSION_CONTOSO_TERMINAL];
    expect(terminalFrames.openFrame).toBeNull();
    const tiledRecord = readRawRecording('contoso-web-claude-terminal-tiled.json');
    expect(terminalFrames.serialized.length).toBeGreaterThan(0);
    expect(terminalFrames.serialized).toBe(tiledRecord.serialized);
  });

  const thinkingSessions: Array<{ sessionId: string; baseFile: string; tiledFile: string }> = [
    { sessionId: SESSION_MIDDLEWARE, baseFile: 'contoso-web-claude-middleware.json', tiledFile: 'contoso-web-claude-middleware-tiled.json' },
    { sessionId: SESSION_API_CLIENT, baseFile: 'contoso-web-claude-api-client.json', tiledFile: 'contoso-web-claude-api-client-tiled.json' },
  ];

  for (const thinkingSession of thinkingSessions) {
    it(`opens the thinking session ${thinkingSession.sessionId} at the tiled frame the single recording's clock points to`, async () => {
      const manifest = readManifestFixture();
      expect(typeof manifest.liveTailMs).toBe('number');
      const session = DEMO_SESSIONS.find((candidate) => candidate.id === thinkingSession.sessionId);
      expect(session).toBeDefined();
      const liveTailMs = session?.liveTailMs ?? (manifest.liveTailMs as number);
      const expected = await computeExpectedOpenFrame(thinkingSession.baseFile, thinkingSession.tiledFile, liveTailMs);

      // Not vacuous: the opening moment falls inside the tiled recording's own timeline, so the
      // opening frame below has to be a real mid-timeline frame rather than the fallback to the
      // tiled recording's final frame that a session recorded shorter than its tail would take.
      expect(expected.opensAtMs).toBeLessThan(expected.tiledDurationMs);

      const tiledFrames = loadDemoTiledFrames();
      const sessionFrames = tiledFrames[thinkingSession.sessionId];
      expect(sessionFrames.openFrame).not.toBeNull();
      expect(sessionFrames.openFrame?.serialized).toBe(expected.serialized);
      expect(sessionFrames.openFrame?.serialized).not.toBe(sessionFrames.serialized);
      expect(sessionFrames.openFrame?.peek).toEqual([]);
    });
  }

  describe('a tiled sibling with no serialized frame', () => {
    let temporaryFixturesDir: string | null = null;

    afterEach(() => {
      if (temporaryFixturesDir) {
        fs.rmSync(temporaryFixturesDir, { recursive: true, force: true });
        temporaryFixturesDir = null;
      }
    });

    it('is refused with the session id, the tiled file, and the re-run command', () => {
      temporaryFixturesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-tiled-frames-refusal-'));
      const sessionId = 'sess-test-empty-tiled-frame';
      fs.writeFileSync(
        path.join(temporaryFixturesDir, 'manifest.json'),
        JSON.stringify({
          liveTailMs: 90000,
          captures: [{ file: 'base-recording.json', sessionId, tiled: 'tiled-recording.json', agent: 'claude', project: 'test-project' }],
        }),
      );
      fs.writeFileSync(
        path.join(temporaryFixturesDir, 'base-recording.json'),
        JSON.stringify({ agent: 'claude', serialized: 'BASE_FRAME', rawBytes: 10, stream: [{ t: 0, data: 'x' }] }),
      );
      fs.writeFileSync(
        path.join(temporaryFixturesDir, 'tiled-recording.json'),
        JSON.stringify({ agent: 'claude', serialized: '', rawBytes: 0 }),
      );

      expect(() => loadDemoTiledFrames(temporaryFixturesDir as string)).toThrow(
        /sess-test-empty-tiled-frame.*tiled-recording\.json.*capture-demo-sessions\.mjs --only tiled-recording/,
      );
    });
  });

  describe('a thinking session whose tiled recording ended before the single recording opens it', () => {
    let temporaryFixturesDir: string | null = null;

    afterEach(() => {
      if (temporaryFixturesDir) {
        fs.rmSync(temporaryFixturesDir, { recursive: true, force: true });
        temporaryFixturesDir = null;
      }
    });

    /**
     * None of the committed fixtures reach this branch: both real thinking sessions with a tiled
     * sibling open inside their tiled recording's own timeline (the "Not vacuous" assertion two
     * tests up pins that). A synthetic fixture is the only way to drive opensAtMs past the tiled
     * timeline's own end.
     */
    it("paints the tiled recording's own final frame, not a frame walked off the end of its timeline", () => {
      temporaryFixturesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-tiled-frames-shorter-variant-'));
      fs.writeFileSync(
        path.join(temporaryFixturesDir, 'manifest.json'),
        JSON.stringify({
          liveTailMs: 1000,
          captures: [{ file: 'base.json', sessionId: SESSION_MIDDLEWARE, tiled: 'tiled.json', agent: 'claude', project: 'test-project' }],
        }),
      );
      // singleDurationMs = 10000, liveTailMs = 1000 -> opensAtMs = 9000.
      fs.writeFileSync(
        path.join(temporaryFixturesDir, 'base.json'),
        JSON.stringify({ agent: 'claude', serialized: 'BASE_FRAME', rawBytes: 10, stream: [{ t: 0, data: 'x' }, { t: 10000, data: 'y' }] }),
      );
      // tiledDurationMs = 2000, well before opensAtMs (9000): the variant had already ended by
      // the moment the live frame would open it, so its still is the recording's own final
      // frame, not a frame from a walk that ran past the timeline's last entry.
      fs.writeFileSync(
        path.join(temporaryFixturesDir, 'tiled.json'),
        JSON.stringify({
          agent: 'claude',
          serialized: 'TILED_FINAL_SERIALIZED',
          rawBytes: 10,
          frameTimeline: [{ t: 0, frame: 'TILED_TIMELINE_FRAME_EARLY' }, { t: 2000, frame: 'TILED_TIMELINE_FRAME_LAST' }],
        }),
      );

      const tiledFrames = loadDemoTiledFrames(temporaryFixturesDir as string);
      const sessionFrames = tiledFrames[SESSION_MIDDLEWARE];
      expect(sessionFrames.openFrame).not.toBeNull();
      expect(sessionFrames.openFrame?.serialized).toBe('TILED_FINAL_SERIALIZED');
      // Distinguishes the fallback from a walk that just happened to stop on the last timeline
      // step: if the loader still walked the timeline here, it would return this instead.
      expect(sessionFrames.openFrame?.serialized).not.toBe('TILED_TIMELINE_FRAME_LAST');
    });
  });

  describe('a thinking session whose tiled recording carries no frame timeline', () => {
    let temporaryFixturesDir: string | null = null;

    afterEach(() => {
      if (temporaryFixturesDir) {
        fs.rmSync(temporaryFixturesDir, { recursive: true, force: true });
        temporaryFixturesDir = null;
      }
    });

    it('is refused rather than silently skipping the opening frame', () => {
      temporaryFixturesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-tiled-frames-no-timeline-'));
      fs.writeFileSync(
        path.join(temporaryFixturesDir, 'manifest.json'),
        JSON.stringify({
          liveTailMs: 1000,
          captures: [{ file: 'base.json', sessionId: SESSION_MIDDLEWARE, tiled: 'tiled.json', agent: 'claude', project: 'test-project' }],
        }),
      );
      fs.writeFileSync(
        path.join(temporaryFixturesDir, 'base.json'),
        JSON.stringify({ agent: 'claude', serialized: 'BASE_FRAME', rawBytes: 10, stream: [{ t: 0, data: 'x' }, { t: 10000, data: 'y' }] }),
      );
      // A tiled sibling with a final frame but no frameTimeline: the "no serialized frame"
      // refusal above does not catch this, since serialized is present here.
      fs.writeFileSync(
        path.join(temporaryFixturesDir, 'tiled.json'),
        JSON.stringify({ agent: 'claude', serialized: 'TILED_FINAL_SERIALIZED', rawBytes: 10 }),
      );

      expect(() => loadDemoTiledFrames(temporaryFixturesDir as string)).toThrow(
        /carries no frame timeline.*backfill-demo-timelines\.mjs/,
      );
    });
  });

  describe('a thinking session whose tiled recording has no open frame for the moment it opens at', () => {
    let temporaryFixturesDir: string | null = null;

    afterEach(() => {
      if (temporaryFixturesDir) {
        fs.rmSync(temporaryFixturesDir, { recursive: true, force: true });
        temporaryFixturesDir = null;
      }
    });

    it('is refused with the backfill command, rather than painting a screen-only timeline frame', () => {
      temporaryFixturesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-tiled-frames-no-open-frame-'));
      fs.writeFileSync(
        path.join(temporaryFixturesDir, 'manifest.json'),
        JSON.stringify({
          liveTailMs: 1000,
          captures: [{ file: 'base.json', sessionId: SESSION_MIDDLEWARE, tiled: 'tiled.json', agent: 'claude', project: 'test-project' }],
        }),
      );
      // singleDurationMs = 10000, liveTailMs = 1000 -> opensAtMs = 9000, inside the tiled run.
      fs.writeFileSync(
        path.join(temporaryFixturesDir, 'base.json'),
        JSON.stringify({ agent: 'claude', serialized: 'BASE_FRAME', rawBytes: 10, stream: [{ t: 0, data: 'x' }, { t: 10000, data: 'y' }] }),
      );
      // A re-recorded tiled run, which the capture script writes with no open frame of its own.
      fs.writeFileSync(
        path.join(temporaryFixturesDir, 'tiled.json'),
        JSON.stringify({
          agent: 'claude',
          serialized: 'TILED_FINAL_SERIALIZED',
          rawBytes: 10,
          stream: [{ t: 0, data: 'x' }, { t: 20000, data: 'y' }],
          frameTimeline: [{ t: 0, frame: 'EARLY' }, { t: 20000, frame: 'LAST' }],
        }),
      );

      expect(() => loadDemoTiledFrames(temporaryFixturesDir as string)).toThrow(
        /tiled\.json carries no open frame cut 11000 ms before its end.*backfill-demo-timelines\.mjs/,
      );
    });
  });

  describe('a tiled sibling the manifest names but that is not on disk', () => {
    let temporaryFixturesDir: string | null = null;

    afterEach(() => {
      if (temporaryFixturesDir) {
        fs.rmSync(temporaryFixturesDir, { recursive: true, force: true });
        temporaryFixturesDir = null;
      }
    });

    it('is refused with the session id, the tiled file, and the re-run command, rather than falling back to the single recording', () => {
      temporaryFixturesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'demo-tiled-frames-missing-sibling-'));
      const sessionId = 'sess-test-missing-tiled-sibling';
      fs.writeFileSync(
        path.join(temporaryFixturesDir, 'manifest.json'),
        JSON.stringify({
          liveTailMs: 1000,
          captures: [{ file: 'base.json', sessionId, tiled: 'missing-tiled.json', agent: 'claude', project: 'test-project' }],
        }),
      );
      fs.writeFileSync(
        path.join(temporaryFixturesDir, 'base.json'),
        JSON.stringify({ agent: 'claude', serialized: 'BASE_FRAME', rawBytes: 10, stream: [{ t: 0, data: 'x' }] }),
      );
      // missing-tiled.json is deliberately never written.

      expect(() => loadDemoTiledFrames(temporaryFixturesDir as string)).toThrow(
        /sess-test-missing-tiled-sibling.*missing-tiled\.json.*capture-demo-sessions\.mjs --only missing-tiled/,
      );
    });
  });
});

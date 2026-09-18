/**
 * loadDemoTiledFrames paints a still for a session whose window mounted at the tiled width: the
 * tiled recording's own final frame, and for a thinking session the frame at the moment the live
 * frame opens it, walked from the SINGLE recording's own clock (tests/captures/helpers/demo-scrollback.ts).
 * A named tiled sibling whose recording carries no serialized frame is refused rather than
 * silently falling back to the single recording's frame, which would paint the wrong terminal in
 * every tiled scene with no visible sign anything was wrong.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadDemoTiledFrames } from '../captures/helpers/demo-scrollback';
import { DEMO_SESSIONS, SESSION_API_CLIENT, SESSION_CONTOSO_TERMINAL, SESSION_MIDDLEWARE } from '../captures/helpers/demo-dataset';

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
 * Reproduces the loader's own walk over the tiled recording's frame timeline, from the raw
 * fixture data on disk rather than through loadDemoTiledFrames, so the expectation is not
 * anchored on the loader's own arithmetic.
 */
function computeExpectedOpenFrame(
  baseFile: string,
  tiledFile: string,
  liveTailMs: number,
): { opensAtMs: number; tiledDurationMs: number; serialized: string } {
  const base = readRawRecording(baseFile);
  const tiled = readRawRecording(tiledFile);
  const stream = Array.isArray(base.stream) ? base.stream : [];
  const singleDurationMs = stream.length > 0 ? stream[stream.length - 1].t : 0;
  const opensAtMs = Math.max(0, singleDurationMs - liveTailMs);
  const timeline = Array.isArray(tiled.frameTimeline) ? tiled.frameTimeline : [];
  if (timeline.length === 0) throw new Error(`${tiledFile} carries no frame timeline`);
  const tiledDurationMs = timeline[timeline.length - 1].t;
  let currentFrame = timeline[0].frame;
  for (const step of timeline) {
    if (step.t > opensAtMs) break;
    currentFrame = step.frame;
  }
  const serialized = opensAtMs >= tiledDurationMs ? tiled.serialized : currentFrame;
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
    it(`opens the thinking session ${thinkingSession.sessionId} at the tiled frame the single recording's clock points to`, () => {
      const manifest = readManifestFixture();
      expect(typeof manifest.liveTailMs).toBe('number');
      const session = DEMO_SESSIONS.find((candidate) => candidate.id === thinkingSession.sessionId);
      expect(session).toBeDefined();
      const liveTailMs = session?.liveTailMs ?? (manifest.liveTailMs as number);
      const expected = computeExpectedOpenFrame(thinkingSession.baseFile, thinkingSession.tiledFile, liveTailMs);

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
});

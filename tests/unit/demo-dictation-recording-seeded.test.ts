/**
 * The web demo's dictation must type what the desktop's engine typed, so the recording it replays
 * has to exist, be whole, come from the models the demo's Dictation tab names, and reach the seed.
 *
 * Before the recording, the dataset answered `dictation.stop` with an empty string over the silent
 * microphone: the Voice card held push-to-talk, let go, and the chip closed with nothing typed.
 * Every structural check passed, because the bridge method existed and answered. This is the same
 * guard demo-message-trail-seeded.test.ts is for the card's message trail: the data must be there,
 * not merely servable.
 *
 * The fixture is made by `node scripts/record-dictation-demo.mjs` (demo/README.md, Dictation).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEMO_ALL_SESSIONS, DEMO_DICTATION_MODELS, DEMO_DICTATION_RECORDING, buildDemoPreConfig } from '../captures/helpers/demo-dataset';
import { computeSearchResults } from '../../src/renderer/components/settings/settings-search';
import { SETTINGS_REGISTRY } from '../../src/renderer/components/settings/settings-registry';

const FIXTURE = path.resolve(__dirname, '..', 'captures', 'fixtures', 'demo', 'dictation', 'settings-search.json');
const DATASET = path.resolve(__dirname, '..', 'captures', 'helpers', 'demo-dataset.ts');
const REGENERATE = 'regenerate it with "node scripts/record-dictation-demo.mjs"';

describe('the web demo replays a recorded dictation', () => {
  it('has the recording', () => {
    expect(fs.existsSync(FIXTURE), `the dictation recording is missing; ${REGENERATE}`).toBe(true);
  });

  it('was recorded on the models the demo\'s Dictation tab names', () => {
    // The tab lists main's own selection for the sample install's machine. A recording from other
    // models would type text those models never produce.
    expect(DEMO_DICTATION_MODELS.liveModelId).not.toBeNull();
    expect(DEMO_DICTATION_MODELS.finalModelId).not.toBeNull();
    expect(DEMO_DICTATION_RECORDING.liveModelId, REGENERATE).toBe(DEMO_DICTATION_MODELS.liveModelId);
    expect(DEMO_DICTATION_RECORDING.finalModelId, REGENERATE).toBe(DEMO_DICTATION_MODELS.finalModelId);
  });

  it('streams partials in order, inside the hold, each with text', () => {
    const { partials, releaseMs, releaseBufferMs } = DEMO_DICTATION_RECORDING;
    expect(partials.length, `the recording has no partials; ${REGENERATE}`).toBeGreaterThan(0);
    const problems: string[] = [];
    let previous = 0;
    for (const partial of partials) {
      if (partial.t <= previous) problems.push(`t=${partial.t} does not come after ${previous}`);
      if (partial.t > releaseMs + releaseBufferMs) problems.push(`t=${partial.t} is after the mic closed at ${releaseMs + releaseBufferMs}`);
      if (partial.text.trim().length === 0) problems.push(`the partial at t=${partial.t} has no text`);
      previous = partial.t;
    }
    expect(problems).toEqual([]);
  });

  it('commits a final that names a Dictation tab setting', () => {
    const { final } = DEMO_DICTATION_RECORDING;
    expect(final.text.trim().length, `the recording has no final; ${REGENERATE}`).toBeGreaterThan(0);
    expect(final.decodeMs).toBeGreaterThanOrEqual(0);
    // The scene types it into the Settings search on the Dictation tab, which must narrow to the
    // row it names rather than to No results.
    const matches = [...computeSearchResults(final.text, SETTINGS_REGISTRY).matchingIds];
    expect(matches.filter((id) => id.startsWith('dictation.')).length, `"${final.text}" matches no Dictation setting`).toBeGreaterThan(0);
  });

  it('reaches the seed, which replays it instead of answering stop with nothing', () => {
    const dataset = fs.readFileSync(DATASET, 'utf-8');
    expect(dataset).toContain('dictationRecording: DEMO_DICTATION_RECORDING');
    expect(dataset).toContain('window.__emitDictationPartial(');
    expect(dataset).not.toMatch(/dictation\.stop = function \(\) \{ return Promise\.resolve\(''\); \}/);
    // Executed, so the generated seed is proven to carry the recording, not just the source. The
    // builder refuses a session with no terminal frame, which a stand-in satisfies here.
    const scrollback = Object.fromEntries(DEMO_ALL_SESSIONS.map((session) => [session.id, 'frame']));
    const seed = buildDemoPreConfig({ scrollback });
    expect(seed).toContain(JSON.stringify(DEMO_DICTATION_RECORDING.final.text));
  });
});

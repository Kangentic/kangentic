/**
 * `buildDemoPreConfig` (tests/captures/helpers/demo-dataset.ts) returns its seed as a template
 * string meant to run inside a browser page, not as an importable module: the file must stay free
 * of Node imports (see its own top comment), so its replay logic cannot be unit tested by import.
 *
 * This file reaches into that generated script the way demo-message-trail-seeded.test.ts already
 * does for a single literal (its "keeps the applier fallback equal to the cap main actually uses"
 * test regexes `options.messageTrailMaxEntries ?? (\d+)` straight out of the source): it extracts
 * the real function source for `trailAt` and `setMessageTrail`, builds a callable with `new
 * Function` over synthetic closures, and asserts the behavior those functions give a replaying
 * card. This is the actual generated-script text, byte for byte, not a hand-reimplementation of
 * it, so a change to the real logic changes what these tests see.
 *
 * Two things this file deliberately does NOT cover: `replayOpensAt` (untouched by this change's
 * gaps) and the demo/UI tiers (message-trail scheduling against a live page and a mounted xterm,
 * which needs a browser and the `demo` tier's build; see docs/developer-guide.md and
 * static-demo.spec.ts's message-trail assertions for that layer).
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const DATASET_PATH = path.resolve(__dirname, '..', 'captures', 'helpers', 'demo-dataset.ts');
const DATASET_SOURCE = fs.readFileSync(DATASET_PATH, 'utf-8');

/** One line of a recorded agent message trail, exactly the shape `messageTrails[sessionId]` holds. */
interface DemoMessageTrailEntry {
  t: number;
  uuid: string;
  ts: number;
  text: string;
}

/** What `trailAt` hands back: a trail entry with its replay offset `t` stripped. */
type VisibleTrailEntry = Omit<DemoMessageTrailEntry, 't'>;

type TrailAtFunction = (sessionId: string, offsetMs: number) => VisibleTrailEntry[];
type SetMessageTrailFunction = (sessionId: string, offsetMs: number) => void;

interface SyntheticSessionRow {
  id: string;
  projectId: string;
}

interface SyntheticMockState {
  sessions: SyntheticSessionRow[];
  messageTrailCache: Record<string, VisibleTrailEntry[]>;
}

/**
 * The real source of `function <name>(...) { ... }` inside demo-dataset.ts's generated script,
 * brace-balanced from the first `{` after the marker. Throws rather than returning an empty
 * string when `name` is not found, so a rename cannot make every test below vacuously pass on an
 * empty function body (mirroring `callBody` in demo-dataset-consumer-parity.test.ts).
 */
function extractFunction(source: string, name: string): string {
  const marker = `function ${name}(`;
  const start = source.indexOf(marker);
  if (start === -1) throw new Error(`no "${marker}" found in demo-dataset.ts`);
  const open = source.indexOf('{', start);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === '{') depth += 1;
    if (source[index] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`unbalanced function ${name} in demo-dataset.ts`);
}

/** Builds the real `trailAt` over synthetic `messageTrails` / `messageTrailMaxEntries` closures. */
function buildTrailAt(
  messageTrails: Record<string, DemoMessageTrailEntry[]>,
  messageTrailMaxEntries: number,
): TrailAtFunction {
  const trailAtSource = extractFunction(DATASET_SOURCE, 'trailAt');
  const factory = new Function(
    'messageTrails',
    'messageTrailMaxEntries',
    `${trailAtSource}\nreturn trailAt;`,
  ) as (
    injectedMessageTrails: Record<string, DemoMessageTrailEntry[]>,
    injectedMessageTrailMaxEntries: number,
  ) => TrailAtFunction;
  return factory(messageTrails, messageTrailMaxEntries);
}

/**
 * Builds the real `setMessageTrail` over synthetic `messageTrails`, `mockState`, and a `window`
 * carrying a spy for `__mockFireMessageTrail`. `setMessageTrail` calls `trailAt` and `sessionById`
 * by name, so both are extracted and declared alongside it; function-declaration hoisting inside
 * the `new Function` body makes the concatenation order irrelevant.
 */
function buildSetMessageTrail(
  messageTrails: Record<string, DemoMessageTrailEntry[]>,
  messageTrailMaxEntries: number,
  mockState: SyntheticMockState,
  fireMessageTrail: (sessionId: string, entries: VisibleTrailEntry[], projectId: string | undefined) => void,
): SetMessageTrailFunction {
  const trailAtSource = extractFunction(DATASET_SOURCE, 'trailAt');
  const sessionByIdSource = extractFunction(DATASET_SOURCE, 'sessionById');
  const setMessageTrailSource = extractFunction(DATASET_SOURCE, 'setMessageTrail');
  const factory = new Function(
    'messageTrails',
    'messageTrailMaxEntries',
    'mockState',
    'window',
    `${trailAtSource}\n${sessionByIdSource}\n${setMessageTrailSource}\nreturn setMessageTrail;`,
  ) as (
    injectedMessageTrails: Record<string, DemoMessageTrailEntry[]>,
    injectedMessageTrailMaxEntries: number,
    injectedMockState: SyntheticMockState,
    injectedWindow: { __mockFireMessageTrail: typeof fireMessageTrail },
  ) => SetMessageTrailFunction;
  return factory(messageTrails, messageTrailMaxEntries, mockState, { __mockFireMessageTrail: fireMessageTrail });
}

describe('trailAt() extracted from buildDemoPreConfig\'s generated script', () => {
  it('includes an entry whose t equals offsetMs, and excludes one strictly greater', () => {
    const trailAt = buildTrailAt(
      {
        'sess-boundary': [
          { t: 100, uuid: 'entry-at-boundary', ts: 1000, text: 'at the boundary' },
          { t: 200, uuid: 'entry-after-boundary', ts: 2000, text: 'after the boundary' },
        ],
      },
      // A cap large enough that slicing cannot mask the boundary check under test here.
      10,
    );
    expect(trailAt('sess-boundary', 100)).toEqual([
      { uuid: 'entry-at-boundary', ts: 1000, text: 'at the boundary' },
    ]);
    expect(trailAt('sess-boundary', 99)).toEqual([]);
  });

  it('keeps only the newest messageTrailMaxEntries once the offset has passed every line', () => {
    const entries: DemoMessageTrailEntry[] = Array.from({ length: 7 }, (_placeholder, index) => ({
      t: (index + 1) * 10,
      uuid: `entry-${index}`,
      ts: (index + 1) * 1000,
      text: `line ${index}`,
    }));
    // An offset well past every entry's t, so only the cap (not the boundary check) can be
    // responsible for trimming the result.
    const trailAt = buildTrailAt({ 'sess-cap': entries }, 3);
    const visible = trailAt('sess-cap', 100000);
    expect(visible.map((entry) => entry.uuid)).toEqual(['entry-4', 'entry-5', 'entry-6']);
  });
});

describe('setMessageTrail() extracted from buildDemoPreConfig\'s generated script', () => {
  it('sets an empty trail (cache write and announce) for a session present in messageTrails whose offset is before its first line', () => {
    const mockState: SyntheticMockState = {
      sessions: [{ id: 'sess-present', projectId: 'proj-present' }],
      messageTrailCache: {},
    };
    const fireMessageTrail = vi.fn();
    // "sess-present" IS a key of messageTrails, with one entry recorded well after offset 0 - the
    // exact shape restartSession's loop=1 call produces: Math.max(0, durationMs - tail) can land
    // before a short recording's first line.
    const setMessageTrail = buildSetMessageTrail(
      { 'sess-present': [{ t: 5000, uuid: 'first-line', ts: 111, text: 'hello' }] },
      5,
      mockState,
      fireMessageTrail,
    );

    setMessageTrail('sess-present', 0);

    expect(mockState.messageTrailCache['sess-present']).toEqual([]);
    expect(fireMessageTrail).toHaveBeenCalledWith('sess-present', [], 'proj-present');
  });

  it('skips a session absent from messageTrails, leaving its cache and listeners untouched', () => {
    const staleCachedTrail: VisibleTrailEntry[] = [{ uuid: 'stale', ts: 1, text: 'left over from a previous cycle' }];
    const mockState: SyntheticMockState = {
      sessions: [{ id: 'sess-absent', projectId: 'proj-absent' }],
      messageTrailCache: { 'sess-absent': staleCachedTrail },
    };
    const fireMessageTrail = vi.fn();
    // "sess-absent" has no key in messageTrails at all (a Command Terminal, an agent with no
    // transcript parser, or a capture whose prose was all thinking blocks - see
    // demo-message-trail-seeded.test.ts's EMPTY_TRAIL_REASONS).
    const setMessageTrail = buildSetMessageTrail({}, 5, mockState, fireMessageTrail);

    setMessageTrail('sess-absent', 0);

    expect(mockState.messageTrailCache['sess-absent']).toBe(staleCachedTrail);
    expect(fireMessageTrail).not.toHaveBeenCalled();
  });
});

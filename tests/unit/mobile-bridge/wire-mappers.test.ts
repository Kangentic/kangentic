/**
 * Unit tests for toBoardTaskWire and toBoardColumnWire
 * (src/main/mobile-bridge/handlers/wire-mappers.ts). No existing suite
 * exercises either mapper directly - read-board.test.ts covers
 * handleReadBoard end to end but stubs raw partial rows, never a full Task
 * or Swimlane.
 */
import { describe, it, expect } from 'vitest';
import {
  columnSpawnsSession,
  SPAWN_PROGRESS_LABEL_WIRE_MAX_LENGTH,
  toBoardColumnWire,
  toBoardTaskWire,
  toSpawnProgressLabelWire,
} from '../../../src/main/mobile-bridge/handlers/wire-mappers';
import { parseBoardColumnWire, parseBoardTaskWire } from '@kangentic/protocol';
import type { JsonValue } from '@kangentic/protocol';
import type { Swimlane, Task } from '../../../src/shared/types';

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-1',
    display_id: 1,
    title: 'Task',
    description: 'Description',
    swimlane_id: 'lane-1',
    position: 0,
    agent: null,
    session_id: null,
    worktree_path: null,
    worktree_folder: null,
    worktree_skip_reason: null,
    branch_name: null,
    pr_number: null,
    pr_url: null,
    pr_state: null,
    pr_merge_readiness: null,
    head_sha: null,
    pushed_branch: null,
    base_branch: null,
    use_worktree: null,
    labels: [],
    priority: 0,
    attachment_count: 0,
    run_mode: 'column_settings',
    archived_at: null,
    created_at: '2026-04-17T00:00:00.000Z',
    updated_at: '2026-04-17T00:00:00.000Z',
    ...overrides,
  } as Task;
}

describe('toBoardTaskWire', () => {
  /** A task with no paused session, for the tests that are not about pausing. */
  const notPaused = { paused: false, resumable: false };

  it('carries a judged pr_merge_readiness value through to the wire shape', () => {
    const task = makeTask({ pr_merge_readiness: 'ready' });
    expect(toBoardTaskWire(task, null, notPaused).pr_merge_readiness).toBe('ready');
  });

  it('passes null through when the PR has no judged readiness', () => {
    const task = makeTask({ pr_merge_readiness: null });
    expect(toBoardTaskWire(task, null, notPaused).pr_merge_readiness).toBeNull();
  });

  it('carries the spawn-progress label, and null when none is in flight', () => {
    expect(toBoardTaskWire(makeTask(), 'Waiting (2 ahead)', notPaused).spawn_progress).toBe('Waiting (2 ahead)');
    expect(toBoardTaskWire(makeTask(), null, notPaused).spawn_progress).toBeNull();
  });

  it('the label survives the phone-side parse', () => {
    const wire = toBoardTaskWire(makeTask(), 'Switching model...', notPaused);
    expect(parseBoardTaskWire(wire as unknown as JsonValue).spawn_progress).toBe('Switching model...');
  });

  it('carries resumable as given, true and false, through the phone-side parse', () => {
    expect(parseBoardTaskWire(toBoardTaskWire(makeTask(), null, { paused: true, resumable: true }) as unknown as JsonValue).resumable).toBe(true);
    expect(parseBoardTaskWire(toBoardTaskWire(makeTask(), null, notPaused) as unknown as JsonValue).resumable).toBe(false);
  });

  it('carries paused as given, apart from resumable, through the phone-side parse', () => {
    // A paused task in Done: paused, but no Resume on offer.
    const pausedInDone = parseBoardTaskWire(toBoardTaskWire(makeTask(), null, { paused: true, resumable: false }) as unknown as JsonValue);
    expect(pausedInDone.paused).toBe(true);
    expect(pausedInDone.resumable).toBe(false);
    expect(parseBoardTaskWire(toBoardTaskWire(makeTask(), null, notPaused) as unknown as JsonValue).paused).toBe(false);
  });

  it('sanitizes the label it puts on the wire, so a raw git line never reaches the phone as-is', () => {
    const wire = toBoardTaskWire(makeTask(), '\u001b[32mReceiving objects:\u001b[0m 45%\r', notPaused);
    expect(wire.spawn_progress).toBe('Receiving objects: 45%');
  });
});

describe('toSpawnProgressLabelWire', () => {
  it('leaves an ordinary label untouched', () => {
    expect(toSpawnProgressLabelWire('Starting agent... (base 3 behind)')).toBe('Starting agent... (base 3 behind)');
  });

  it('passes null through', () => {
    expect(toSpawnProgressLabelWire(null)).toBeNull();
  });

  it('strips color codes, an OSC title sequence, and stray control characters', () => {
    const raw = '\u001b]0;title\u0007\u001b[1;33mResolving deltas:\u001b[0m\u0008 100%\u0000';
    expect(toSpawnProgressLabelWire(raw)).toBe('Resolving deltas: 100%');
  });

  it('turns carriage returns, line feeds and tabs into single spaces and trims the ends', () => {
    expect(toSpawnProgressLabelWire('\rCounting objects:\t 10%\r\nCounting objects: 20%\n')).toBe('Counting objects: 10% Counting objects: 20%');
  });

  it.each([
    ['a vertical tab', '\u000b'],
    ['a form feed', '\u000c'],
    ['the C1 next line', '\u0085'],
  ])('turns %s into a space rather than joining the words around it', (_name, lineBreak) => {
    expect(toSpawnProgressLabelWire(`Running "lint${lineBreak}and test"...`)).toBe('Running "lint and test"...');
  });

  it('a label with nothing printable left is null', () => {
    expect(toSpawnProgressLabelWire('\u001b[2K\r  \n')).toBeNull();
  });

  it(`caps a long label at ${SPAWN_PROGRESS_LABEL_WIRE_MAX_LENGTH} code points, ending in "..."`, () => {
    const capped = toSpawnProgressLabelWire('x'.repeat(500));
    expect(capped).toBe(`${'x'.repeat(SPAWN_PROGRESS_LABEL_WIRE_MAX_LENGTH - 3)}...`);
  });

  it('counts code points, so the cap never splits an emoji in half', () => {
    const capped = toSpawnProgressLabelWire('\u{1F680}'.repeat(200));
    expect(capped).toBe(`${'\u{1F680}'.repeat(SPAWN_PROGRESS_LABEL_WIRE_MAX_LENGTH - 3)}...`);
    expect(Array.from(capped ?? '')).toHaveLength(SPAWN_PROGRESS_LABEL_WIRE_MAX_LENGTH);
  });

  it('a label exactly at the cap is not truncated', () => {
    const atCap = 'y'.repeat(SPAWN_PROGRESS_LABEL_WIRE_MAX_LENGTH);
    expect(toSpawnProgressLabelWire(atCap)).toBe(atCap);
  });

  it('a cut that lands on whitespace drops it, so the ellipsis never trails a space', () => {
    // The slice keeps SPAWN_PROGRESS_LABEL_WIRE_MAX_LENGTH - 3 characters: the
    // run of 'a' plus the space that follows it. The space must not survive
    // in front of the "...".
    const wordLength = SPAWN_PROGRESS_LABEL_WIRE_MAX_LENGTH - 4;
    const capped = toSpawnProgressLabelWire(`${'a'.repeat(wordLength)} ${'b'.repeat(50)}`);
    expect(capped).toBe(`${'a'.repeat(wordLength)}...`);
  });

  it('strips bidi controls and invisible characters from an automation name, so it cannot render as different text', () => {
    // An override (U+202E) and an isolate pair (U+2066, U+2069) reorder what
    // follows; a mark (U+200F), a zero-width space (U+200B) and a byte order
    // mark (U+FEFF) show nothing.
    const label = 'Running "\u{202E}deploy\u{202C} \u{2066}prod\u{2069}\u{200F}\u{200B}\u{FEFF}"...';
    expect(toSpawnProgressLabelWire(label)).toBe('Running "deploy prod"...');
  });

  it('strips the Arabic letter mark and the word joiner, and turns the Unicode line and paragraph separators into spaces', () => {
    const label = 'Running "\u{061C}deploy\u{2060}\u{2028}prod\u{2029}eu"...';
    expect(toSpawnProgressLabelWire(label)).toBe('Running "deploy prod eu"...');
  });

  it('keeps the zero-width joiner, which an emoji sequence needs', () => {
    const technologist = '\u{1F9D1}\u{200D}\u{1F4BB}';
    expect(toSpawnProgressLabelWire(`Running "${technologist} review"...`)).toBe(`Running "${technologist} review"...`);
  });

  it('strips the soft hyphen and the invisible math operators', () => {
    const label = 'Running "de\u{00AD}ploy\u{2061}\u{2062}\u{2063}\u{2064}"...';
    expect(toSpawnProgressLabelWire(label)).toBe('Running "deploy"...');
  });

  it('strips tag characters, which render as nothing and can spell a hidden string', () => {
    // "ignore" written in tag letters, then a stray cancel tag.
    const hidden = '\u{E0069}\u{E0067}\u{E006E}\u{E006F}\u{E0072}\u{E0065}\u{E007F}';
    expect(toSpawnProgressLabelWire(`Running "deploy${hidden}"...`)).toBe('Running "deploy"...');
  });

  // The black flag, a code in tag letters, then the cancel tag.
  const ENGLAND = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0065}\u{E006E}\u{E0067}\u{E007F}';
  const SCOTLAND = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F}';
  const WALES = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0077}\u{E006C}\u{E0073}\u{E007F}';

  it.each([
    ['England', ENGLAND],
    ['Scotland', SCOTLAND],
    ['Wales', WALES],
  ])('keeps the %s flag, one of the three emoji spelled with tag characters', (_name, flag) => {
    expect(toSpawnProgressLabelWire(`Running "${flag} deploy"...`)).toBe(`Running "${flag} deploy"...`);
  });

  it('strips hidden text wrapped in a black flag and a cancel tag, keeping only the black flag', () => {
    // "ignoreprevious" in tag letters: shaped like a flag, but not one of the three.
    const tagLetters = Array.from('ignoreprevious', (letter) => String.fromCodePoint(0xE0000 + (letter.codePointAt(0) ?? 0))).join('');
    const disguised = `\u{1F3F4}${tagLetters}\u{E007F}`;
    expect(toSpawnProgressLabelWire(`Running "deploy${disguised}"...`)).toBe('Running "deploy\u{1F3F4}"...');
  });

  it('strips the tags after a black flag that do not close as a flag, and keeps the flag', () => {
    const unterminated = '\u{1F3F4}\u{E0067}\u{E0062}';
    expect(toSpawnProgressLabelWire(`Running "${unterminated} deploy"...`)).toBe('Running "\u{1F3F4} deploy"...');
  });

  it('a cut through a kept flag leaves no tag characters before the ellipsis', () => {
    // The cap keeps 117 code points: 114 of padding, the black flag, and the
    // flag's first two tags, which the second strip drops.
    const label = `${'x'.repeat(114)}${SCOTLAND} deploy`;
    expect(toSpawnProgressLabelWire(label)).toBe(`${'x'.repeat(114)}\u{1F3F4}...`);
  });
});

function makeSwimlane(overrides: Partial<Swimlane> = {}): Swimlane {
  return {
    id: 'lane-1',
    name: 'Column',
    description: null,
    role: null,
    position: 0,
    color: '#00ff00',
    icon: null,
    is_archived: false,
    is_ghost: false,
    permission_mode: null,
    auto_spawn: true,
    auto_command: null,
    auto_command_mode: 'immediate',
    plan_exit_target_id: null,
    agent_override: null,
    model_override: null,
    effort_override: null,
    handoff_context: false,
    session_target: 'main',
    session_spawn_strategy: 'create_or_resume',
    created_at: '2026-04-17T00:00:00.000Z',
    ...overrides,
  };
}

describe('columnSpawnsSession', () => {
  it('is false for a role:todo column, even with auto_spawn true', () => {
    expect(columnSpawnsSession(makeSwimlane({ role: 'todo', auto_spawn: true }))).toBe(false);
  });

  it('is false for a role:done column, even with auto_spawn true', () => {
    expect(columnSpawnsSession(makeSwimlane({ role: 'done', auto_spawn: true }))).toBe(false);
  });

  it('is false for a custom column with auto_spawn false', () => {
    expect(columnSpawnsSession(makeSwimlane({ role: null, auto_spawn: false }))).toBe(false);
  });

  it('is true for a custom column with auto_spawn true', () => {
    expect(columnSpawnsSession(makeSwimlane({ role: null, auto_spawn: true }))).toBe(true);
  });

  it('is a real boolean, never undefined, for a malformed auto_spawn', () => {
    const malformed = makeSwimlane({ role: null }) as Swimlane;
    // @ts-expect-error - simulating a malformed row with a missing auto_spawn
    delete malformed.auto_spawn;
    expect(columnSpawnsSession(malformed)).toBe(false);
  });
});

describe('toBoardColumnWire', () => {
  it('carries spawns_session computed from role and auto_spawn', () => {
    expect(toBoardColumnWire(makeSwimlane({ role: 'todo', auto_spawn: true })).spawns_session).toBe(false);
    expect(toBoardColumnWire(makeSwimlane({ role: null, auto_spawn: true })).spawns_session).toBe(true);
  });

  it('passes role through unchanged', () => {
    expect(toBoardColumnWire(makeSwimlane({ role: 'done' })).role).toBe('done');
    expect(toBoardColumnWire(makeSwimlane({ role: null })).role).toBeNull();
  });
});

describe('toBoardColumnWire round-trips through parseBoardColumnWire', () => {
  // The mapper (this file's producer) and the parser (packages/protocol's
  // consumer) are otherwise only ever tested independently, so a field-name
  // drift between the two (spawnsSession vs spawns_session, a renamed
  // is_ghost) would pass both suites while breaking the real bridge. This
  // sends a mapped column through an actual wire round trip
  // (JSON.parse(JSON.stringify(...))) the way the bridge does, then asserts
  // the parser reproduces the mapper's output exactly.
  function roundTrip(swimlane: Swimlane) {
    const wire = toBoardColumnWire(swimlane);
    const overWire = JSON.parse(JSON.stringify(wire)) as JsonValue;
    return { wire, parsed: parseBoardColumnWire(overWire) };
  }

  it('round-trips a role:done column', () => {
    const { wire, parsed } = roundTrip(makeSwimlane({ role: 'done', auto_spawn: true }));
    expect(parsed).toEqual(wire);
  });

  it('round-trips a role:null, auto_spawn:true column', () => {
    const { wire, parsed } = roundTrip(makeSwimlane({ role: null, auto_spawn: true }));
    expect(parsed).toEqual(wire);
  });
});

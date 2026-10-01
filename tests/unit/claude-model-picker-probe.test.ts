/**
 * Tests for the hidden /model picker probe: the VT screen-grid renderer,
 * the picker parser with its display-name to id derivation, and the spawn
 * orchestration (markers, trust-dialog bail, Esc-not-Enter teardown,
 * success/failure caching).
 *
 * The picker fixtures mirror two empirically captured layouts: Claude Code
 * 2.1.170 (probe run 2026-06-09), whose family rows carry a bare alias label,
 * and Claude Code 2.1.284 on a Claude Max account (probe run 2026-09-28),
 * whose rows are all versioned names and which scrolls past ten rows.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('node-pty', () => ({
  spawn: vi.fn(),
}));

// The probe pre-trusts its scratch cwd by writing ~/.claude.json - never
// touch the real file from a unit test.
vi.mock('../../src/main/agent/adapters/claude/trust-manager', () => ({
  ensureWorktreeTrust: vi.fn(async () => undefined),
}));

import * as pty from 'node-pty';
import {
  VirtualScreen,
  parseModelPickerScreen,
  mergePickerFrames,
  probeModelPickerModels,
  getCachedModelPickerModels,
  peekModelPickerAliasIds,
  resetModelPickerProbeForTests,
  setModelPickerProbeTimingsForTests,
  setModelPickerProbeScanFileForTests,
  type ModelPickerScan,
} from '../../src/main/agent/adapters/claude/model-picker-probe';

const spawnMock = pty.spawn as unknown as ReturnType<typeof vi.fn>;

interface FakePtyProcess {
  emitData: (data: string) => void;
  emitExit: () => void;
  writes: string[];
  /** performance.now() at the moment each entry in `writes` was recorded. */
  writeTimestamps: number[];
  killMock: ReturnType<typeof vi.fn>;
}

/**
 * Install a scripted fake PTY. `onWrite` sees every chunk the probe sends
 * and can emit response frames, mimicking the TUI round trip.
 */
function installFakePty(
  onSpawn?: (fake: FakePtyProcess) => void,
  onWrite?: (input: string, fake: FakePtyProcess) => void,
): FakePtyProcess {
  let dataCallback: ((data: string) => void) | null = null;
  let exitCallback: (() => void) | null = null;
  const fake: FakePtyProcess = {
    emitData: (data: string) => dataCallback?.(data),
    emitExit: () => exitCallback?.(),
    writes: [],
    writeTimestamps: [],
    killMock: vi.fn(),
  };
  spawnMock.mockImplementation(() => {
    // A later turn, as node-pty delivers real output: never inside the
    // microtasks that follow the spawn call (the probe awaits its spawn).
    setTimeout(() => onSpawn?.(fake), 0);
    return {
      onData: (callback: (data: string) => void) => {
        dataCallback = callback;
      },
      onExit: (callback: () => void) => {
        exitCallback = callback;
      },
      write: (input: string) => {
        fake.writes.push(input);
        fake.writeTimestamps.push(performance.now());
        onWrite?.(input, fake);
      },
      kill: fake.killMock,
    };
  });
  return fake;
}

const PROMPT_FRAME = '❯ Try "how does <filepath> work?"\r\n';

const PICKER_FRAME = [
  '',
  '  Select model',
  '  Switch between Claude models. Your pick becomes the default for new sessions.',
  '    1. Default (recommended)  Opus 4.8 with 1M context · Best for everyday, complex tasks',
  '    2. Fable                  Fable 5 · Most capable for your hardest tasks · Uses your limits ~2× faster than Opus',
  '    3. Sonnet                 Sonnet 4.6 · Efficient for routine tasks',
  '    4. Haiku                  Haiku 4.5 · Fastest for quick answers',
  '  ❯ 5. Opus 4.8 ✔             Best for everyday, complex tasks (claude-opus-4-8)',
  '',
  '  Enter to set as default · Esc to cancel',
].join('\r\n');

/** The stable frame the probe read from Claude Code 2.1.284, copied verbatim from the grid. */
const PICKER_FRAME_2_1_284 = [
  '❯ /model',
  '',
  '────────────────────────────────────────',
  '  Select model',
  '  Switch between Claude models. Your pick becomes the default for new sessions. For other/previous model names, specify with --model.',
  '',
  '  ❯ 1.  Default (recommended) ✔  Opus 5.5 · Best for everyday, complex tasks',
  '    2.  Opus 5.5                 For complex work and everyday tasks',
  '    3.  Fable 5.1                For your toughest challenges',
  '    4.  Sonnet 5.5               Most efficient for simpler tasks',
  '    5.  Haiku 4.5                Fastest for quick answers',
  '    6.  Sonnet 5                 Efficient for routine tasks',
  '    7.  Opus 5                   Best for everyday, complex tasks',
  '    8.  Fable 5                  Most capable for your hardest and longest-running tasks',
  '    9.  Opus 4.8                 Best for everyday, complex tasks',
  '  ↓ 10. Opus 4.7                 Best for everyday, complex tasks',
  '     … +2 models',
  '',
  '  ● High effort ←/→ to adjust',
  '',
  '  Enter to set as default · s to use this session only · Esc to cancel',
].join('\n');

beforeEach(() => {
  spawnMock.mockReset();
  resetModelPickerProbeForTests();
  setModelPickerProbeTimingsForTests({
    pollIntervalMs: 5,
    typeDelayMs: 5,
    settleIntervalMs: 5,
    overallTimeoutMs: 2000,
    exitGraceMs: 5,
  });
});

/**
 * The teardown is detached from the probe's result (the models are final
 * before it runs), so the fallback kill lands a few ms after the promise
 * resolves - poll for it rather than asserting synchronously.
 */
function expectFallbackKill(fake: FakePtyProcess): Promise<void> {
  return vi.waitFor(() => expect(fake.killMock).toHaveBeenCalled());
}

describe('VirtualScreen', () => {
  it('renders cursor-forward gaps as spaces instead of dropping them', () => {
    const screen = new VirtualScreen(20, 2);
    screen.write('AB\x1b[3CC');
    expect(screen.text()).toBe('AB   C\n');
  });

  it('applies absolute cursor positioning repaints over existing text', () => {
    const screen = new VirtualScreen(20, 2);
    screen.write('hello');
    screen.write('\x1b[1;1HJ');
    expect(screen.text()).toBe('Jello\n');
  });

  it('handles erase-character (ECH) without moving the cursor', () => {
    const screen = new VirtualScreen(20, 2);
    screen.write('hello');
    screen.write('\x1b[1;2H\x1b[2X');
    expect(screen.text()).toBe('h  lo\n');
  });

  it('clears to end of line on EL', () => {
    const screen = new VirtualScreen(20, 2);
    screen.write('hello');
    screen.write('\x1b[1;3H\x1b[K');
    expect(screen.text()).toBe('he\n');
  });

  it('scrolls when line feeds run past the bottom row', () => {
    const screen = new VirtualScreen(20, 2);
    screen.write('a\r\nb\r\nc');
    expect(screen.text()).toBe('b\nc');
  });

  it('ignores SGR color sequences and OSC titles', () => {
    const screen = new VirtualScreen(20, 2);
    screen.write('\x1b[38;2;177;185;249m\x1b]0;window title\x07X\x1b[m');
    expect(screen.text()).toBe('X\n');
  });

  // Widths come from wcwidthV11 - the same Unicode 11 table every xterm in
  // the app runs - so this grid wraps where an agent TUI that pads rows to
  // the full width (counting emoji as double) expects it to (task #557).
  it('a wide emoji occupies two columns, so an absolute reposition lands after it', () => {
    const screen = new VirtualScreen(20, 2);
    screen.write('A✅');
    screen.write('\x1b[1;4HB');
    expect(screen.text()).toBe('A✅B\n');
  });

  it('a wide char that does not fit wraps whole instead of straddling the row edge', () => {
    // Exactly ONE column remains when the emoji arrives, so only the
    // width-aware `cursorColumn + width > cols` guard wraps it; the old
    // single-width `cursorColumn >= cols` check would straddle it across the
    // row edge.
    const screen = new VirtualScreen(3, 2);
    screen.write('ab✅C');
    expect(screen.text()).toBe('ab\n✅C');
  });

  it('a wide char that fits exactly at the row edge does not wrap', () => {
    // Exactly TWO columns remain when the emoji arrives, so it fits flush
    // against the edge (`cursorColumn + width === cols`). The neighbor test
    // above only pins the strict `>` side of the guard - reverting to the
    // old `cursorColumn >= cols` check would already fail there. A weakened
    // `cursorColumn + width >= cols` would NOT fail there (4 >= 3 is still
    // true, still wraps) but would wrongly wrap this exact-fit case one
    // glyph early.
    const screen = new VirtualScreen(4, 2);
    screen.write('ab✅');
    expect(screen.text()).toBe('ab✅\n');
  });

  it('an astral emoji never splits its surrogate pair across cells or rows', () => {
    const screen = new VirtualScreen(3, 2);
    screen.write('ab😀c');
    expect(screen.text()).toBe('ab\n😀c');
  });

  it('a combining mark joins the previous cell instead of occupying its own', () => {
    const screen = new VirtualScreen(20, 2);
    screen.write('e\u0301');
    screen.write('\x1b[1;2Hz');
    expect(screen.text()).toBe('e\u0301z\n');
  });

  it('a combining mark with nothing before it drops instead of taking a cell', () => {
    const screen = new VirtualScreen(20, 2);
    screen.write('\u0301x');
    expect(screen.text()).toBe('x\n');
  });

  it('a combining mark after a wide glyph attaches to the glyph, not its spacer cell', () => {
    const screen = new VirtualScreen(20, 2);
    screen.write('\u2705\u0301');
    // text()'s join('') cannot show WHICH cell holds the mark: a correct
    // attach (glyph's cell) and a wrong one (the spacer cell beside it)
    // render identically until something overwrites the spacer. Positioning
    // onto the spacer and overwriting it is the only way to observe that the
    // mark survived in the glyph's cell instead of being destroyed here.
    screen.write('\x1b[1;2HX');
    expect(screen.text()).toBe('\u2705\u0301X\n');
  });

  it('drops width-0 DEL/C1 controls instead of gluing them onto the previous cell', () => {
    // wcwidthV11 scores DEL (0x7f) and the C1 range (0x80-0x9f, e.g. 0x85)
    // as width 0, same as a genuine combining mark - but putChar's
    // `codepoint >= 0xa0` guard keeps them from reaching appendCombining, so
    // a stray control byte in a parsed label is dropped instead of
    // corrupting the preceding cell.
    const screen = new VirtualScreen(20, 2);
    screen.write('A\x7f\x85B');
    expect(screen.text()).toBe('AB\n');
  });
});

describe('parseModelPickerScreen', () => {
  it('extracts ids from the 2.1.170 picker layout', () => {
    const screenText = PICKER_FRAME.replace(/\r/gu, '');
    expect(parseModelPickerScreen(screenText).models).toEqual([
      'claude-opus-4-8',
      'claude-fable-5',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
    ]);
  });

  it('extracts every row of the 2.1.284 picker, including the scroll-marked tenth row', () => {
    expect(parseModelPickerScreen(PICKER_FRAME_2_1_284).models).toEqual([
      'claude-opus-5-5',
      'claude-fable-5-1',
      'claude-sonnet-5-5',
      'claude-haiku-4-5',
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-fable-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
    ]);
  });

  it('prefers an explicit (claude-...) id over derivation', () => {
    const screenText = [
      'Select model',
      '  ❯ 1. Opus 4.8 ✔   Best for everyday tasks (claude-opus-4-8-20260101)',
    ].join('\n');
    expect(parseModelPickerScreen(screenText).models).toEqual(['claude-opus-4-8-20260101']);
  });

  it('derives ids from versioned display names', () => {
    const screenText = [
      'Select model',
      '    1. Fable    Fable 5 · Most capable',
      '    2. Sonnet   Sonnet 4.6 · Efficient',
    ].join('\n');
    expect(parseModelPickerScreen(screenText).models).toEqual(['claude-fable-5', 'claude-sonnet-4-6']);
  });

  it('skips rows that fit neither pattern instead of failing', () => {
    const screenText = [
      'Select model',
      '    1. Custom    Configured by your organization',
      '    2. Haiku     Haiku 4.5 · Fastest',
    ].join('\n');
    expect(parseModelPickerScreen(screenText).models).toEqual(['claude-haiku-4-5']);
  });

  it('reads a "↑" scroll-marked row as a model exactly once, in row order', () => {
    const scan = parseModelPickerScreen([
      'Select model',
      '  ❯ 1.  Opus 5.5                 For complex work and everyday tasks',
      '  ↑ 2.  Sonnet 5.5               Most efficient for simpler tasks',
      '    3.  Haiku 4.5                Fastest for quick answers',
    ].join('\n'));
    expect(scan.models).toEqual(['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5']);
    expect(scan.aliases).toEqual([
      { id: 'opus', resolvesTo: 'claude-opus-5-5' },
      { id: 'sonnet', resolvesTo: 'claude-sonnet-5-5' },
      { id: 'haiku', resolvesTo: 'claude-haiku-4-5' },
    ]);
  });

  it('returns nothing when the Select model header is missing', () => {
    expect(parseModelPickerScreen('❯ 1. Yes, I trust this folder')).toEqual({ models: [], aliases: [] });
  });

  it('ignores numbered rows above the header', () => {
    const screenText = [
      '    1. Stale 9.9   Leftover row from an earlier overlay',
      'Select model',
      '    1. Haiku       Haiku 4.5 · Fastest',
    ].join('\n');
    expect(parseModelPickerScreen(screenText).models).toEqual(['claude-haiku-4-5']);
  });
});

describe('parseModelPickerScreen aliases', () => {
  it('derives one alias per family from the 2.1.284 versioned rows, resolving to the newest', () => {
    // The Default row names Opus 5.5 only in its description, so it is not a
    // family row: opus takes its target from row 2 like every other family.
    expect(parseModelPickerScreen(PICKER_FRAME_2_1_284).aliases).toEqual([
      { id: 'opus', resolvesTo: 'claude-opus-5-5' },
      { id: 'fable', resolvesTo: 'claude-fable-5-1' },
      { id: 'sonnet', resolvesTo: 'claude-sonnet-5-5' },
      { id: 'haiku', resolvesTo: 'claude-haiku-4-5' },
    ]);
  });

  it('derives aliases from the 2.1.170 bare family labels and the active explicit-id row', () => {
    const screenText = PICKER_FRAME.replace(/\r/gu, '');
    expect(parseModelPickerScreen(screenText).aliases).toEqual([
      { id: 'fable', resolvesTo: 'claude-fable-5' },
      { id: 'sonnet', resolvesTo: 'claude-sonnet-4-6' },
      { id: 'haiku', resolvesTo: 'claude-haiku-4-5' },
      { id: 'opus', resolvesTo: 'claude-opus-4-8' },
    ]);
  });

  it('keeps an active alias row whose label carries the selection check', () => {
    const screenText = [
      'Select model',
      '    1. Default (recommended)  Opus 5.5 · Best for everyday, complex tasks',
      '  ❯ 2. Sonnet ✔               Sonnet 5.5 · Efficient for routine tasks',
    ].join('\n');
    expect(parseModelPickerScreen(screenText).aliases).toEqual([
      { id: 'sonnet', resolvesTo: 'claude-sonnet-5-5' },
    ]);
  });

  it('resolves to the highest version whatever the row order', () => {
    const screenText = [
      'Select model',
      '    1. Sonnet 4.6                Legacy',
      '    2. Sonnet 5.5                Most efficient for simpler tasks',
      '    3. Sonnet 5                  Previous Sonnet version',
    ].join('\n');
    expect(parseModelPickerScreen(screenText).aliases).toEqual([
      { id: 'sonnet', resolvesTo: 'claude-sonnet-5-5' },
    ]);
  });

  it('folds a (1M context) row into its family instead of offering a separate alias', () => {
    const screenText = [
      'Select model',
      '    1. Opus (1M context)         Opus 5.5 with 1M context · Best for everyday, complex tasks',
      '    2. Sonnet 4.6 (1M context)   Sonnet 4.6 with 1M context',
    ].join('\n');
    expect(parseModelPickerScreen(screenText).aliases).toEqual([
      { id: 'opus', resolvesTo: 'claude-opus-5-5' },
      { id: 'sonnet', resolvesTo: 'claude-sonnet-4-6' },
    ]);
  });

  it('strips a dated pin from the resolved target', () => {
    const screenText = [
      'Select model',
      '  ❯ 1. Opus 4.8 ✔   Best for everyday tasks (claude-opus-4-8-20260101)',
    ].join('\n');
    expect(parseModelPickerScreen(screenText).aliases).toEqual([
      { id: 'opus', resolvesTo: 'claude-opus-4-8' },
    ]);
  });

  it('offers no alias for rows whose label is not the model family itself', () => {
    const screenText = [
      'Select model',
      '    1. Default (recommended)     Opus 5.5 · Best for everyday, complex tasks',
      '    2. Opus Plan Mode            Use Opus 5.5 in plan mode, Sonnet 5.5 otherwise',
      '    3. Workhorse                 Sonnet 5.5 · Custom Sonnet model',
      '    4. claude-haiku-4-5          Custom Haiku model',
    ].join('\n');
    expect(parseModelPickerScreen(screenText).aliases).toEqual([]);
  });
});

describe('probeModelPickerModels', () => {
  it('drives the picker end to end and parses the rendered models', async () => {
    const fake = installFakePty(
      (self) => self.emitData(PROMPT_FRAME),
      (input, self) => {
        if (input === '\r') self.emitData(PICKER_FRAME);
      },
    );

    const scan = await probeModelPickerModels('/usr/bin/claude');
    expect(scan?.models).toEqual([
      'claude-opus-4-8',
      'claude-fable-5',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
    ]);
    expect(scan?.aliases.map((alias) => alias.id)).toEqual(['fable', 'sonnet', 'haiku', 'opus']);
    // Opened with /model + Enter, closed with Esc (never a selecting Enter),
    // then, a type delay later so the two cannot coalesce into one escape
    // sequence, the CLI is asked to exit like a user would; the kill is only
    // the fallback once the grace passes with no exit.
    await expectFallbackKill(fake);
    expect(fake.writes).toEqual(['/model', '\r', '\x1b', '/exit\r']);
  });

  it('waits the settle delay between closing the picker and sending /exit, so Esc and /exit cannot coalesce into one escape burst', async () => {
    // A larger, explicit typeDelayMs than the shared beforeEach default, so
    // the gap is comfortably measurable above event-loop jitter on a slow
    // CI runner. Every field is restated because setModelPickerProbeTimingsForTests
    // merges overrides onto DEFAULT_TIMINGS, not onto the current timings.
    setModelPickerProbeTimingsForTests({
      pollIntervalMs: 5,
      typeDelayMs: 60,
      settleIntervalMs: 5,
      overallTimeoutMs: 2000,
      exitGraceMs: 500,
    });
    const fake = installFakePty(
      (self) => self.emitData(PROMPT_FRAME),
      (input, self) => {
        if (input === '\r') self.emitData(PICKER_FRAME);
        if (input === '/exit\r') self.emitExit();
      },
    );

    await probeModelPickerModels('/usr/bin/claude');
    // The teardown's /exit write happens after the probe's own promise
    // settles (see the module comment: detached on purpose), so poll for it
    // rather than asserting synchronously.
    await vi.waitFor(() => expect(fake.writes).toContain('/exit\r'));

    const escapeIndex = fake.writes.indexOf('\x1b');
    const exitIndex = fake.writes.indexOf('/exit\r');
    expect(escapeIndex).toBeGreaterThanOrEqual(0);
    expect(exitIndex).toBe(escapeIndex + 1);

    const gapMs = fake.writeTimestamps[exitIndex] - fake.writeTimestamps[escapeIndex];
    // Cross-platform: never assert an exact duration. The configured settle
    // is 60 ms; a floor well below that (but far above the near-zero gap an
    // unpaced write would produce) distinguishes the delay from its absence
    // without flaking under CI load.
    expect(gapMs).toBeGreaterThanOrEqual(30);
  });

  it('skips the fallback kill when the CLI exits on its own after /exit', async () => {
    const fake = installFakePty(
      (self) => self.emitData(PROMPT_FRAME),
      (input, self) => {
        if (input === '\r') self.emitData(PICKER_FRAME);
        if (input === '/exit\r') self.emitExit();
      },
    );

    const scan = await probeModelPickerModels('/usr/bin/claude');
    expect(scan?.models).toHaveLength(4);
    // Well past the 5 ms test grace: a kill that was going to land has landed.
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(fake.killMock).not.toHaveBeenCalled();
  });

  it('runs the CLI on the classic renderer, which never arms the fullscreen boot canary', async () => {
    installFakePty(
      (self) => self.emitData(PROMPT_FRAME),
      (input, self) => {
        if (input === '\r') self.emitData(PICKER_FRAME);
      },
    );

    await probeModelPickerModels('/usr/bin/claude');
    const [, , options] = spawnMock.mock.calls[0];
    expect(options.env.CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN).toBe('1');
  });

  it('spawns the CLI with --safe-mode in the scratch cwd', async () => {
    installFakePty(
      (self) => self.emitData(PROMPT_FRAME),
      (input, self) => {
        if (input === '\r') self.emitData(PICKER_FRAME);
      },
    );

    await probeModelPickerModels('/usr/bin/claude');
    const [command, args, options] = spawnMock.mock.calls[0];
    if (process.platform === 'win32') {
      expect(command).toBe('cmd.exe');
      expect(args).toEqual(['/c', '/usr/bin/claude', '--safe-mode']);
    } else {
      expect(command).toBe('/usr/bin/claude');
      expect(args).toEqual(['--safe-mode']);
    }
    expect(options.cwd).toContain('kangentic-model-probe');
  });

  it('bails without keystrokes when the trust dialog renders', async () => {
    const fake = installFakePty((self) =>
      self.emitData('Accessing workspace\r\n❯ 1. Yes, I trust this folder\r\n2. No, exit'),
    );

    const models = await probeModelPickerModels('/usr/bin/claude');
    expect(models).toBeUndefined();
    expect(fake.writes).not.toContain('/model');
    expect(fake.writes).not.toContain('\r');
    // No `/exit` either: its Enter would accept the trust dialog. With no
    // prompt ever reached, nothing booted far enough to arm a canary, so the
    // plain kill lands synchronously.
    expect(fake.writes).not.toContain('/exit\r');
    expect(fake.killMock).toHaveBeenCalled();
  });

  it('times out to undefined when the picker never renders', async () => {
    setModelPickerProbeTimingsForTests({
      pollIntervalMs: 5,
      typeDelayMs: 5,
      settleIntervalMs: 5,
      overallTimeoutMs: 100,
      exitGraceMs: 5,
    });
    const fake = installFakePty((self) => self.emitData(PROMPT_FRAME));

    const models = await probeModelPickerModels('/usr/bin/claude');
    expect(models).toBeUndefined();
    // The prompt was reached, so the teardown still exits gracefully first.
    await expectFallbackKill(fake);
    expect(fake.writes).toContain('/exit\r');
  });

  it('returns undefined when the CLI exits before the prompt appears', async () => {
    installFakePty((self) => self.emitExit());

    const models = await probeModelPickerModels('/usr/bin/claude');
    expect(models).toBeUndefined();
  });

  it('returns undefined when the spawn itself throws', async () => {
    spawnMock.mockImplementation(() => {
      throw new Error('ENOENT');
    });

    const models = await probeModelPickerModels('/missing/claude');
    expect(models).toBeUndefined();
  });

  it('caches a successful probe instead of respawning', async () => {
    installFakePty(
      (self) => self.emitData(PROMPT_FRAME),
      (input, self) => {
        if (input === '\r') self.emitData(PICKER_FRAME);
      },
    );

    const first = await probeModelPickerModels('/usr/bin/claude');
    const second = await probeModelPickerModels('/usr/bin/claude');
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(second).toEqual(first);
  });

  it('re-probes when forceRefresh is set even though the success cache is fresh', async () => {
    installFakePty(
      (self) => self.emitData(PROMPT_FRAME),
      (input, self) => {
        if (input === '\r') self.emitData(PICKER_FRAME);
      },
    );

    // Warm the 12h success cache.
    const first = await probeModelPickerModels('/usr/bin/claude');
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // A plain call inside the 12h TTL is served from the cache: no respawn.
    await probeModelPickerModels('/usr/bin/claude');
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // A forced call (the on-demand rescan a dropdown fires on open) bypasses the
    // TTL and spawns a fresh probe, so a model that shipped since the cache
    // warmed can appear without a restart.
    const forced = await probeModelPickerModels('/usr/bin/claude', true);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(forced).toEqual(first);
  });

  it('caches a failure briefly and retries after the failure TTL expires', async () => {
    setModelPickerProbeTimingsForTests({
      pollIntervalMs: 5,
      typeDelayMs: 5,
      settleIntervalMs: 5,
      overallTimeoutMs: 50,
      exitGraceMs: 5,
    });
    installFakePty((self) => self.emitData(PROMPT_FRAME)); // picker never renders

    await probeModelPickerModels('/usr/bin/claude');
    await probeModelPickerModels('/usr/bin/claude');
    // Second call inside the failure TTL is served from the cache.
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // Shift wall-clock time past the 10-minute failure TTL. The clock must
    // keep advancing (not freeze) or the probe's own deadline loop would
    // never expire, so the spy offsets the real clock instead of pinning it.
    const originalDateNow = Date.now;
    const dateNowSpy = vi
      .spyOn(Date, 'now')
      .mockImplementation(() => originalDateNow() + 11 * 60 * 1000);
    try {
      await probeModelPickerModels('/usr/bin/claude');
      expect(spawnMock).toHaveBeenCalledTimes(2);
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it('does not serve one CLI\'s good scan when a probe of a different CLI path fails', async () => {
    installFakePty(
      (self) => self.emitData(PROMPT_FRAME),
      (input, self) => {
        if (input === '\r') self.emitData(PICKER_FRAME);
      },
    );
    const scanA = await probeModelPickerModels('/a/claude');
    expect(scanA?.models).toContain('claude-opus-4-8');

    setModelPickerProbeTimingsForTests({
      pollIntervalMs: 5,
      typeDelayMs: 5,
      settleIntervalMs: 5,
      overallTimeoutMs: 50,
      exitGraceMs: 5,
    });
    installFakePty((self) => self.emitData(PROMPT_FRAME)); // CLI B's picker never renders

    // A failed probe keeps a prior good scan only for the SAME CLI: CLI A's
    // model list must never be reported for CLI B.
    const scanB = await probeModelPickerModels('/b/claude', true);
    expect(spawnMock).toHaveBeenCalledTimes(2);
    expect(scanB).toBeUndefined();
  });

  it('shares one in-flight probe between concurrent callers', async () => {
    installFakePty(
      (self) => self.emitData(PROMPT_FRAME),
      (input, self) => {
        if (input === '\r') self.emitData(PICKER_FRAME);
      },
    );

    const [first, second] = await Promise.all([
      probeModelPickerModels('/usr/bin/claude'),
      probeModelPickerModels('/usr/bin/claude'),
    ]);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(first).toEqual(second);
  });
});

describe('getCachedModelPickerModels', () => {
  it('returns undefined on the first call and warms the cache in the background', async () => {
    installFakePty(
      (self) => self.emitData(PROMPT_FRAME),
      (input, self) => {
        if (input === '\r') self.emitData(PICKER_FRAME);
      },
    );

    // First call never blocks: the cache is empty, so it returns immediately
    // (before the async probe has even spawned) and kicks the probe off.
    expect(getCachedModelPickerModels('/usr/bin/claude')).toBeUndefined();

    // Poll until the background probe has populated the cache (bounded).
    let warmed: ModelPickerScan | undefined;
    for (let attempt = 0; attempt < 50 && warmed === undefined; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      warmed = getCachedModelPickerModels('/usr/bin/claude');
    }

    expect(warmed?.models).toEqual([
      'claude-opus-4-8',
      'claude-fable-5',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
    ]);
    // Exactly one probe ran across all those accessor calls.
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  it('does not spawn a second probe while one is already in flight', async () => {
    installFakePty(
      (self) => self.emitData(PROMPT_FRAME),
      (input, self) => {
        if (input === '\r') self.emitData(PICKER_FRAME);
      },
    );

    // Both synchronous calls share the in-flight guard set by the first.
    getCachedModelPickerModels('/usr/bin/claude');
    getCachedModelPickerModels('/usr/bin/claude');
    // Let the async probe reach its spawn.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });
});

/** Repaint the fake screen from the top with these lines, each cleared to its end. */
function repaint(lines: string[]): string {
  return `\x1b[H${lines.map((line) => `${line}\x1b[K`).join('\r\n')}`;
}

const ARROW_DOWN = '\x1b[B';

/** A picker that fits on one screen: no rows below, so the scroll reports complete. */
const COMPLETE_PICKER_LINES = [
  '  Select model',
  '  ❯ 1.  Default (recommended) ✔  Fable 5.1 · Best for everyday, complex tasks',
  '    2.  Fable 5.1                For your toughest challenges',
  '    3.  Haiku 4.5                Fastest for quick answers',
  '',
];

/** A picker whose "… +2 models" row never goes away, however far the highlight moves. */
const NEVER_ENDING_PICKER_LINES = [
  '  Select model',
  '  ❯ 1.  Default (recommended) ✔  Sonnet 5.5 · Efficient for routine tasks',
  '    2.  Sonnet 5.5               Most efficient for simpler tasks',
  '  ↓ 3.  Sonnet 5                 Efficient for routine tasks',
  '     … +2 models',
];

const COMPLETE_SCAN: ModelPickerScan = {
  models: ['claude-fable-5-1', 'claude-haiku-4-5'],
  aliases: [
    { id: 'fable', resolvesTo: 'claude-fable-5-1' },
    { id: 'haiku', resolvesTo: 'claude-haiku-4-5' },
  ],
};
/** What a scroll that never reaches the last row still reads. */
const PARTIAL_MODELS = ['claude-sonnet-5-5', 'claude-sonnet-5'];

const FAILURE_BACKOFF_PLUS_ONE_MINUTE_MS = 11 * 60 * 1000;
const THIRTEEN_HOURS_MS = 13 * 60 * 60 * 1000;

/**
 * Every timing field is restated (the setter merges onto the defaults): the
 * shared beforeEach leaves scrollSettleMs at 80 ms and the overall cap at 2 s,
 * which would let 40 Arrow Down presses run into the deadline first.
 */
function setFastScrollTimings(): void {
  setModelPickerProbeTimingsForTests({
    pollIntervalMs: 2,
    typeDelayMs: 2,
    settleIntervalMs: 2,
    overallTimeoutMs: 10000,
    exitGraceMs: 5,
    scrollSettleMs: 2,
  });
}

/** A fake CLI whose picker renders `pickerLines` and does not change on Arrow Down. */
function installStaticPickerPty(pickerLines: string[]): FakePtyProcess {
  return installFakePty(
    (self) => self.emitData(PROMPT_FRAME),
    (input, self) => {
      if (input === '\r') self.emitData(repaint(pickerLines));
    },
  );
}

/**
 * A write that should NOT happen cannot be polled for. Give any stray async
 * write a fixed budget before the caller inspects the file.
 */
function allowStrayWriteBudget(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

describe('probeModelPickerModels scrolling', () => {
  // The picker shows a window of rows and says how many more are below; the
  // probe walks the highlight down (never Enter) until none are left.
  const SCROLL_FRAMES = [
    [
      '  Select model',
      '  ❯ 1.  Default (recommended) ✔  Sonnet 5.5 · Efficient for routine tasks',
      '    2.  Sonnet 5.5               Most efficient for simpler tasks',
      '  ↓ 3.  Sonnet 5                 Efficient for routine tasks',
      '     … +2 models',
    ],
    [
      '  Select model',
      '    2.  Sonnet 5.5               Most efficient for simpler tasks',
      '    3.  Sonnet 5                 Efficient for routine tasks',
      '  ↓ 4.  Sonnet 4.6               Legacy',
      '     … +1 models',
    ],
    [
      '  Select model',
      '    3.  Sonnet 5                 Efficient for routine tasks',
      '    4.  Sonnet 4.6               Legacy',
      '  ❯ 5.  Haiku 4.5                Fastest for quick answers',
      '',
    ],
  ];

  it('scrolls to the last row and reads every row, pressing no key but the arrow and Esc', async () => {
    let shown = 0;
    const fake = installFakePty(
      (self) => self.emitData(PROMPT_FRAME),
      (input, self) => {
        if (input === '\r') self.emitData(repaint(SCROLL_FRAMES[0]));
        if (input === '\x1b[B' && shown < SCROLL_FRAMES.length - 1) {
          shown += 1;
          self.emitData(repaint(SCROLL_FRAMES[shown]));
        }
      },
    );

    const scan = await probeModelPickerModels('/usr/bin/claude');
    expect(scan?.models).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-4-5']);
    expect(scan?.aliases).toEqual([
      { id: 'sonnet', resolvesTo: 'claude-sonnet-5-5' },
      { id: 'haiku', resolvesTo: 'claude-haiku-4-5' },
    ]);
    await expectFallbackKill(fake);
    // Exactly two scroll presses, and the only Enter is the one that opened the picker.
    expect(fake.writes).toEqual(['/model', '\r', '\x1b[B', '\x1b[B', '\x1b', '/exit\r']);
  });

  it('scrolls when only the "+N model" summary line says rows remain (singular, no row marker)', async () => {
    // Each of the two rows-below signals must trigger a scroll on its own.
    const summaryOnlyFrames = [
      [
        '  Select model',
        '  ❯ 1.  Default (recommended) ✔  Sonnet 5.5 · Efficient for routine tasks',
        '    2.  Sonnet 5.5               Most efficient for simpler tasks',
        '     … +1 model',
      ],
      [
        '  Select model',
        '    1.  Default (recommended)    Sonnet 5.5 · Efficient for routine tasks',
        '    2.  Sonnet 5.5               Most efficient for simpler tasks',
        '  ❯ 3.  Haiku 4.5                Fastest for quick answers',
        '',
      ],
    ];
    let shown = 0;
    const fake = installFakePty(
      (self) => self.emitData(PROMPT_FRAME),
      (input, self) => {
        if (input === '\r') self.emitData(repaint(summaryOnlyFrames[0]));
        if (input === '\x1b[B' && shown < summaryOnlyFrames.length - 1) {
          shown += 1;
          self.emitData(repaint(summaryOnlyFrames[shown]));
        }
      },
    );

    const scan = await probeModelPickerModels('/usr/bin/claude');
    expect(fake.writes.filter((write) => write === '\x1b[B').length).toBeGreaterThanOrEqual(1);
    // Haiku 4.5 is only visible after the scroll.
    expect(scan?.models).toEqual(['claude-sonnet-5-5', 'claude-haiku-4-5']);
    await expectFallbackKill(fake);
  });

  it('scrolls when only a "↓ N." row marker says rows remain (no summary line)', async () => {
    const markerOnlyFrames = [
      [
        '  Select model',
        '  ❯ 1.  Default (recommended) ✔  Sonnet 5.5 · Efficient for routine tasks',
        '    2.  Sonnet 5.5               Most efficient for simpler tasks',
        '  ↓ 10. Sonnet 5                 Efficient for routine tasks',
      ],
      [
        '  Select model',
        '    2.  Sonnet 5.5               Most efficient for simpler tasks',
        '    10. Sonnet 5                 Efficient for routine tasks',
        '  ❯ 11. Haiku 4.5                Fastest for quick answers',
        '',
      ],
    ];
    let shown = 0;
    const fake = installFakePty(
      (self) => self.emitData(PROMPT_FRAME),
      (input, self) => {
        if (input === '\r') self.emitData(repaint(markerOnlyFrames[0]));
        if (input === '\x1b[B' && shown < markerOnlyFrames.length - 1) {
          shown += 1;
          self.emitData(repaint(markerOnlyFrames[shown]));
        }
      },
    );

    const scan = await probeModelPickerModels('/usr/bin/claude');
    expect(fake.writes.filter((write) => write === '\x1b[B').length).toBeGreaterThanOrEqual(1);
    // Haiku 4.5 is only visible after the scroll.
    expect(scan?.models).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5', 'claude-haiku-4-5']);
    await expectFallbackKill(fake);
  });

  it('stops after 40 Arrow Down presses when the picker never runs out of rows, and still returns a scan', async () => {
    // Every timing field is restated: the setter merges onto the defaults, and
    // the shared beforeEach leaves scrollSettleMs at 80 ms, which would let
    // 40 presses hit the overall deadline before the press cap.
    setModelPickerProbeTimingsForTests({
      pollIntervalMs: 2,
      typeDelayMs: 2,
      settleIntervalMs: 2,
      overallTimeoutMs: 10000,
      exitGraceMs: 5,
      scrollSettleMs: 2,
    });
    let pressCount = 0;
    const endlessFrame = (pressNumber: number) => [
      '  Select model',
      '  ❯ 1.  Default (recommended) ✔  Sonnet 5.5 · Efficient for routine tasks',
      `    ${pressNumber + 2}.  Sonnet 5                 Efficient for routine tasks`,
      '  ↓ 9.  Haiku 4.5                Fastest for quick answers',
      '     … +2 models',
    ];
    const fake = installFakePty(
      (self) => self.emitData(PROMPT_FRAME),
      (input, self) => {
        if (input === '\r') self.emitData(repaint(endlessFrame(0)));
        if (input === '\x1b[B') {
          pressCount += 1;
          self.emitData(repaint(endlessFrame(pressCount)));
        }
      },
    );

    const scan = await probeModelPickerModels('/usr/bin/claude');
    expect(scan?.models).toContain('claude-sonnet-5-5');
    expect(scan?.models).toContain('claude-haiku-4-5');
    await expectFallbackKill(fake);
    expect(fake.writes.filter((write) => write === '\x1b[B')).toHaveLength(40);
    // The only Enter is the one that opened the picker: '/exit\r' is a different write.
    expect(fake.writes.filter((write) => write === '\r')).toHaveLength(1);
  }, 20000);

  it('still parses the first frame when a scroll never settles before the deadline, and never persists that partial scan', async () => {
    const scanDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-probe-unsettled-'));
    const unsettledScanFile = path.join(scanDirectory, 'last-scan.json');
    setModelPickerProbeScanFileForTests(unsettledScanFile);
    // scrollSettleMs stays well above the emit period so the second read of
    // waitForStableFrame always follows several new frames.
    setModelPickerProbeTimingsForTests({
      pollIntervalMs: 2,
      typeDelayMs: 2,
      settleIntervalMs: 5,
      overallTimeoutMs: 400,
      exitGraceMs: 5,
      scrollSettleMs: 40,
    });
    let churnTimer: ReturnType<typeof setInterval> | undefined;
    const stopChurn = () => {
      if (churnTimer !== undefined) clearInterval(churnTimer);
      churnTimer = undefined;
    };
    try {
      const fake = installFakePty(
        (self) => self.emitData(PROMPT_FRAME),
        (input, self) => {
          if (input === '\r') self.emitData(repaint(SCROLL_FRAMES[0]));
          if (input === '\x1b[B') {
            // A strictly increasing counter: two reads never see the same frame,
            // so the screen cannot settle (alternating contents could coincide).
            let tick = 0;
            churnTimer = setInterval(() => {
              tick += 1;
              self.emitData(repaint([
                '  Select model',
                `    2.  Sonnet 5.5               churn ${tick}`,
                '  ↓ 3.  Sonnet 5                 Efficient for routine tasks',
                '     … +2 models',
              ]));
            }, 5);
          }
          if (input === '\x1b') stopChurn();
        },
      );

      const scan = await probeModelPickerModels('/usr/bin/claude');
      // The first frame alone is a complete result: rows 1 to 3 of SCROLL_FRAMES[0].
      expect(scan?.models).toEqual(['claude-sonnet-5-5', 'claude-sonnet-5']);
      await expectFallbackKill(fake);
      // The failed settle ends the scroll: no second press.
      expect(fake.writes.filter((write) => write === '\x1b[B')).toHaveLength(1);
      // Rows were still below when the scroll stopped, so the scan is
      // incomplete and must not reach the last-scan file. Absence cannot be
      // polled for; allowStrayWriteBudget gives a stray async write time to land.
      await allowStrayWriteBudget();
      expect(fs.existsSync(unsettledScanFile)).toBe(false);
    } finally {
      stopChurn();
      fs.rmSync(scanDirectory, { recursive: true, force: true });
    }
  });
});

describe('mergePickerFrames', () => {
  const FIRST_FRAME = [
    '  Select model',
    '  ❯ 1.  Default (recommended) ✔  Sonnet 5.5 · Efficient for routine tasks',
    '    2.  Sonnet 5.5               Most efficient for simpler tasks',
    '  ↓ 3.  Sonnet 5                 Efficient for routine tasks',
    '     … +2 models',
  ].join('\n');
  const SECOND_FRAME = [
    '  Select model',
    '    2.  Sonnet 5.5               Most efficient for simpler tasks',
    '    3.  Sonnet 5                 Efficient for routine tasks',
    '  ↓ 4.  Sonnet 4.6               Legacy',
    '     … +1 models',
  ].join('\n');

  it('dedupes rows by number, keeps the first line seen, and emits row order under a bare header', () => {
    expect(mergePickerFrames([FIRST_FRAME, SECOND_FRAME])).toBe([
      'Select model',
      '  ❯ 1.  Default (recommended) ✔  Sonnet 5.5 · Efficient for routine tasks',
      '    2.  Sonnet 5.5               Most efficient for simpler tasks',
      '  ↓ 3.  Sonnet 5                 Efficient for routine tasks',
      '  ↓ 4.  Sonnet 4.6               Legacy',
    ].join('\n'));
  });

  it('orders rows by number whatever order the frames arrive in', () => {
    expect(mergePickerFrames([SECOND_FRAME, FIRST_FRAME])).toBe([
      'Select model',
      '  ❯ 1.  Default (recommended) ✔  Sonnet 5.5 · Efficient for routine tasks',
      '    2.  Sonnet 5.5               Most efficient for simpler tasks',
      '    3.  Sonnet 5                 Efficient for routine tasks',
      '  ↓ 4.  Sonnet 4.6               Legacy',
    ].join('\n'));
  });

  it('ignores a frame without the Select model header and numbered rows above the header', () => {
    const headerless = '❯ 1. Yes, I trust this folder\n  2. No, exit';
    const rowAboveHeader = ['    9.  Stale 9.9   Leftover row', ...SECOND_FRAME.split('\n')].join('\n');
    expect(mergePickerFrames([headerless, rowAboveHeader])).toBe([
      'Select model',
      '    2.  Sonnet 5.5               Most efficient for simpler tasks',
      '    3.  Sonnet 5                 Efficient for routine tasks',
      '  ↓ 4.  Sonnet 4.6               Legacy',
    ].join('\n'));
  });

  it('returns the first frame untouched when no frame has numbered rows', () => {
    const bare = '  Select model\n  Loading models...';
    expect(mergePickerFrames([bare, 'something else'])).toBe(bare);
  });

  it('returns an empty string for an empty list', () => {
    expect(mergePickerFrames([])).toBe('');
  });

  describe('with a "↑" scroll marker on a row', () => {
    const SCROLLED_FRAME = [
      '  Select model',
      '  ↑ 2.  Sonnet 5.5               Most efficient for simpler tasks',
      '    3.  Haiku 4.5                Fastest for quick answers',
      '  ❯ 4.  Sonnet 5                 Efficient for routine tasks',
    ].join('\n');
    const TOP_FRAME = [
      '  Select model',
      '  ❯ 1.  Opus 5.5                 For complex work and everyday tasks',
      '    2.  Sonnet 5.5               Most efficient for simpler tasks',
      '  ↓ 3.  Haiku 4.5                Fastest for quick answers',
      '     … +1 models',
    ].join('\n');

    it('keeps the marked row once, in row order', () => {
      expect(mergePickerFrames([TOP_FRAME, SCROLLED_FRAME])).toBe([
        'Select model',
        '  ❯ 1.  Opus 5.5                 For complex work and everyday tasks',
        '    2.  Sonnet 5.5               Most efficient for simpler tasks',
        '  ↓ 3.  Haiku 4.5                Fastest for quick answers',
        '  ❯ 4.  Sonnet 5                 Efficient for routine tasks',
      ].join('\n'));
      // The frame that shows row 2 only through its marker still contributes it.
      expect(mergePickerFrames([SCROLLED_FRAME, TOP_FRAME])).toBe([
        'Select model',
        '  ❯ 1.  Opus 5.5                 For complex work and everyday tasks',
        '  ↑ 2.  Sonnet 5.5               Most efficient for simpler tasks',
        '    3.  Haiku 4.5                Fastest for quick answers',
        '  ❯ 4.  Sonnet 5                 Efficient for routine tasks',
      ].join('\n'));
    });

    it('keeps a marked row that no other frame shows', () => {
      expect(mergePickerFrames([SCROLLED_FRAME])).toContain('  ↑ 2.  Sonnet 5.5               Most efficient for simpler tasks');
    });
  });
});

describe('the last-scan file', () => {
  let tempDirectory: string;
  let scanFile: string;

  beforeEach(() => {
    tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-probe-scan-'));
    scanFile = path.join(tempDirectory, 'last-scan.json');
  });

  afterEach(() => {
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  });

  it('keeps a good scan, and a restarted process serves it at once without a probe', async () => {
    setModelPickerProbeScanFileForTests(scanFile);
    installFakePty(
      (self) => self.emitData(PROMPT_FRAME),
      (input, self) => {
        if (input === '\r') self.emitData(PICKER_FRAME);
      },
    );
    const scan = await probeModelPickerModels('/usr/bin/claude');
    // The write is async: wait for a whole file, not just an opened one.
    await vi.waitFor(() => JSON.parse(fs.readFileSync(scanFile, 'utf8')));

    // A restart: the in-memory cache is gone, the file is not.
    resetModelPickerProbeForTests();
    setModelPickerProbeScanFileForTests(scanFile);
    spawnMock.mockClear();

    // The very first read already has the aliases, instead of undefined.
    expect(getCachedModelPickerModels('/usr/bin/claude')).toEqual(scan);
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Still inside the success TTL, so no probe spawns.
    expect(spawnMock).not.toHaveBeenCalled();
  });

  // The cases below drain every probe they kick (the fake exits at once and the
  // test awaits it), so no probe outlives its test and writes a failure into
  // the module cache after the next test's reset.
  const CLI_PATH = '/usr/bin/claude';
  const GOOD_MODELS = ['claude-opus-5-5', 'claude-sonnet-5-5'];
  const GOOD_ALIASES = [
    { id: 'opus', resolvesTo: 'claude-opus-5-5' },
    { id: 'sonnet', resolvesTo: 'claude-sonnet-5-5' },
  ];

  /** A record the parser accepts; each malformed case below breaks exactly one thing. */
  function goodRecord(): { cliPath: string; fetchedAtMs: number; scan: { models: unknown[]; aliases: unknown[] } } {
    return {
      cliPath: CLI_PATH,
      fetchedAtMs: Date.now() - 1000,
      scan: { models: [...GOOD_MODELS], aliases: GOOD_ALIASES.map((alias) => ({ ...alias })) },
    };
  }

  function writeScanFile(record: unknown): void {
    fs.writeFileSync(scanFile, typeof record === 'string' ? record : JSON.stringify(record));
  }

  it('reads the file once per process: a file that appears after the first read is not picked up', async () => {
    installFakePty((self) => self.emitExit());
    setModelPickerProbeScanFileForTests(scanFile);
    // No file yet. The kicked probe is still parked on the trust step, so the
    // cache is empty at the second call and only the read-once flag keeps the
    // new file out (a cache-empty check alone would read it).
    expect(getCachedModelPickerModels(CLI_PATH)).toBeUndefined();

    writeScanFile(goodRecord());
    expect(getCachedModelPickerModels(CLI_PATH)).toBeUndefined();

    await probeModelPickerModels(CLI_PATH);
  });

  it('serves the first content when the file is rewritten after it seeded the cache', () => {
    installFakePty();
    writeScanFile(goodRecord());
    setModelPickerProbeScanFileForTests(scanFile);
    const first = getCachedModelPickerModels(CLI_PATH);
    expect(first).toEqual({ models: GOOD_MODELS, aliases: GOOD_ALIASES });

    const rewritten = goodRecord();
    rewritten.scan.models = ['claude-haiku-4-5'];
    rewritten.scan.aliases = [{ id: 'haiku', resolvesTo: 'claude-haiku-4-5' }];
    writeScanFile(rewritten);
    expect(getCachedModelPickerModels(CLI_PATH)).toEqual(first);
  });

  it('keeps a seeded good scan when the next probe fails, and leaves the file alone', async () => {
    writeScanFile(goodRecord());
    const fileBefore = fs.readFileSync(scanFile, 'utf8');
    setModelPickerProbeScanFileForTests(scanFile);
    setModelPickerProbeTimingsForTests({
      pollIntervalMs: 5,
      typeDelayMs: 5,
      settleIntervalMs: 5,
      overallTimeoutMs: 50,
      exitGraceMs: 5,
    });
    installFakePty((self) => self.emitData(PROMPT_FRAME)); // the picker never renders

    const expectedScan = { models: GOOD_MODELS, aliases: GOOD_ALIASES };
    // forceRefresh runs a real probe even though the seeded scan is fresh.
    expect(await probeModelPickerModels(CLI_PATH, true)).toEqual(expectedScan);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    expect(getCachedModelPickerModels(CLI_PATH)).toEqual(expectedScan);

    // Only a good scan is persisted. A write that should not happen cannot be
    // polled for, so give any stray async write a fixed budget before reading.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fs.readFileSync(scanFile, 'utf8')).toBe(fileBefore);
  });

  it('retries a failed probe after the failure backoff, not the 12 hour success TTL', async () => {
    writeScanFile(goodRecord());
    setModelPickerProbeScanFileForTests(scanFile);
    setModelPickerProbeTimingsForTests({
      pollIntervalMs: 5,
      typeDelayMs: 5,
      settleIntervalMs: 5,
      overallTimeoutMs: 50,
      exitGraceMs: 5,
    });
    installFakePty((self) => self.emitData(PROMPT_FRAME));

    await probeModelPickerModels(CLI_PATH, true);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    // Inside the failure backoff: served from the kept scan, no respawn.
    await probeModelPickerModels(CLI_PATH);
    expect(spawnMock).toHaveBeenCalledTimes(1);

    // Eleven minutes on: past the 10 minute failure backoff, far inside the
    // 12 hour success TTL the seeded scan would otherwise still be under.
    const originalDateNow = Date.now;
    const dateNowSpy = vi
      .spyOn(Date, 'now')
      .mockImplementation(() => originalDateNow() + 11 * 60 * 1000);
    try {
      const scan = await probeModelPickerModels(CLI_PATH);
      expect(spawnMock).toHaveBeenCalledTimes(2);
      // That probe failed too, and the good scan is still what callers get.
      expect(scan).toEqual({ models: GOOD_MODELS, aliases: GOOD_ALIASES });
    } finally {
      dateNowSpy.mockRestore();
    }
  });

  it('accepts a well-formed record, which is what makes the rejections below meaningful', async () => {
    installFakePty((self) => self.emitExit());
    writeScanFile(goodRecord());
    setModelPickerProbeScanFileForTests(scanFile);
    expect(getCachedModelPickerModels(CLI_PATH)).toEqual({ models: GOOD_MODELS, aliases: GOOD_ALIASES });
    await probeModelPickerModels(CLI_PATH);
  });

  const malformedRecords: Array<[string, () => unknown]> = [
    ['a record that is not an object', () => '"just a string"'],
    ['a null record', () => null],
    ['a non-string cliPath', () => ({ ...goodRecord(), cliPath: 42 })],
    ['a non-number fetchedAtMs', () => ({ ...goodRecord(), fetchedAtMs: '2026-01-01T00:00:00.000Z' })],
    ['a fetchedAtMs in the future', () => ({ ...goodRecord(), fetchedAtMs: Date.now() + 60 * 60 * 1000 })],
    ['an empty models list', () => {
      const record = goodRecord();
      record.scan.models = [];
      return record;
    }],
    ['an uppercase model id', () => {
      const record = goodRecord();
      record.scan.models = ['Claude-Opus-5-5'];
      return record;
    }],
    ['a model id containing a space', () => {
      const record = goodRecord();
      record.scan.models = ['claude opus'];
      return record;
    }],
    ['a non-string model id', () => {
      const record = goodRecord();
      record.scan.models = [5];
      return record;
    }],
    ['an alias id with digits', () => {
      const record = goodRecord();
      record.scan.aliases = [{ id: 'opus5', resolvesTo: 'claude-opus-5-5' }];
      return record;
    }],
    ['an uppercase alias id', () => {
      const record = goodRecord();
      record.scan.aliases = [{ id: 'Opus', resolvesTo: 'claude-opus-5-5' }];
      return record;
    }],
    ['a non-string resolvesTo', () => {
      const record = goodRecord();
      record.scan.aliases = [{ id: 'opus', resolvesTo: 5 }];
      return record;
    }],
    ['a resolvesTo that is not a model id', () => {
      const record = goodRecord();
      record.scan.aliases = [{ id: 'opus', resolvesTo: 'Claude Opus' }];
      return record;
    }],
  ];

  it.each(malformedRecords)('rejects %s', async (_label, buildRecord) => {
    installFakePty((self) => self.emitExit());
    writeScanFile(buildRecord());
    setModelPickerProbeScanFileForTests(scanFile);
    expect(getCachedModelPickerModels(CLI_PATH)).toBeUndefined();
    await probeModelPickerModels(CLI_PATH);
  });

  it('round-trips an alias with no resolvesTo as just its id', async () => {
    installFakePty((self) => self.emitExit());
    const record = goodRecord();
    record.scan.aliases = [{ id: 'opus' }];
    writeScanFile(record);
    setModelPickerProbeScanFileForTests(scanFile);

    const scan = getCachedModelPickerModels(CLI_PATH);
    // toStrictEqual: `{ id, resolvesTo: undefined }` must not pass for `{ id }`.
    expect(scan?.aliases).toStrictEqual([{ id: 'opus' }]);
    expect(scan?.models).toEqual(GOOD_MODELS);
    await probeModelPickerModels(CLI_PATH);
  });

  it('ignores a scan taken with a different CLI, and a file that is not a scan', async () => {
    // Each read below kicks a probe. The fake exits at once and the test awaits
    // each probe in turn, so none outlives the test and spawns into the next
    // test's fake PTY.
    installFakePty((self) => self.emitExit());
    fs.writeFileSync(scanFile, JSON.stringify({
      cliPath: '/other/claude',
      fetchedAtMs: Date.now(),
      scan: { models: ['claude-opus-5-5'], aliases: [{ id: 'opus', resolvesTo: 'claude-opus-5-5' }] },
    }));
    setModelPickerProbeScanFileForTests(scanFile);
    expect(getCachedModelPickerModels('/usr/bin/claude')).toBeUndefined();
    await probeModelPickerModels('/usr/bin/claude');

    fs.writeFileSync(scanFile, '{ "cliPath": "/usr/bin/claude", "scan": "nope" }');
    resetModelPickerProbeForTests();
    // The reset also restores the default (slow) timings; put the fast ones back.
    setModelPickerProbeTimingsForTests({
      pollIntervalMs: 5,
      typeDelayMs: 5,
      settleIntervalMs: 5,
      overallTimeoutMs: 2000,
      exitGraceMs: 5,
    });
    setModelPickerProbeScanFileForTests(scanFile);
    expect(getCachedModelPickerModels('/usr/bin/claude')).toBeUndefined();
    await probeModelPickerModels('/usr/bin/claude');
  });

  describe('an incomplete scroll (rows still below when the scroll stopped)', () => {
    beforeEach(() => {
      setFastScrollTimings();
    });

    it('returns the partial scan but never writes the last-scan file when nothing earlier exists', async () => {
      setModelPickerProbeScanFileForTests(scanFile);
      const fake = installStaticPickerPty(NEVER_ENDING_PICKER_LINES);

      const scan = await probeModelPickerModels(CLI_PATH);
      expect(scan?.models).toEqual(PARTIAL_MODELS);
      await expectFallbackKill(fake);
      // The scroll ran the whole 40 press cap and still saw rows below.
      expect(fake.writes.filter((write) => write === ARROW_DOWN)).toHaveLength(40);

      await allowStrayWriteBudget();
      expect(fs.existsSync(scanFile)).toBe(false);
    });

    it('keeps the earlier complete scan from an earlier probe when a forced probe ends incomplete', async () => {
      setModelPickerProbeScanFileForTests(scanFile);
      installStaticPickerPty(COMPLETE_PICKER_LINES);
      expect(await probeModelPickerModels(CLI_PATH)).toEqual(COMPLETE_SCAN);
      await vi.waitFor(() => expect(JSON.parse(fs.readFileSync(scanFile, 'utf8')).scan).toEqual(COMPLETE_SCAN));
      const fileBefore = fs.readFileSync(scanFile, 'utf8');

      const fake = installStaticPickerPty(NEVER_ENDING_PICKER_LINES);
      const scanAfterIncomplete = await probeModelPickerModels(CLI_PATH, true);
      expect(scanAfterIncomplete).toEqual(COMPLETE_SCAN);
      await expectFallbackKill(fake);
      expect(fake.writes.filter((write) => write === ARROW_DOWN)).toHaveLength(40);
      // Later reads still get the complete scan, not the truncated one.
      expect(getCachedModelPickerModels(CLI_PATH)).toEqual(COMPLETE_SCAN);

      await allowStrayWriteBudget();
      expect(fs.readFileSync(scanFile, 'utf8')).toBe(fileBefore);
    });

    it('retries a partial scan with nothing earlier after the failure backoff, not the 12 hour success TTL', async () => {
      const fake = installStaticPickerPty(NEVER_ENDING_PICKER_LINES);

      const first = await probeModelPickerModels(CLI_PATH);
      expect(first?.models).toEqual(PARTIAL_MODELS);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      await expectFallbackKill(fake);

      // Inside the backoff: the partial scan is served, no respawn.
      const second = await probeModelPickerModels(CLI_PATH);
      expect(second?.models).toEqual(PARTIAL_MODELS);
      expect(spawnMock).toHaveBeenCalledTimes(1);

      // Eleven minutes on: past the 10 minute failure backoff, far inside the
      // 12 hour success TTL a complete scan would still be under.
      const originalDateNow = Date.now;
      const dateNowSpy = vi
        .spyOn(Date, 'now')
        .mockImplementation(() => originalDateNow() + FAILURE_BACKOFF_PLUS_ONE_MINUTE_MS);
      try {
        installStaticPickerPty(COMPLETE_PICKER_LINES);
        const retried = await probeModelPickerModels(CLI_PATH);
        expect(spawnMock).toHaveBeenCalledTimes(2);
        // The retry saw the whole picker and replaces the partial scan.
        expect(retried).toEqual(COMPLETE_SCAN);
      } finally {
        dateNowSpy.mockRestore();
      }
    });
  });

  describe('a stale seeded scan', () => {
    it('is served on the first call while a probe spawns, and the file is rewritten with the new scan', async () => {
      const staleFetchedAtMs = Date.now() - THIRTEEN_HOURS_MS;
      writeScanFile({ ...goodRecord(), fetchedAtMs: staleFetchedAtMs });
      setModelPickerProbeScanFileForTests(scanFile);
      setFastScrollTimings();
      const fake = installStaticPickerPty(COMPLETE_PICKER_LINES);

      // Older than the 12 hour TTL, yet still served immediately.
      expect(getCachedModelPickerModels(CLI_PATH)).toEqual({ models: GOOD_MODELS, aliases: GOOD_ALIASES });
      // And the staleness kicked a probe.
      await vi.waitFor(() => expect(spawnMock).toHaveBeenCalledTimes(1));

      // Ride the in-flight probe to its end (a second spawn would fail the count below).
      expect(await probeModelPickerModels(CLI_PATH)).toEqual(COMPLETE_SCAN);
      expect(spawnMock).toHaveBeenCalledTimes(1);
      await expectFallbackKill(fake);

      await vi.waitFor(() => {
        const record = JSON.parse(fs.readFileSync(scanFile, 'utf8'));
        expect(record.scan).toEqual(COMPLETE_SCAN);
        expect(record.fetchedAtMs).toBeGreaterThan(staleFetchedAtMs);
      });
    });
  });

  describe('peekModelPickerAliasIds', () => {
    // A stale scan is what makes the zero-spawn assertion meaningful: the
    // other accessors kick a background probe for one, so a peek that did the
    // same would spawn here. The returned aliases prove the file was seeded, so
    // "no spawn" is not just an unseeded no-op.
    it.each<[string, string | undefined]>([
      ['the CLI path the scan was taken with', CLI_PATH],
      ['no CLI path (the live /model command)', undefined],
    ])('reads the seeded aliases for %s and never starts a probe', async (_label, peekedCliPath) => {
      writeScanFile({ ...goodRecord(), fetchedAtMs: Date.now() - THIRTEEN_HOURS_MS });
      setModelPickerProbeScanFileForTests(scanFile);
      installFakePty((self) => self.emitData(PROMPT_FRAME));

      expect(peekModelPickerAliasIds(peekedCliPath)).toEqual(new Set(['opus', 'sonnet']));

      // Absence cannot be polled for, and a probe reaches its spawn only after
      // two async hops (the trust step and the node-pty import): give it a fixed budget.
      await allowStrayWriteBudget();
      expect(spawnMock).not.toHaveBeenCalled();
    });
  });
});

describe('the last-scan file outside Electron', () => {
  it('is off by default: a freshly loaded module never reads model-picker-last-scan.json', async () => {
    // A fresh module, with no reset or set helper called on it, so it holds
    // whatever default `lastScanFilePath` starts with. Under plain Node that
    // must be "off", or every unit test would read a developer's real config.
    vi.resetModules();
    const freshProbe = await import('../../src/main/agent/adapters/claude/model-picker-probe');
    // Spy only after the import, so module loading is not the thing observed.
    // The stub throws so a regression cannot read a real config directory.
    const readSpy = vi.spyOn(fs, 'readFileSync').mockImplementation(() => {
      throw new Error('ENOENT');
    });
    try {
      expect(freshProbe.peekModelPickerAliasIds('/a/claude').size).toBe(0);
      const scanFileReads = readSpy.mock.calls
        .map(([filePath]) => String(filePath))
        .filter((filePath) => filePath.endsWith('model-picker-last-scan.json'));
      expect(scanFileReads).toEqual([]);
    } finally {
      readSpy.mockRestore();
    }
  });
});

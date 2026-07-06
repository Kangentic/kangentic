/**
 * Tests for the hidden /model picker probe: the VT screen-grid renderer,
 * the picker parser with its display-name to id derivation, and the spawn
 * orchestration (markers, trust-dialog bail, Esc-not-Enter teardown,
 * success/failure caching).
 *
 * The picker fixtures mirror the empirically captured Claude Code 2.1.170
 * picker layout (probe run 2026-06-09).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  probeModelPickerModels,
  getCachedModelPickerModels,
  resetModelPickerProbeForTests,
  setModelPickerProbeTimingsForTests,
} from '../../src/main/agent/adapters/claude/model-picker-probe';

const spawnMock = pty.spawn as unknown as ReturnType<typeof vi.fn>;

interface FakePtyProcess {
  emitData: (data: string) => void;
  emitExit: () => void;
  writes: string[];
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
    killMock: vi.fn(),
  };
  spawnMock.mockImplementation(() => {
    queueMicrotask(() => onSpawn?.(fake));
    return {
      onData: (callback: (data: string) => void) => {
        dataCallback = callback;
      },
      onExit: (callback: () => void) => {
        exitCallback = callback;
      },
      write: (input: string) => {
        fake.writes.push(input);
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

beforeEach(() => {
  spawnMock.mockReset();
  resetModelPickerProbeForTests();
  setModelPickerProbeTimingsForTests({
    pollIntervalMs: 5,
    typeDelayMs: 5,
    settleIntervalMs: 5,
    overallTimeoutMs: 2000,
  });
});

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
});

describe('parseModelPickerScreen', () => {
  it('extracts ids from the empirical picker layout', () => {
    const screenText = PICKER_FRAME.replace(/\r/gu, '');
    expect(parseModelPickerScreen(screenText)).toEqual([
      'claude-opus-4-8',
      'claude-fable-5',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
    ]);
  });

  it('prefers an explicit (claude-...) id over derivation', () => {
    const screenText = [
      'Select model',
      '  ❯ 1. Opus 4.8 ✔   Best for everyday tasks (claude-opus-4-8-20260101)',
    ].join('\n');
    expect(parseModelPickerScreen(screenText)).toEqual(['claude-opus-4-8-20260101']);
  });

  it('derives ids from versioned display names', () => {
    const screenText = [
      'Select model',
      '    1. Fable    Fable 5 · Most capable',
      '    2. Sonnet   Sonnet 4.6 · Efficient',
    ].join('\n');
    expect(parseModelPickerScreen(screenText)).toEqual(['claude-fable-5', 'claude-sonnet-4-6']);
  });

  it('skips rows that fit neither pattern instead of failing', () => {
    const screenText = [
      'Select model',
      '    1. Custom    Configured by your organization',
      '    2. Haiku     Haiku 4.5 · Fastest',
    ].join('\n');
    expect(parseModelPickerScreen(screenText)).toEqual(['claude-haiku-4-5']);
  });

  it('returns empty when the Select model header is missing', () => {
    expect(parseModelPickerScreen('❯ 1. Yes, I trust this folder')).toEqual([]);
  });

  it('ignores numbered rows above the header', () => {
    const screenText = [
      '    1. Stale 9.9   Leftover row from an earlier overlay',
      'Select model',
      '    1. Haiku       Haiku 4.5 · Fastest',
    ].join('\n');
    expect(parseModelPickerScreen(screenText)).toEqual(['claude-haiku-4-5']);
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

    const models = await probeModelPickerModels('/usr/bin/claude');
    expect(models).toEqual([
      'claude-opus-4-8',
      'claude-fable-5',
      'claude-sonnet-4-6',
      'claude-haiku-4-5',
    ]);
    // Opened with /model + Enter, closed with Esc (never a selecting Enter)
    // and a kill.
    expect(fake.writes).toEqual(['/model', '\r', '\x1b']);
    expect(fake.killMock).toHaveBeenCalled();
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
    expect(fake.killMock).toHaveBeenCalled();
  });

  it('times out to undefined when the picker never renders', async () => {
    setModelPickerProbeTimingsForTests({
      pollIntervalMs: 5,
      typeDelayMs: 5,
      settleIntervalMs: 5,
      overallTimeoutMs: 100,
    });
    const fake = installFakePty((self) => self.emitData(PROMPT_FRAME));

    const models = await probeModelPickerModels('/usr/bin/claude');
    expect(models).toBeUndefined();
    expect(fake.killMock).toHaveBeenCalled();
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
    let warmed: string[] | undefined;
    for (let attempt = 0; attempt < 50 && warmed === undefined; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      warmed = getCachedModelPickerModels('/usr/bin/claude');
    }

    expect(warmed).toEqual([
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

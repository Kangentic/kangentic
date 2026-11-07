/**
 * What the Reset terminal action leaves behind, read the way a remount reads it.
 *
 * A reset that only cleared the live parser would come straight back: the byte
 * ring still holds the original mode sets, and a replay or a respawn re-parses
 * them. So each case drives the real PtyBufferManager and feeds what it serves
 * into a fresh terminal, the way a renderer or a phone would.
 *
 * The live-agent cases are the other half. Claude Code does not re-enter the alt
 * screen or re-send bracketed paste on a repaint, so a full clear would strand a
 * running fullscreen agent.
 */
import { describe, it, expect, vi } from 'vitest';
import { Terminal } from '@xterm/headless';
import { PtyBufferManager } from '../../src/main/pty/buffer/pty-buffer-manager';

const SESSION = 'reset-session';
const COLS = 40;
const ROWS = 12;

/** Every mode the action is about, then a cursor move, so a clear that homes the
 *  cursor shows up. The line-drawing charset turns a typed q into a rule. */
const STUCK_MODES = '\x1b[?1000h\x1b[?1002h\x1b[?1003h\x1b[?1004h\x1b[?1006h\x1b[?2004h\x1b[?1h\x1b[?25l'
  + '\x1b[5;10r\x1b[?6h\x1b(0\x1b[1;31m\x1b[3;5H';

function historyLines(): string {
  let history = '';
  for (let index = 0; index < 30; index += 1) history += `line ${index}\r\n`;
  return history;
}

interface TerminalWithScrollRegion {
  _core: { buffers: { active: { scrollTop: number; scrollBottom: number } } };
}

function createManager() {
  const onFlush = vi.fn();
  const onDrain = vi.fn();
  const onAltScreenExit = vi.fn();
  const manager = new PtyBufferManager({ onFlush, onDrain, onAltScreenExit });
  manager.initSession(SESSION, '', COLS, ROWS, null, true);
  return { manager, onFlush, onDrain, onAltScreenExit };
}

/** A terminal that has parsed `data`, the shape a renderer's replay leaves. */
async function replayInto(data: string): Promise<Terminal> {
  const terminal = new Terminal({ cols: COLS, rows: ROWS, scrollback: 500, allowProposedApi: true });
  await write(terminal, data);
  return terminal;
}

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, resolve));
}

function scrollRegion(terminal: Terminal): { top: number; bottom: number } {
  const active = (terminal as unknown as TerminalWithScrollRegion)._core.buffers.active;
  return { top: active.scrollTop, bottom: active.scrollBottom };
}

function expectDisplayStateCleared(terminal: Terminal): void {
  expect(scrollRegion(terminal)).toEqual({ top: 0, bottom: ROWS - 1 });
  expect(terminal.modes.originMode).toBe(false);
  expect(terminal.modes.wraparoundMode).toBe(true);
}

function expectInputModesOff(terminal: Terminal): void {
  expect(terminal.modes.mouseTrackingMode).toBe('none');
  expect(terminal.modes.bracketedPasteMode).toBe(false);
  expect(terminal.modes.sendFocusMode).toBe(false);
  expect(terminal.modes.applicationCursorKeysMode).toBe(false);
  expect(terminal.modes.showCursor).toBe(true);
}

/** Feed the session and wait until the parser has taken it, so the reset reads
 *  the cursor the stuck bytes left. */
async function feed(manager: PtyBufferManager, data: string): Promise<void> {
  manager.onData(SESSION, data);
  await manager.getSeedFrame(SESSION);
}

describe('a reset with nothing owning the modes', () => {
  const stuckShell = historyLines() + 'prompt> ' + STUCK_MODES;

  it.each([
    ['the ring a byte replay serves', (manager: PtyBufferManager) => Promise.resolve(manager.getScrollback(SESSION))],
    ['the desktop replay', (manager: PtyBufferManager) => manager.getReplaySnapshot(SESSION)],
    ['the parsed frame a phone seeds from', (manager: PtyBufferManager) => manager.getSerializedFrame(SESSION)],
  ])('stays cleared in %s, with the history and the cursor where they were', async (_label, read) => {
    const { manager } = createManager();
    await feed(manager, stuckShell);
    const before = await replayInto(await read(manager));
    expect(before.modes.mouseTrackingMode).toBe('any');
    const cursor = { x: before.buffer.active.cursorX, y: before.buffer.active.cursorY };

    manager.resetTerminalModes(SESSION, false);
    const after = await replayInto(await read(manager));

    expectDisplayStateCleared(after);
    expectInputModesOff(after);
    expect(after.buffer.active.type).toBe('normal');
    expect({ x: after.buffer.active.cursorX, y: after.buffer.active.cursorY }).toEqual(cursor);
    expect(after.buffer.active.baseY).toBe(before.buffer.active.baseY);

    // ASCII again, and SGR back to default, at the cursor the shell expects.
    await write(after, 'q');
    const row = after.buffer.active.getLine(after.buffer.active.baseY + after.buffer.active.cursorY);
    expect(row?.translateToString(true)).toContain('q');
    expect(row?.getCell(after.buffer.active.cursorX - 1)?.isFgDefault()).toBe(true);

    manager.removeSession(SESSION);
  });

  it('leaves a stuck alt screen for the normal buffer and its cursor', async () => {
    const { manager, onAltScreenExit } = createManager();
    await feed(manager, 'older\r\nprompt> \x1b[?1049h\x1b[2Jcrashed frame' + STUCK_MODES);

    manager.resetTerminalModes(SESSION, false);

    const after = await replayInto(await manager.getReplaySnapshot(SESSION));
    expect(after.buffer.active.type).toBe('normal');
    expectInputModesOff(after);
    expectDisplayStateCleared(after);
    expect(after.buffer.active.getLine(1)?.translateToString(true)).toBe('prompt> ');
    expect({ x: after.buffer.active.cursorX, y: after.buffer.active.cursorY }).toEqual({ x: 8, y: 1 });
    // Main's mirror of the alt screen follows, or a resize reads stale state.
    expect(onAltScreenExit).toHaveBeenCalledTimes(1);
    expect(manager.getDimensionState(SESSION)?.inAltScreen).toBe(false);

    manager.removeSession(SESSION);
  });

  it('does not move the cursor to a save it never made when the buffer is already normal', async () => {
    const { manager } = createManager();
    await feed(manager, 'one\r\ntwo\r\nprompt> ');

    manager.resetTerminalModes(SESSION, false);

    const after = await replayInto(await manager.getReplaySnapshot(SESSION));
    expect({ x: after.buffer.active.cursorX, y: after.buffer.active.cursorY }).toEqual({ x: 8, y: 2 });
    manager.removeSession(SESSION);
  });

  it('survives a respawn, whose parser re-reads the carried ring', async () => {
    const { manager } = createManager();
    await feed(manager, stuckShell);
    manager.resetTerminalModes(SESSION, false);
    const carried = manager.getRawScrollback(SESSION);
    const carriedGeometry = manager.getCarryoverGeometry(SESSION);
    manager.removeSession(SESSION);

    manager.initSession(SESSION, carried, COLS, ROWS, carriedGeometry);
    const after = await replayInto(await manager.getSerializedFrame(SESSION));

    expectInputModesOff(after);
    expectDisplayStateCleared(after);
    manager.removeSession(SESSION);
  });

  it('ends an unterminated OSC that was swallowing the output after it', async () => {
    const { manager } = createManager();
    await feed(manager, 'visible\r\n\x1b]0;a title that never ends ');

    manager.resetTerminalModes(SESSION, false);
    await feed(manager, 'after');

    const after = await replayInto(await manager.getSerializedFrame(SESSION));
    expect(after.buffer.active.getLine(1)?.translateToString(true)).toBe('after');
    manager.removeSession(SESSION);
  });
});

describe('a reset while a live agent owns the modes', () => {
  const liveAgent = 'older\r\nprompt> \x1b[?1049h\x1b[2Jframe' + STUCK_MODES;

  it.each([
    ['the desktop replay', (manager: PtyBufferManager) => manager.getReplaySnapshot(SESSION)],
    ['the ring', (manager: PtyBufferManager) => Promise.resolve(manager.getScrollback(SESSION))],
  ])('keeps the alt screen and input modes in %s and clears the display state', async (_label, read) => {
    const { manager, onAltScreenExit } = createManager();
    await feed(manager, liveAgent);

    manager.resetTerminalModes(SESSION, true);

    const after = await replayInto(await read(manager));
    expect(after.buffer.active.type).toBe('alternate');
    expect(after.modes.mouseTrackingMode).toBe('any');
    expect(after.modes.bracketedPasteMode).toBe(true);
    expect(after.modes.sendFocusMode).toBe(true);
    expect(after.modes.applicationCursorKeysMode).toBe(true);
    expectDisplayStateCleared(after);
    expect({ x: after.buffer.active.cursorX, y: after.buffer.active.cursorY }).toEqual({ x: 4, y: 6 });
    expect(onAltScreenExit).not.toHaveBeenCalled();
    expect(manager.getDimensionState(SESSION)?.inAltScreen).toBe(true);

    manager.removeSession(SESSION);
  });
});

describe('the replay route a reset leaves', () => {
  const altScreenSession = 'older\r\nprompt> \x1b[?1049h\x1b[2Jframe';

  it('moves the replay to the parsed frame only when the reset leaves the alt screen', async () => {
    const { manager } = createManager();
    await feed(manager, altScreenSession);
    expect(manager.getDimensionState(SESSION)?.geometryChangedAtRingIndex).toBeNull();

    manager.resetTerminalModes(SESSION, false);

    expect(manager.getDimensionState(SESSION)?.geometryChangedAtRingIndex).not.toBeNull();
    manager.removeSession(SESSION);
  });

  it('keeps the route when a live agent keeps the alt screen', async () => {
    const { manager } = createManager();
    await feed(manager, altScreenSession);

    manager.resetTerminalModes(SESSION, true);

    expect(manager.getDimensionState(SESSION)?.inAltScreen).toBe(true);
    expect(manager.getDimensionState(SESSION)?.geometryChangedAtRingIndex).toBeNull();
    manager.removeSession(SESSION);
  });

  it('keeps the byte replay for a normal-buffer reset, which leaves nothing to rebuild', async () => {
    const { manager } = createManager();
    await feed(manager, 'one\r\ntwo\r\nprompt> ');

    manager.resetTerminalModes(SESSION, false);

    expect(manager.getDimensionState(SESSION)?.geometryChangedAtRingIndex).toBeNull();
    expect(await manager.getReplaySnapshot(SESSION)).toBe(manager.getScrollback(SESSION));
    manager.removeSession(SESSION);
  });
});

describe('the stream a reset lands in', () => {
  it('reaches a mounted terminal and a phone through the flush, with the parser offset exact', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      const { manager, onFlush } = createManager();
      manager.onData(SESSION, 'output');
      manager.resetTerminalModes(SESSION, true);
      await vi.advanceTimersByTimeAsync(50);

      expect(onFlush).toHaveBeenCalledTimes(1);
      const [, flushed, endOffset] = onFlush.mock.calls[0] as [string, string, number];
      expect(flushed.startsWith('output\x1b[r')).toBe(true);
      expect(endOffset).toBe(flushed.length);
      manager.removeSession(SESSION);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does nothing for a session the buffer never held', () => {
    const { manager, onFlush } = createManager();
    expect(() => manager.resetTerminalModes('unknown-session', false)).not.toThrow();
    expect(onFlush).not.toHaveBeenCalled();
    manager.removeSession(SESSION);
  });
});

/**
 * scripts/lib/demo-frame-serializer.js writes a headless xterm screen as PHYSICAL rows, which is
 * what lets the web demo fit a recorded frame to a grid the recording was not made at. The
 * property that matters is the one @xterm/addon-serialize does not have: a row wrapped by the
 * terminal at the recorded width is two rows here, joined with a line break, so replaying the
 * frame into a wider terminal keeps the two rows apart instead of joining them (task #673: the
 * cut left edge and the phantom sidebar were joined rows re-wrapping at a wider grid).
 *
 * Every case replays the serialized frame into a second terminal and reads the result back off
 * its buffer, so the assertions are about what a terminal shows, not about bytes. The last two
 * cases run the two recordings from the task through the same round trip.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/headless';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { ALT_PREFIX, CURSOR_SUFFIX, parsePhysicalFrame, serializePhysicalRows } from '../../scripts/lib/demo-frame-serializer.js';

const FIXTURES_DIR = path.resolve(__dirname, '..', 'captures', 'fixtures', 'demo');

function createTerminal(cols: number, rows: number): Terminal {
  const terminal = new Terminal({ cols, rows, allowProposedApi: true, scrollback: 5000 });
  terminal.loadAddon(new Unicode11Addon());
  terminal.unicode.activeVersion = '11';
  return terminal;
}

function write(terminal: Terminal, data: string): Promise<void> {
  return new Promise((resolve) => terminal.write(data, () => resolve()));
}

/** The visible screen as trimmed row texts. */
function screenRows(terminal: Terminal): string[] {
  const buffer = terminal.buffer.active;
  const rows: string[] = [];
  for (let row = 0; row < terminal.rows; row++) {
    const line = buffer.getLine(buffer.baseY + row);
    rows.push(line ? line.translateToString(true).replace(/\s+$/, '') : '');
  }
  return rows;
}

function wrappedLineCount(terminal: Terminal): number {
  const buffer = terminal.buffer.active;
  let count = 0;
  for (let row = 0; row < buffer.length; row++) {
    if (buffer.getLine(row)?.isWrapped) count += 1;
  }
  return count;
}

async function roundTrip(cols: number, rows: number, bytes: string, scrollback?: number): Promise<{ source: Terminal; frame: string; replayed: Terminal }> {
  const source = createTerminal(cols, rows);
  await write(source, bytes);
  const frame = serializePhysicalRows(source, { scrollback });
  const replayed = createTerminal(cols, rows);
  await write(replayed, frame);
  return { source, frame, replayed };
}

describe('serializePhysicalRows', () => {
  it('writes a wrapped line as two rows, so a wider terminal keeps them apart', async () => {
    const { source, frame, replayed } = await roundTrip(10, 5, 'abcdefghijklmno');
    expect(parsePhysicalFrame(frame).rows).toEqual(['abcdefghij', 'klmno']);
    expect(screenRows(replayed).slice(0, 2)).toEqual(screenRows(source).slice(0, 2));
    // The property the addon lacks: at twice the width the second row stays a row of its own.
    const wider = createTerminal(20, 5);
    await write(wider, frame);
    expect(screenRows(wider).slice(0, 2)).toEqual(['abcdefghij', 'klmno']);
    expect(wrappedLineCount(wider)).toBe(0);
    source.dispose(); replayed.dispose(); wider.dispose();
  });

  it('keeps a styled band to the row end and drops default padding', async () => {
    // A blue band across the whole row (BCE fills the erased cells with the current background),
    // then a row padded with plain spaces the way ConPTY pads every row.
    const { source, frame, replayed } = await roundTrip(10, 4, '\x1b[44mab\x1b[K\x1b[0m\r\ncd        \r\n');
    const rows = parsePhysicalFrame(frame).rows;
    expect(rows[0]).toContain('\x1b[44m');
    expect(rows[0]).toMatch(/\x1b\[8X\x1b\[0m$/);
    expect(rows[1]).toBe('cd');
    const cell = replayed.buffer.active.getLine(0)?.getCell(7);
    const sourceCell = source.buffer.active.getLine(0)?.getCell(7);
    expect(cell?.getBgColor()).toBe(sourceCell?.getBgColor());
    expect(cell?.getBgColorMode()).toBe(sourceCell?.getBgColorMode());
    source.dispose(); replayed.dispose();
  });

  it('starts every row from the default style and resets at its end', async () => {
    const { frame, replayed, source } = await roundTrip(10, 4, '\x1b[1;31mred\r\nstill red\x1b[0m\r\nplain');
    const rows = parsePhysicalFrame(frame).rows;
    // The second row was bold red in the buffer, so it declares that itself rather than relying
    // on the first row's state having leaked across the line break.
    expect(rows[1]).toMatch(/^\x1b\[[0-9;]*m/);
    expect(rows[1]).toMatch(/\x1b\[0m$/);
    expect(rows[2]).toBe('plain');
    expect(screenRows(replayed)).toEqual(screenRows(source));
    source.dispose(); replayed.dispose();
  });

  it('keeps a wide glyph as one code point that the replay lays out as two cells', async () => {
    const { frame, replayed } = await roundTrip(10, 3, '✅x');
    expect(parsePhysicalFrame(frame).rows[0]).toBe('✅x');
    const line = replayed.buffer.active.getLine(0);
    expect(line?.getCell(0)?.getWidth()).toBe(2);
    expect(line?.getCell(2)?.getChars()).toBe('x');
    replayed.dispose();
  });

  it('serializes the alternate screen behind its switch, with no normal-buffer rows', async () => {
    const { frame, replayed } = await roundTrip(20, 5, 'shell prompt\r\n\x1b[?1049h\x1b[2;3Hhello');
    expect(frame.startsWith(ALT_PREFIX)).toBe(true);
    const parsed = parsePhysicalFrame(frame);
    expect(parsed.alt).toBe(true);
    expect(parsed.rows).toEqual(['', '\x1b[2Chello']);
    expect(parsed.cursor).toEqual({ row: 1, col: 7 });
    expect(replayed.buffer.active.type).toBe('alternate');
    expect(screenRows(replayed)).toEqual(['', '  hello', '', '', '']);
    expect(replayed.buffer.active.cursorY).toBe(1);
    expect(replayed.buffer.active.cursorX).toBe(7);
    replayed.dispose();
  });

  it('keeps the rows down to the cursor and drops the empty ones below it', async () => {
    const { frame, replayed } = await roundTrip(20, 8, 'line1\r\nline2\r\n\r\n\r\nline5\x1b[2;3H');
    const parsed = parsePhysicalFrame(frame);
    expect(parsed.rows).toEqual(['line1', 'line2', '', '', 'line5']);
    expect(parsed.cursor).toEqual({ row: 1, col: 2 });
    expect(replayed.buffer.active.cursorY).toBe(1);
    expect(replayed.buffer.active.cursorX).toBe(2);
    replayed.dispose();
  });

  it('keeps every row when scrollback sits above the screen, so the screen lands where it was', async () => {
    const lines = Array.from({ length: 12 }, (_, index) => `line${index + 1}`);
    const { source, frame, replayed } = await roundTrip(20, 5, `${lines.join('\r\n')}\r\n\r\n\x1b[2A`, 5000);
    // Two blank rows below the cursor are part of the frame: without them the replay would sit
    // two rows lower than the recording did.
    expect(parsePhysicalFrame(frame).rows.length).toBe(14);
    expect(screenRows(replayed)).toEqual(screenRows(source));
    expect(replayed.buffer.active.cursorY).toBe(source.buffer.active.cursorY);
    expect(frame).toMatch(CURSOR_SUFFIX);
    source.dispose(); replayed.dispose();
  });

  it('keeps a styled space and drops a plain trailing one', async () => {
    const { frame } = await roundTrip(10, 2, 'ab \x1b[7m \x1b[0m   ');
    expect(parsePhysicalFrame(frame).rows[0]).toBe('ab \x1b[7m \x1b[0m');
  });

  it('carries no terminal modes', async () => {
    const { frame } = await roundTrip(10, 2, '\x1b[?2004h\x1b[?1003h\x1b[?1004hhi');
    expect(frame).not.toContain('\x1b[?2004h');
    expect(frame).not.toContain('\x1b[?1003h');
    expect(frame).not.toContain('\x1b[?1004h');
    expect(parsePhysicalFrame(frame).rows).toEqual(['hi']);
  });

  it('tells a frame that predates it apart by the missing cursor suffix', () => {
    expect(parsePhysicalFrame('abc\r\ndef\x1b[2A\x1b[3D').cursor).toBeNull();
    expect(parsePhysicalFrame('abc\r\ndef\x1b[2;4H').cursor).toEqual({ row: 1, col: 3 });
  });
});

describe('the two recordings from task #673 round-trip at their recorded grid', () => {
  interface Recording { cols: number; rows: number; stream: Array<{ t: number; data: string }> }

  it.each(['contoso-web-copilot-rate-limit.json', 'contoso-web-claude-websocket.json'])('%s', async (file) => {
    const recording = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf-8')) as Recording;
    const source = createTerminal(recording.cols, recording.rows);
    // One write: the stream's windows are the same bytes in the same order, and a write per
    // window costs a parser round trip each.
    await write(source, recording.stream.map((window) => window.data).join(''));
    const frame = serializePhysicalRows(source, { scrollback: 0 });
    const parsed = parsePhysicalFrame(frame);
    expect(parsed.cursor).not.toBeNull();
    // A physical row is at most the recorded width; the addon's joined rows were up to four times it.
    for (const row of parsed.rows) {
      const visible = row.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
      const forward = (row.match(/\x1b\[(\d*)C/g) ?? []).reduce((sum, move) => sum + Number(move.replace(/\D/g, '') || '1'), 0);
      expect([...visible].length + forward).toBeLessThanOrEqual(recording.cols);
    }
    const replayed = createTerminal(recording.cols, recording.rows);
    await write(replayed, frame);
    expect(screenRows(replayed)).toEqual(screenRows(source));
    expect(replayed.buffer.active.cursorY).toBe(source.buffer.active.cursorY);
    expect(replayed.buffer.active.cursorX).toBe(source.buffer.active.cursorX);
    expect(wrappedLineCount(replayed)).toBe(0);
    source.dispose(); replayed.dispose();
  }, 30_000);
});

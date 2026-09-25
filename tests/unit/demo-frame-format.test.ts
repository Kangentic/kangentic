/**
 * Every recording under tests/captures/fixtures/demo/ carries its frames as physical rows
 * (scripts/lib/demo-frame-serializer.js): the final frame, the open frame, and every frame of the
 * timeline. The seed's applier fits a frame to a visitor's grid row by row and recomputes its
 * cursor from the suffix, so a recording still in the addon's joined-row shape would spill at any
 * grid but its own and place its cursor by relative moves that no longer hold. This is the
 * backstop for "run node scripts/backfill-demo-timelines.mjs": a recording captured or edited
 * outside the capture script fails here rather than shipping.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CURSOR_SUFFIX, parsePhysicalFrame } from '../../scripts/lib/demo-frame-serializer.js';
import { wcwidthV11 } from '../../src/shared/xterm-unicode11';

const FIXTURES_DIR = path.resolve(__dirname, '..', 'captures', 'fixtures', 'demo');

interface Recording {
  cols?: number;
  rows?: number;
  serialized?: string;
  openFrame?: { serialized?: string } | null;
  frameTimeline?: Array<{ t: number; frame: string }>;
}

const recordingFiles = fs.readdirSync(FIXTURES_DIR).filter((file) => file.endsWith('.json') && file !== 'manifest.json');

/** A row's width in cells: its text by the app's width table, plus its cursor-forward gaps. */
function rowCells(row: string): number {
  let cells = 0;
  const text = row.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
  for (const glyph of text) cells += wcwidthV11(glyph.codePointAt(0) as number);
  for (const move of row.match(/\x1b\[(\d*)C/g) ?? []) cells += Number(move.replace(/\D/g, '') || '1');
  return cells;
}

function expectPhysical(frame: string, cols: number, where: string): void {
  expect(CURSOR_SUFFIX.test(frame), `${where} has no cursor suffix: run node scripts/backfill-demo-timelines.mjs --force`).toBe(true);
  expect(frame.includes('\x1b[?1003h'), `${where} re-arms mouse tracking`).toBe(false);
  const parsed = parsePhysicalFrame(frame);
  for (const [index, row] of parsed.rows.entries()) {
    expect(rowCells(row), `${where} row ${index} is wider than the recording's ${cols} columns`).toBeLessThanOrEqual(cols);
    expect(row.includes('\r'), `${where} row ${index} carries a bare carriage return`).toBe(false);
  }
}

describe('demo recordings carry physical-row frames', () => {
  it('has recordings to check', () => {
    expect(recordingFiles.length).toBeGreaterThan(0);
  });

  it.each(recordingFiles)('%s', (file) => {
    const recording = JSON.parse(fs.readFileSync(path.join(FIXTURES_DIR, file), 'utf-8')) as Recording;
    expect(typeof recording.cols === 'number' && typeof recording.rows === 'number', `${file} has no grid`).toBe(true);
    const cols = recording.cols as number;
    expectPhysical(String(recording.serialized ?? ''), cols, `${file} serialized`);
    if (recording.openFrame != null) expectPhysical(String(recording.openFrame.serialized ?? ''), cols, `${file} openFrame`);
    for (const step of recording.frameTimeline ?? []) expectPhysical(step.frame, cols, `${file} frame at ${step.t} ms`);
  });
});

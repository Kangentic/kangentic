import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readJsonlWindow,
  streamJsonlRecords,
} from '../../src/main/agent/shared/history-scan';

/**
 * Covers the two bounded-read primitives that replace `readFile(path, 'utf-8')`
 * across the transcript parsers: `readJsonlWindow` (a byte-bounded window of
 * whole lines, tail by default) and `streamJsonlRecords` (a full-file record
 * stream that never materializes the file).
 *
 * The invariants that matter are the ones a caller silently depends on: a
 * window must never hand back a partial line, consecutive windows must tile the
 * file exactly once with no gap and no overlap, and the stream's physical line
 * index must match `content.split(/\r?\n/)` indexing including blank lines
 * (Grok's citation-anchor uuids are built from it).
 */

function record(index: number, payload = 'x'): string {
  return JSON.stringify({ index, payload });
}

describe('readJsonlWindow', () => {
  let tmpDir: string;
  let file: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-window-'));
    file = path.join(tmpDir, 'transcript.jsonl');
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns the whole file when it fits inside maxBytes, omitting nothing', async () => {
    const lines = [record(0), record(1), record(2)];
    fs.writeFileSync(file, `${lines.join('\n')}\n`);

    const window = await readJsonlWindow(file, { maxBytes: 1024 * 1024 });
    expect(window.omittedBytes).toBe(0);
    expect(window.omittedLineCount).toBe(0);
    expect(window.startByte).toBe(0);
    expect(window.text.trim().split('\n')).toEqual(lines);
    expect(window.nextByteOffset).toBe(window.totalBytes);
  });

  it('returns a TAIL window by default and drops the truncated leading line', async () => {
    const lines = Array.from({ length: 20 }, (unused, index) => record(index, 'padding'.repeat(4)));
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    const totalBytes = fs.statSync(file).size;

    // Deliberately a byte budget that lands mid-line rather than on a boundary.
    const window = await readJsonlWindow(file, { maxBytes: Math.floor(totalBytes / 3) });

    expect(window.omittedBytes).toBeGreaterThan(0);
    expect(window.startByte).toBe(window.omittedBytes);
    // Every returned line must be whole and parseable - the point of the drop.
    const returned = window.text.trim().split('\n');
    expect(returned.length).toBeGreaterThan(0);
    for (const line of returned) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    // And it is genuinely the TAIL: the last record of the file is present.
    expect(returned[returned.length - 1]).toBe(lines[lines.length - 1]);
    expect(window.nextByteOffset).toBe(totalBytes);
  });

  it('tiles a file exactly once across consecutive windows: no gap, no overlap, no partial line', async () => {
    const lines = Array.from({ length: 60 }, (unused, index) => record(index, 'body'.repeat(3)));
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    const totalBytes = fs.statSync(file).size;

    // This is the indexer's walk: start at 0 and advance by nextByteOffset.
    // A gap silently drops turns from the conversation index; an overlap
    // double-indexes them. Neither surfaces as an error anywhere.
    const seen: string[] = [];
    let offset = 0;
    let guard = 0;
    while (offset < totalBytes && guard < 500) {
      guard += 1;
      const window = await readJsonlWindow(file, { startByte: offset, maxBytes: 90 });
      if (window.nextByteOffset <= offset) break;
      for (const line of window.text.split('\n')) {
        if (line.length > 0) seen.push(line);
      }
      offset = window.nextByteOffset;
    }

    expect(offset).toBe(totalBytes);
    expect(seen).toEqual(lines);
  });

  it('counts omitted physical lines including blanks only when asked', async () => {
    // Blank lines included: Grok's uuid line index counts them, so a window
    // that renumbers or skips them breaks stored citation anchors.
    // Physical lines 0..5 are: record(0), blank, record(1), blank, record(2), record(3).
    const head = [record(0), '', record(1), '', record(2)].join('\n');
    fs.writeFileSync(file, `${head}\n${record(3)}\n`);
    // Start a few bytes INSIDE line 4, so the partial-line drop lands the
    // window exactly on the start of line 5.
    const startInsideLineFour = Buffer.byteLength(`${head}\n`, 'utf-8') - 3;

    const withoutCount = await readJsonlWindow(file, { startByte: startInsideLineFour, maxBytes: 128 });
    expect(withoutCount.omittedLineCount).toBe(0); // not requested, not computed

    const window = await readJsonlWindow(file, {
      startByte: startInsideLineFour,
      maxBytes: 128,
      countOmittedLines: true,
    });
    // Five physical lines precede the window (2 records, 2 blanks, 1 record).
    expect(window.omittedLineCount).toBe(5);
    expect(window.text.trim()).toBe(record(3));
  });

  it('keeps a final record that has no trailing newline', async () => {
    fs.writeFileSync(file, `${record(0)}\n${record(1)}`);
    const window = await readJsonlWindow(file, { maxBytes: 1024 });
    expect(window.text.trim().split('\n')).toEqual([record(0), record(1)]);
  });

  it('returns an empty window for a missing file instead of throwing', async () => {
    const window = await readJsonlWindow(path.join(tmpDir, 'absent.jsonl'), { maxBytes: 1024 });
    expect(window).toMatchObject({ text: '', totalBytes: 0, omittedBytes: 0 });
  });

  it('makes progress past a single line longer than the whole window', async () => {
    // Pathological but real: one enormous tool_result line. Advancing past it
    // is the only way the walk terminates.
    fs.writeFileSync(file, `${record(0, 'z'.repeat(400))}\n${record(1)}\n`);
    const first = await readJsonlWindow(file, { startByte: 0, maxBytes: 50 });
    expect(first.nextByteOffset).toBeGreaterThan(0);
  });

  it('keeps startByte, omittedBytes, and omittedLineCount byte-exact when a tail window starts inside a multi-byte UTF-8 character', async () => {
    // Regression for a fixed defect: the old tail-window code decoded the
    // whole read buffer to a string FIRST, found the first newline in that
    // decoded string, then re-measured the dropped leading partial line by
    // re-encoding a slice of the ALREADY-DECODED string with
    // Buffer.byteLength. When the window start lands mid-UTF-8-sequence, each
    // orphaned continuation byte decodes to its own U+FFFD replacement
    // character, which re-encodes to THREE bytes - so the re-measured drop
    // over-reports the true byte offset (by 2 bytes per orphaned continuation
    // byte, up to 6 for a 4-byte character), desyncing startByte / omittedBytes
    // / omittedLineCount from the real source offset. The fix slices entirely
    // in the byte domain (indexOf/lastIndexOf on the Buffer) and decodes to
    // text exactly once, at the end.
    const grinningFaceEmoji = '\u{1F600}'; // 4 UTF-8 bytes: F0 9F 98 80
    const lines = [
      record(0),
      '',
      record(1),
      '',
      record(2, grinningFaceEmoji.repeat(5)),
      '', // a blank physical line immediately after the multi-byte record,
          // so a mismeasured drop can also shift which physical line the
          // window is reported to start at (the omittedLineCount half of
          // the defect).
      record(3),
      record(4),
    ];
    fs.writeFileSync(file, `${lines.join('\n')}\n`);
    const fileBuffer = fs.readFileSync(file);
    const totalBytes = fileBuffer.length;

    // Byte offset each physical line starts at, derived from the fixture
    // itself rather than hand-picked, so this stays correct if the fixture
    // strings above ever change.
    const lineStartByteOffsets: number[] = [];
    let cumulativeBytes = 0;
    for (const line of lines) {
      lineStartByteOffsets.push(cumulativeBytes);
      cumulativeBytes += Buffer.byteLength(line, 'utf-8') + 1; // + the trailing newline
    }

    const multiByteRecordLine = lines[4];
    const emojiRunOffsetWithinLine = multiByteRecordLine.indexOf(grinningFaceEmoji.repeat(5));
    const emojiRunStartByte = lineStartByteOffsets[4]
      + Buffer.byteLength(multiByteRecordLine.slice(0, emojiRunOffsetWithinLine), 'utf-8');
    // The lead byte of the third emoji in the run of five: an interior
    // instance, away from the run's own edges, so both "one byte before" and
    // "one byte after" the sweep below stay inside the same record's payload.
    const thirdEmojiLeadByte = emojiRunStartByte + 2 * 4;

    // Whichever byte inside (or immediately around) that emoji run a tail
    // window happens to start at, the FIRST real newline is always the one
    // terminating the multi-byte record's line, so the correct answer is
    // identical across the whole sweep - which is exactly what makes a wrong,
    // input-dependent measurement (the old bug) easy to catch here.
    const expectedStartByte = lineStartByteOffsets[5];
    const expectedOmittedLineCount = 5; // lines 0-4 precede line 5

    let straddledAtLeastOnce = false;
    for (let requestedStart = thirdEmojiLeadByte - 1; requestedStart <= thirdEmojiLeadByte + 4; requestedStart += 1) {
      // A UTF-8 continuation byte has its top two bits set to '10'.
      const isOrphanedContinuationByte = (fileBuffer[requestedStart] & 0xc0) === 0x80;
      if (isOrphanedContinuationByte) straddledAtLeastOnce = true;

      const maxBytes = totalBytes - requestedStart;
      const window = await readJsonlWindow(file, { maxBytes, countOmittedLines: true });

      expect(window.startByte).toBe(expectedStartByte);
      expect(window.omittedBytes).toBe(expectedStartByte);
      expect(window.omittedLineCount).toBe(expectedOmittedLineCount);
      expect(window.nextByteOffset).toBe(totalBytes);
    }
    // Confirms the sweep actually exercised the mid-UTF-8-sequence case and
    // is not merely hitting byte-aligned offsets that the old code also got
    // right by accident.
    expect(straddledAtLeastOnce).toBe(true);
  });

  it('advances past a record longer than the window without losing the unread window of records that follow it', async () => {
    // Regression for a fixed defect: in the no-newline branch (a single
    // record spans the whole window, so there is nothing to slice), the old
    // code computed `nextByteOffset = startByte + bytesRead` where `startByte`
    // already equalled `requestedStart + bytesRead` (the whole window
    // consumed as leading drop) - so it added the window's length TWICE and
    // silently skipped a further, never-read window on every step through an
    // oversized record. The fix measures the advance from `requestedStart`.
    //
    // Swept over several independently-verified oversized-record lengths
    // (all well over 2x maxBytes) rather than one hand-picked length: how far
    // the old double-count carries a window past the oversized record's end
    // depends on byte alignment, and at some lengths it happens to land back
    // on a real line boundary and self-correct. Each length below was
    // confirmed to make the OLD arithmetic drop record 3 before this test was
    // written, so every iteration is genuinely red against it.
    const independentlyVerifiedOversizedPayloadLengths = [100, 120, 220];
    const maxBytes = 64;

    for (const oversizedPayloadLength of independentlyVerifiedOversizedPayloadLengths) {
      const lines = [
        record(0),
        record(1, 'z'.repeat(oversizedPayloadLength)),
        record(2),
        record(3),
        record(4),
        record(5),
        record(6),
      ];
      fs.writeFileSync(file, `${lines.join('\n')}\n`);
      const totalBytes = fs.statSync(file).size;

      // The indexer's walk: start at 0 and advance by nextByteOffset, exactly
      // like the "tiles a file" test above.
      const seenRecordIndexes: number[] = [];
      let offset = 0;
      let guard = 0;
      while (offset < totalBytes && guard < 200) {
        guard += 1;
        const window = await readJsonlWindow(file, { startByte: offset, maxBytes });
        if (window.nextByteOffset <= offset) break;
        for (const line of window.text.split('\n')) {
          if (line.length === 0) continue;
          seenRecordIndexes.push((JSON.parse(line) as { index: number }).index);
        }
        offset = window.nextByteOffset;
      }

      expect(new Set(seenRecordIndexes).size).toBe(seenRecordIndexes.length); // never duplicated
      // The oversized record (index 1) cannot fit any window and is skipped
      // by design. Record 2, immediately adjacent to it, can ALSO be
      // swallowed at some byte alignments - the same leading-line drop that
      // re-synchronizes the walk after an unparseable oversized record can
      // land inside record 2 rather than exactly at its start. That is a
      // property of the "drop the truncated leading line" design generally
      // (it is not what this defect fixed), so record 2's presence is
      // deliberately not asserted either way here. Every record from 3
      // onward, in order, is what this defect fixed and must always survive.
      expect(seenRecordIndexes.filter((index) => index !== 2)).toEqual([0, 3, 4, 5, 6]);
    }
  });
});

describe('streamJsonlRecords', () => {
  let tmpDir: string;
  let file: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-stream-'));
    file = path.join(tmpDir, 'transcript.jsonl');
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('advances the physical line index across blank and unparseable lines', async () => {
    // Must match `content.split(/\r?\n/)` indexing exactly: index 0 is the
    // first record, index 1 the blank, index 2 the malformed line, index 3 the
    // second record. Anything that renumbers here breaks Grok's uuids.
    const raw = [record(0), '', '{not json', record(1)].join('\n');
    fs.writeFileSync(file, `${raw}\n`);

    const seen: Array<{ index: number; lineIndex: number }> = [];
    await streamJsonlRecords(file, (parsed, lineIndex) => {
      seen.push({ index: parsed.index as number, lineIndex });
    });

    expect(seen).toEqual([
      { index: 0, lineIndex: 0 },
      { index: 1, lineIndex: 3 },
    ]);
  });

  it('handles CRLF line endings', async () => {
    fs.writeFileSync(file, `${record(0)}\r\n${record(1)}\r\n`);
    const seen: number[] = [];
    await streamJsonlRecords(file, (parsed) => { seen.push(parsed.index as number); });
    expect(seen).toEqual([0, 1]);
  });

  it('skips non-object JSON values', async () => {
    fs.writeFileSync(file, `42\n"a string"\n[1,2]\n${record(7)}\n`);
    const seen: number[] = [];
    await streamJsonlRecords(file, (parsed) => { seen.push(parsed.index as number); });
    expect(seen).toEqual([7]);
  });

  it('stops early when the callback returns false', async () => {
    const lines = Array.from({ length: 100 }, (unused, index) => record(index));
    fs.writeFileSync(file, `${lines.join('\n')}\n`);

    const seen: number[] = [];
    await streamJsonlRecords(file, (parsed) => {
      seen.push(parsed.index as number);
      return seen.length < 3;
    });

    expect(seen).toEqual([0, 1, 2]);
  });

  it('is a silent no-op for a missing file', async () => {
    let called = false;
    await streamJsonlRecords(path.join(tmpDir, 'absent.jsonl'), () => { called = true; });
    expect(called).toBe(false);
  });

  it('resolves its completion boolean correctly: true only on a full read, false on a missing file or an early stop', async () => {
    // The Claude and Grok cumulative-aggregate callers key off this exact
    // return value to fall back to `null` on a partial read instead of
    // persisting a too-small lifetime total, so the three cases below are
    // each load-bearing on their own, not just illustrative variations.
    const lines = [record(0), record(1), record(2)];
    fs.writeFileSync(file, `${lines.join('\n')}\n`);

    const completedFullRead = await streamJsonlRecords(file, () => { /* no-op */ });
    expect(completedFullRead).toBe(true);

    const completedMissingFile = await streamJsonlRecords(
      path.join(tmpDir, 'absent.jsonl'),
      () => { /* no-op */ },
    );
    expect(completedMissingFile).toBe(false);

    let seenCount = 0;
    const completedEarlyStop = await streamJsonlRecords(file, () => {
      seenCount += 1;
      return seenCount < 2;
    });
    expect(completedEarlyStop).toBe(false);
  });
});

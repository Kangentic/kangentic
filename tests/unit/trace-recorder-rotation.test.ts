/**
 * Unit tests for the trace-recorder's rotation contract.
 *
 * The recorder's public entry points (`recordPtyChunk`,
 * `recordStatusDelta`) are dev-only via `__KANGENTIC_DEV__`, which
 * `vitest.config.ts` pins to `false`. The rotation logic itself is
 * exposed via the pure helper `appendWithRotationSync` so the
 * disk-growth bound is testable without flipping the dev gate.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { appendWithRotationSync } from '../../src/main/activity-engine/trace-recorder';

describe('trace-recorder rotation', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-recorder-test-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('appends without rotating when under cap', () => {
    const filePath = path.join(tempDir, 'sample.jsonl');
    const bytesAfter = appendWithRotationSync(filePath, 'line1\n', 0, 1024);
    expect(bytesAfter).toBe(6);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('line1\n');
    expect(fs.existsSync(filePath + '.1')).toBe(false);
  });

  it('continues appending to primary across multiple writes under cap', () => {
    const filePath = path.join(tempDir, 'sample.jsonl');
    let bytes = appendWithRotationSync(filePath, 'line1\n', 0, 1024);
    bytes = appendWithRotationSync(filePath, 'line2\n', bytes, 1024);
    bytes = appendWithRotationSync(filePath, 'line3\n', bytes, 1024);
    expect(bytes).toBe(18);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('line1\nline2\nline3\n');
    expect(fs.existsSync(filePath + '.1')).toBe(false);
  });

  it('rotates primary to .1 when adding line would exceed cap', () => {
    const filePath = path.join(tempDir, 'sample.jsonl');
    fs.writeFileSync(filePath, 'older content');
    // current at 13 bytes, adding 8 bytes, cap 16 -> 21 > 16 -> rotate.
    const bytesAfter = appendWithRotationSync(filePath, 'fresh-1\n', 13, 16);
    expect(bytesAfter).toBe(8);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('fresh-1\n');
    expect(fs.readFileSync(filePath + '.1', 'utf-8')).toBe('older content');
  });

  it('overwrites the rotated file on subsequent rotations', () => {
    const filePath = path.join(tempDir, 'sample.jsonl');
    fs.writeFileSync(filePath, 'first');
    fs.writeFileSync(filePath + '.1', 'older');
    // current at 5 bytes, adding 6 bytes, cap 5 -> 11 > 5 -> rotate.
    // The previous .1 ('older') is dropped; primary ('first') becomes .1.
    const bytesAfter = appendWithRotationSync(filePath, 'second', 5, 5);
    expect(bytesAfter).toBe(6);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('second');
    expect(fs.readFileSync(filePath + '.1', 'utf-8')).toBe('first');
  });

  it('keeps total disk usage bounded at 2x cap across many writes', () => {
    const filePath = path.join(tempDir, 'sample.jsonl');
    const cap = 256;
    const line = 'x'.repeat(50) + '\n';
    let bytes = 0;
    for (let writeIndex = 0; writeIndex < 100; writeIndex += 1) {
      bytes = appendWithRotationSync(filePath, line, bytes, cap);
    }
    const primarySize = fs.statSync(filePath).size;
    const rotatedSize = fs.existsSync(filePath + '.1')
      ? fs.statSync(filePath + '.1').size
      : 0;
    expect(primarySize).toBeLessThanOrEqual(cap);
    expect(rotatedSize).toBeLessThanOrEqual(cap);
    expect(primarySize + rotatedSize).toBeLessThanOrEqual(2 * cap);
    // Sanity: we wrote 5100 bytes total; the bound enforces <= 512.
    expect(primarySize + rotatedSize).toBeLessThan(5100);
  });

  it('does not rotate when the line lands exactly at cap', () => {
    const filePath = path.join(tempDir, 'sample.jsonl');
    fs.writeFileSync(filePath, 'aaaaa');
    // currentBytes=5, line=5, cap=10 -> 10 not > 10 -> no rotate.
    const bytesAfter = appendWithRotationSync(filePath, 'bbbbb', 5, 10);
    expect(bytesAfter).toBe(10);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('aaaaabbbbb');
    expect(fs.existsSync(filePath + '.1')).toBe(false);
  });

  it('creates a fresh primary when rotating from a missing file', () => {
    const filePath = path.join(tempDir, 'sample.jsonl');
    // No primary exists. currentBytes=0, line=20, cap=10 -> 20 > 10 -> rotate
    // (renameSync silently fails because primary doesn't exist), then
    // appendFileSync creates a fresh primary.
    const bytesAfter = appendWithRotationSync(filePath, 'a'.repeat(20), 0, 10);
    expect(bytesAfter).toBe(20);
    expect(fs.readFileSync(filePath, 'utf-8')).toBe('a'.repeat(20));
    expect(fs.existsSync(filePath + '.1')).toBe(false);
  });
});

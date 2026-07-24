import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getCachedTranscript, truncateEntries, resetForTests } from '../../src/main/agent/transcript-cache';
import type { TranscriptEntry } from '../../src/shared/types';

/**
 * `getCachedTranscript` is the stat-validated per-file cache the conversation
 * viewer's live poll relies on to avoid re-parsing an unchanged transcript
 * file on every tick. Covers: same-reference on an unchanged stat, a fresh
 * parse on a real content change, and LRU eviction past the cap.
 */

function writeFile(dir: string, name: string, content: string): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

describe('getCachedTranscript', () => {
  let tmpDir: string;

  beforeEach(() => {
    resetForTests();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcript-cache-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns the SAME entries array reference on a second call with an unchanged file', async () => {
    const file = writeFile(tmpDir, 'session.jsonl', 'line-one\n');
    let parseCalls = 0;
    const parse = async () => {
      parseCalls += 1;
      return { entries: [{ kind: 'user', uuid: 'u1', ts: 1, text: 'hello' }] as TranscriptEntry[], sourcePath: file };
    };

    const first = await getCachedTranscript('claude_agent', 'agent-1', parse);
    const second = await getCachedTranscript('claude_agent', 'agent-1', parse);

    expect(parseCalls).toBe(1);
    expect(second.entries).toBe(first.entries);
    expect(second.sourcePath).toBe(file);
  });

  it('re-parses and returns a NEW array when the file content actually changes', async () => {
    const file = writeFile(tmpDir, 'session.jsonl', 'line-one\n');
    let parseCalls = 0;
    const parse = async () => {
      parseCalls += 1;
      const text = fs.readFileSync(file, 'utf-8');
      return {
        entries: [{ kind: 'user', uuid: `u${parseCalls}`, ts: parseCalls, text }] as TranscriptEntry[],
        sourcePath: file,
      };
    };

    const first = await getCachedTranscript('claude_agent', 'agent-1', parse);
    // Force a distinct mtime/size: append more content.
    fs.appendFileSync(file, 'line-two\n');
    const second = await getCachedTranscript('claude_agent', 'agent-1', parse);

    expect(parseCalls).toBe(2);
    expect(second.entries).not.toBe(first.entries);
  });

  it('applies the 20k-char span clamp to the cached (truncated) entries', async () => {
    const file = writeFile(tmpDir, 'session.jsonl', 'x');
    const longText = 'A'.repeat(20_010);
    const parse = async () => ({
      entries: [{ kind: 'user', uuid: 'u1', ts: 1, text: longText }] as TranscriptEntry[],
      sourcePath: file,
    });

    const result = await getCachedTranscript('claude_agent', 'agent-1', parse);

    const [entry] = result.entries;
    expect(entry.kind).toBe('user');
    if (entry.kind === 'user') {
      expect(entry.text).not.toBe(longText);
      expect(entry.text).toContain('[truncated 10 chars]');
    }
  });

  it('invalidates the cache entry when the file disappears', async () => {
    const file = writeFile(tmpDir, 'session.jsonl', 'line-one\n');
    const parse = async () => ({
      entries: [{ kind: 'user', uuid: 'u1', ts: 1, text: 'hi' }] as TranscriptEntry[],
      sourcePath: file,
    });
    await getCachedTranscript('claude_agent', 'agent-1', parse);

    fs.rmSync(file, { force: true });
    let secondParseCalled = false;
    const secondParse = async () => {
      secondParseCalled = true;
      return { entries: [] as TranscriptEntry[], sourcePath: null };
    };
    const result = await getCachedTranscript('claude_agent', 'agent-1', secondParse);

    expect(secondParseCalled).toBe(true);
    expect(result.entries).toEqual([]);
  });

  /**
   * The cap has to clear a realistic working set, not just be non-zero. A
   * `--resume` writes a NEW transcript file replaying its parent's history,
   * so one task resumed five times owns five files, and a live board measured
   * 20 files behind ONE mobile Home-feed refresh. The old cap of 16 evicted
   * faster than the feed reused it, so every refresh re-parsed from scratch.
   */
  it('keeps a whole board-sized working set resident', async () => {
    const files: string[] = [];
    for (let index = 0; index < 24; index += 1) {
      const file = writeFile(tmpDir, `busy-${index}.jsonl`, `content-${index}\n`);
      files.push(file);
      await getCachedTranscript('claude_agent', `busy-${index}`, async () => ({
        entries: [{ kind: 'user', uuid: `u${index}`, ts: index, text: `t${index}` }] as TranscriptEntry[],
        sourcePath: file,
      }));
    }

    let reparsed = false;
    await getCachedTranscript('claude_agent', 'busy-0', async () => {
      reparsed = true;
      return { entries: [] as TranscriptEntry[], sourcePath: files[0] };
    });

    expect(reparsed).toBe(false);
  });

  it('evicts the least-recently-used entry once the cache grows past its cap', async () => {
    // Fill past the 64-entry cap and verify the FIRST (oldest, never
    // re-touched) session re-parses on next access.
    const files: string[] = [];
    for (let index = 0; index < 65; index += 1) {
      const file = writeFile(tmpDir, `session-${index}.jsonl`, `content-${index}\n`);
      files.push(file);
      await getCachedTranscript('claude_agent', `agent-${index}`, async () => ({
        entries: [{ kind: 'user', uuid: `u${index}`, ts: index, text: `t${index}` }] as TranscriptEntry[],
        sourcePath: file,
      }));
    }

    let reparsed = false;
    await getCachedTranscript('claude_agent', 'agent-0', async () => {
      reparsed = true;
      return {
        entries: [{ kind: 'user', uuid: 'u0-again', ts: 0, text: 't0-again' }] as TranscriptEntry[],
        sourcePath: files[0],
      };
    });

    expect(reparsed).toBe(true);
  });
});

describe('truncateEntries', () => {
  it('clamps assistant text/thinking blocks and tool_result content, leaving tool_use input untouched', () => {
    const longText = 'A'.repeat(20_100);
    const entries: TranscriptEntry[] = [
      {
        kind: 'assistant',
        uuid: 'a1',
        ts: 1,
        blocks: [
          { type: 'text', text: longText },
          { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'X'.repeat(30_000) } },
        ],
      },
      { kind: 'tool_result', uuid: 'r1', ts: 2, toolUseId: 't1', content: longText },
      { kind: 'system', uuid: 's1', ts: 3, subtype: 'command', text: longText },
    ];

    const [assistant, toolResult, system] = truncateEntries(entries);

    if (assistant.kind === 'assistant') {
      const [textBlock, toolUseBlock] = assistant.blocks;
      expect(textBlock.type === 'text' && textBlock.text.split('\n[truncated')[0].length).toBe(20_000);
      expect(textBlock.type === 'text' && textBlock.text).toContain('[truncated 100 chars]');
      expect(toolUseBlock.type === 'tool_use' && (toolUseBlock.input as { command: string }).command.length).toBe(30_000);
    }
    if (toolResult.kind === 'tool_result') {
      expect(toolResult.content.split('\n[truncated')[0].length).toBe(20_000);
    }
    if (system.kind === 'system') {
      expect(system.text.split('\n[truncated')[0].length).toBe(20_000);
    }
  });
});

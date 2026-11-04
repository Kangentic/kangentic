/**
 * Droid's `fileChangeTools` end to end: a transcript with `Create` and `Edit`
 * tool calls is parsed, chunked into the text the memory index holds, and read
 * back by the change corpus with the adapter's own tool list. Not a pin of the
 * list: it fails when the list stops naming the tools or field Droid uses.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DroidAdapter } from '../../src/main/agent/adapters/droid';
import { parseDroidTranscript } from '../../src/main/agent/adapters/droid/transcript-parser';
import { chunkTranscript } from '../../src/main/retrieval/conversation/transcript-chunker';
import { changedFilesFromChunkTexts } from '../../src/main/retrieval/change/change-record';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

function assistantToolCall(id: string, name: string, input: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'message',
    id: `message-${id}`,
    timestamp: '2026-11-03T10:00:00.000Z',
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
  });
}

describe('Droid fileChangeTools', () => {
  it('finds the files a Create and an Edit call changed in the indexed transcript text', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kg-droid-change-'));
    temporaryDirectories.push(directory);
    const transcriptPath = path.join(directory, 'session.jsonl');
    fs.writeFileSync(transcriptPath, [
      assistantToolCall('tool-1', 'Create', { file_path: '/home/dev/project/src/new-file.ts', content: 'x' }),
      assistantToolCall('tool-2', 'Edit', { file_path: '/home/dev/project/src/existing.ts', old_str: 'a', new_str: 'b' }),
      assistantToolCall('tool-3', 'Read', { file_path: '/home/dev/project/src/only-read.ts' }),
    ].join('\n') + '\n');

    const entries = await parseDroidTranscript('session-1', transcriptPath);
    const chunkTexts = chunkTranscript(entries).map((chunk) => chunk.text);
    const files = changedFilesFromChunkTexts(chunkTexts, new DroidAdapter().fileChangeTools);

    expect([...files.keys()].sort()).toEqual([
      '/home/dev/project/src/existing.ts',
      '/home/dev/project/src/new-file.ts',
    ]);
  });
});

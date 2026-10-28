/**
 * `findCodexTranscriptFile` (src/main/agent/adapters/codex/transcript-parser.ts)
 * remembers where it found each rollout, so an Earlier conversations list that
 * asks for the same rollouts every time it opens does not walk the sessions
 * folder again.
 *
 * What is pinned:
 * - a second find for the same id answers from memory, with no `readdir`;
 * - a remembered path is checked, not trusted: a rollout deleted and rewritten
 *   in another day folder is walked for again and the new path comes back;
 * - the memory is per sessions folder (a different CODEX_HOME is a different
 *   place), and a miss is never remembered, so a rollout written later is found.
 *
 * The memo is module-level and keyed by sessions folder and id, so each test
 * gets a fresh CODEX_HOME and nothing leaks between them. The walk is counted
 * through a spy on `fs.promises.readdir`, which the finder calls at every level.
 * Each test first proves the spy sees the first walk, so "no calls" on the
 * second find cannot pass because the spy never intercepts.
 *
 * Red-green: removing the early `return known` fails the second-find test;
 * dropping the `stat` re-check (returning `known` unchecked) fails the
 * deleted-and-rewritten test; keying the memo by id alone fails the
 * different-folder test.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findCodexTranscriptFile } from '../../src/main/agent/adapters/codex/transcript-parser';

const ROLLOUT_ID = '019df02a-e744-7de2-8f30-63d9ae3ab36a';

describe('findCodexTranscriptFile memo', () => {
  let codexHome: string;
  let originalCodexHome: string | undefined;
  let readdirSpy: ReturnType<typeof vi.spyOn>;
  const extraHomes: string[] = [];

  beforeEach(() => {
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-codex-memo-'));
    originalCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    readdirSpy = vi.spyOn(fs.promises, 'readdir');
  });

  afterEach(() => {
    readdirSpy.mockRestore();
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
    fs.rmSync(codexHome, { recursive: true, force: true });
    for (const home of extraHomes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
  });

  function writeRollout(home: string, year: string, month: string, day: string, sessionId: string): string {
    const directory = path.join(home, 'sessions', year, month, day);
    fs.mkdirSync(directory, { recursive: true });
    const filePath = path.join(directory, `rollout-${year}-${month}-${day}T10-00-00-${sessionId}.jsonl`);
    fs.writeFileSync(filePath, '{}\n');
    return filePath;
  }

  it('answers a second find for the same id from memory, without walking again', async () => {
    const rollout = writeRollout(codexHome, '2026', '10', '20', ROLLOUT_ID);

    await expect(findCodexTranscriptFile(ROLLOUT_ID)).resolves.toBe(rollout);
    // The first find walked year, month and day folders: the spy sees it.
    expect(readdirSpy).toHaveBeenCalled();

    readdirSpy.mockClear();
    await expect(findCodexTranscriptFile(ROLLOUT_ID)).resolves.toBe(rollout);
    expect(readdirSpy).not.toHaveBeenCalled();
  });

  it('walks again when the found rollout was deleted and rewritten in another day folder', async () => {
    const original = writeRollout(codexHome, '2026', '10', '20', ROLLOUT_ID);
    await expect(findCodexTranscriptFile(ROLLOUT_ID)).resolves.toBe(original);
    expect(readdirSpy).toHaveBeenCalled();

    fs.rmSync(original);
    const rewritten = writeRollout(codexHome, '2026', '10', '22', ROLLOUT_ID);
    readdirSpy.mockClear();

    const found = await findCodexTranscriptFile(ROLLOUT_ID);

    expect(found).toBe(rewritten);
    expect(found).not.toBe(original);
    // The remembered path no longer exists, so the walk ran.
    expect(readdirSpy).toHaveBeenCalled();
  });

  it('remembers the new path after it walked again', async () => {
    const original = writeRollout(codexHome, '2026', '10', '20', ROLLOUT_ID);
    await findCodexTranscriptFile(ROLLOUT_ID);
    fs.rmSync(original);
    const rewritten = writeRollout(codexHome, '2026', '10', '22', ROLLOUT_ID);
    await expect(findCodexTranscriptFile(ROLLOUT_ID)).resolves.toBe(rewritten);
    expect(readdirSpy).toHaveBeenCalled();

    readdirSpy.mockClear();
    await expect(findCodexTranscriptFile(ROLLOUT_ID)).resolves.toBe(rewritten);
    expect(readdirSpy).not.toHaveBeenCalled();
  });

  it('keeps the memory per sessions folder: the same id under another CODEX_HOME is a different rollout', async () => {
    const first = writeRollout(codexHome, '2026', '10', '20', ROLLOUT_ID);
    await expect(findCodexTranscriptFile(ROLLOUT_ID)).resolves.toBe(first);

    const otherHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-codex-memo-other-'));
    extraHomes.push(otherHome);
    const second = writeRollout(otherHome, '2026', '10', '21', ROLLOUT_ID);
    process.env.CODEX_HOME = otherHome;

    // The first home's rollout still exists, so only a memo keyed by the folder too answers with the second.
    await expect(findCodexTranscriptFile(ROLLOUT_ID)).resolves.toBe(second);
  });

  it('does not remember a miss: a rollout written afterwards is found', async () => {
    writeRollout(codexHome, '2026', '10', '27', 'aaaaaaaa-0000-4000-8000-000000000002');
    await expect(findCodexTranscriptFile(ROLLOUT_ID)).resolves.toBeNull();
    expect(readdirSpy).toHaveBeenCalled();

    const written = writeRollout(codexHome, '2026', '10', '27', ROLLOUT_ID);

    await expect(findCodexTranscriptFile(ROLLOUT_ID)).resolves.toBe(written);
  });
});

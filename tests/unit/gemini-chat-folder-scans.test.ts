/**
 * Folder scans in two Gemini adapter modules. proveGeminiConversationGone
 * answering true discards a resumable conversation, so each way a chat could
 * still be there (an unreadable folder, a later scan batch, a legacy file, a
 * different id) must answer false. The subagent folder lookup and parser pin
 * which file names count and how a ledger row is keyed.
 * Layout follows Gemini 0.66.0: `<home>/.gemini/tmp/<project>/chats/session-<time>-<first 8 of id>.jsonl`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { proveGeminiConversationGone } from '../../src/main/agent/adapters/gemini/conversation-gone';
import {
  geminiSubagentDirectory,
  statGeminiSubagentTranscripts,
  parseGeminiSubagentUsage,
} from '../../src/main/agent/adapters/gemini/subagent-usage';

const SESSION_ID = '7d21b8e4-5a63-4f0c-b19d-3e8a2c6f4b70';
const FILE_NAME = 'session-2026-09-01T09-00-7d21b8e4.jsonl';
const LEGACY_FILE_NAME = 'session-2026-09-01T09-00-7d21b8e4.json';
const OTHER_PREFIX_FILE_NAME = 'session-2026-09-01T09-00-bbbbbbbb.jsonl';

let home: string;
let tmpRoot: string;
let chats: string;
let cwd: string;
let previousHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-folder-scans-'));
  tmpRoot = path.join(home, '.gemini', 'tmp');
  chats = path.join(tmpRoot, 'petclinic', 'chats');
  fs.mkdirSync(chats, { recursive: true });
  cwd = path.join(home, 'work', 'petclinic');
  previousHome = process.env.GEMINI_CLI_HOME;
  process.env.GEMINI_CLI_HOME = home;
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousHome === undefined) delete process.env.GEMINI_CLI_HOME;
  else process.env.GEMINI_CLI_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

type LooseReaddir = (...args: unknown[]) => Promise<unknown>;

function prove(reportedPaths: string[]): Promise<boolean> {
  return proveGeminiConversationGone({ agentSessionId: SESSION_ID, reportedPaths, cwd });
}

describe('proveGeminiConversationGone folder scans', () => {
  it('is not proof when another project\'s chats folder cannot be read (EACCES)', async () => {
    const lockedChats = path.join(tmpRoot, 'locked-project', 'chats');
    fs.mkdirSync(lockedChats, { recursive: true });
    const original = fs.promises.readdir.bind(fs.promises) as unknown as LooseReaddir;
    const spy = vi.spyOn(fs.promises, 'readdir').mockImplementation(((target: unknown, ...rest: unknown[]) => {
      if (target === lockedChats) {
        return Promise.reject(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
      }
      return original(target, ...rest);
    }) as unknown as typeof fs.promises.readdir);

    await expect(prove([path.join(chats, FILE_NAME)])).resolves.toBe(false);
    expect(spy.mock.calls.some((call) => call[0] === lockedChats)).toBe(true);
  });

  it('finds a chat in a later scan batch (40 project folders, chat in number 35)', async () => {
    const names: string[] = [];
    for (let index = 0; index < 40; index += 1) {
      const name = `p${String(index).padStart(2, '0')}`;
      names.push(name);
      fs.mkdirSync(path.join(tmpRoot, name, 'chats'), { recursive: true });
    }
    fs.writeFileSync(path.join(tmpRoot, names[35], 'chats', FILE_NAME), '{}\n');

    // Directory order is the file system's. Sort the listing so folder 35 is
    // always in the second batch of 32.
    const original = fs.promises.readdir.bind(fs.promises) as unknown as LooseReaddir;
    vi.spyOn(fs.promises, 'readdir').mockImplementation((async (target: unknown, ...rest: unknown[]) => {
      const result = await original(target, ...rest);
      if (target === tmpRoot && Array.isArray(result)) {
        return [...(result as fs.Dirent[])].sort((first, second) => first.name.localeCompare(second.name));
      }
      return result;
    }) as unknown as typeof fs.promises.readdir);

    await expect(prove([path.join(chats, FILE_NAME)])).resolves.toBe(false);
  });

  it('is not proof when another project holds a legacy .json chat for the id', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'old-project', 'chats'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'old-project', 'chats', LEGACY_FILE_NAME), '{}\n');
    await expect(prove([path.join(chats, FILE_NAME)])).resolves.toBe(false);
  });

  it('is not blocked by a project folder with no chats subfolder', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(tmpRoot, 'no-chats-yet'), { recursive: true });
    await expect(prove([path.join(chats, FILE_NAME)])).resolves.toBe(true);
  });

  it('is not proof when the reported path names a different session id', async () => {
    // Nothing holds the real id anywhere, so only the id check keeps this false.
    await expect(prove([path.join(chats, OTHER_PREFIX_FILE_NAME)])).resolves.toBe(false);
  });
});

describe('Gemini subagent folder lookup', () => {
  const PARENT_ID = SESSION_ID;

  it('ignores a reported path naming another session and uses the folder beside the main chat', () => {
    fs.writeFileSync(path.join(chats, FILE_NAME), '{}\n');
    const movedChats = path.join(tmpRoot, 'moved-project', 'chats');
    fs.mkdirSync(movedChats, { recursive: true });
    const reported = path.join(movedChats, OTHER_PREFIX_FILE_NAME);
    expect(geminiSubagentDirectory(PARENT_ID, cwd, null, reported)).toBe(path.join(chats, PARENT_ID));
  });

  it('falls back to the cwd chats folder when no main chat is found', () => {
    const movedChats = path.join(tmpRoot, 'moved-project', 'chats');
    const reported = path.join(movedChats, OTHER_PREFIX_FILE_NAME);
    expect(geminiSubagentDirectory(PARENT_ID, cwd, null, reported)).toBe(path.join(chats, PARENT_ID));
  });

  it('follows a reported path that names this session', () => {
    const movedChats = path.join(tmpRoot, 'moved-project', 'chats');
    const reported = path.join(movedChats, FILE_NAME);
    expect(geminiSubagentDirectory(PARENT_ID, cwd, null, reported)).toBe(path.join(movedChats, PARENT_ID));
  });
});

describe('Gemini subagent transcripts', () => {
  const PARENT_ID = SESSION_ID;
  const tokens = { input: 10, output: 5, cached: 0, total: 15 };

  function subagentFolder(): string {
    const folder = path.join(chats, PARENT_ID);
    fs.mkdirSync(folder, { recursive: true });
    return folder;
  }

  it('counts only .jsonl files', async () => {
    const folder = subagentFolder();
    const reply = `${JSON.stringify({ id: 'g1', type: 'gemini', tokens })}\n`;
    fs.writeFileSync(path.join(folder, 'one.jsonl'), reply);
    fs.writeFileSync(path.join(folder, 'notes.txt'), 'x'.repeat(500));
    fs.writeFileSync(path.join(folder, 'legacy.json'), 'y'.repeat(500));

    const signature = statGeminiSubagentTranscripts(PARENT_ID, cwd, null);
    expect(signature).toMatchObject({ fileCount: 1, totalSize: fs.statSync(path.join(folder, 'one.jsonl')).size });

    const parsed = await parseGeminiSubagentUsage(PARENT_ID, cwd, null);
    expect(parsed.turns.map((turn) => turn.subagentId)).toEqual(['one']);
  });

  it('is null when only non-.jsonl files are there', () => {
    const folder = subagentFolder();
    fs.writeFileSync(path.join(folder, 'notes.txt'), 'x');
    expect(statGeminiSubagentTranscripts(PARENT_ID, cwd, null)).toBeNull();
  });

  it('sums size over several files and reports the newest mtime', () => {
    const folder = subagentFolder();
    const first = path.join(folder, 'a.jsonl');
    const second = path.join(folder, 'b.jsonl');
    const third = path.join(folder, 'c.jsonl');
    fs.writeFileSync(first, 'aaaa\n');
    fs.writeFileSync(second, 'bbbbbbbb\n');
    fs.writeFileSync(third, 'cc\n');
    fs.utimesSync(first, 1_700_000_000, 1_700_000_000);
    fs.utimesSync(second, 1_800_000_000, 1_800_000_000);
    fs.utimesSync(third, 1_600_000_000, 1_600_000_000);

    expect(statGeminiSubagentTranscripts(PARENT_ID, cwd, null)).toEqual({
      fileCount: 3,
      totalSize: fs.statSync(first).size + fs.statSync(second).size + fs.statSync(third).size,
      maxMtimeMs: 1_800_000_000_000,
    });
  });

  it('keys seeded and id-less replies and takes the subagent id from the header', async () => {
    const folder = subagentFolder();
    const headerId = 'c0ffee11-2222-4333-8444-555566667777';
    const lines = [
      { sessionId: headerId, projectHash: '4c1e9a07', kind: 'subagent' },
      {
        $set: {
          messages: [
            { type: 'gemini', tokens },
            { id: 'keep', type: 'gemini', tokens },
          ],
        },
      },
      { type: 'gemini', tokens },
    ];
    // The file name differs from the header id, so only the header can name it.
    fs.writeFileSync(path.join(folder, 'file-name.jsonl'), lines.map((line) => `${JSON.stringify(line)}\n`).join(''));

    const parsed = await parseGeminiSubagentUsage(PARENT_ID, cwd, null);
    expect(parsed.complete).toBe(true);
    expect(parsed.turns.map((turn) => turn.turnUuid)).toEqual([
      `${headerId}:1.0`,
      `${headerId}:keep`,
      `${headerId}:2`,
    ]);
    expect(parsed.turns.every((turn) => turn.subagentId === headerId)).toBe(true);
  });
});

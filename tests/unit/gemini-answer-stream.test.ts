/**
 * Gemini CLI's stream-json, read for a Knowledge Graph answer. The lines are the
 * shapes captured from gemini 0.61.0 on 2026-09-28.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// `removeGeminiChat` reads the home directory through a namespace import of
// `node:os`, which a spy on the default export does not reach, so the module is
// mocked instead: every import of it, named or default, sees the test's home.
const { fakeHome } = vi.hoisted(() => ({ fakeHome: { directory: '' } }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return {
    ...actual,
    default: { ...actual, homedir: () => fakeHome.directory },
    homedir: () => fakeHome.directory,
  };
});

import { extractGeminiAnswer, geminiAnswerEvents, removeGeminiChat } from '../../src/main/agent/adapters/gemini/answer-stream';

const line = (record: Record<string, unknown>): string => JSON.stringify(record);

const INIT = line({ type: 'init', session_id: 'b19dead8-e02c-48c9-b7df-ab38685ea826', model: 'gemini-3-flash-preview' });
const USER = line({ type: 'message', role: 'user', content: 'Count from one to five.' });
const RESULT = line({ type: 'result', status: 'success', stats: { total_tokens: 9873 } });

describe('Gemini answer stream', () => {
  it('turns assistant deltas into text and a tool call into a tool event, and nothing else', () => {
    expect(geminiAnswerEvents(INIT)).toEqual([]);
    expect(geminiAnswerEvents(USER)).toEqual([]);
    expect(geminiAnswerEvents(line({ type: 'message', role: 'assistant', content: 'One\nTwo', delta: true })))
      .toEqual([{ kind: 'text', text: 'One\nTwo' }]);
    expect(geminiAnswerEvents(line({ type: 'tool_use', tool_name: 'read_file', tool_id: 'read_file__call_1', parameters: {} })))
      .toEqual([{ kind: 'tool', name: 'read_file' }]);
    expect(geminiAnswerEvents(RESULT)).toEqual([]);
    expect(geminiAnswerEvents('not json')).toEqual([]);
  });

  it('answers with the text after the last tool call, not the narration before it', () => {
    const stdout = [
      INIT,
      USER,
      line({ type: 'message', role: 'assistant', content: 'I will look first.\n', delta: true }),
      line({ type: 'tool_use', tool_name: 'read_file', tool_id: 'call-1', parameters: {} }),
      line({ type: 'tool_result', tool_id: 'call-1', status: 'success', output: '' }),
      line({ type: 'message', role: 'assistant', content: 'Five tasks ', delta: true }),
      line({ type: 'message', role: 'assistant', content: 'did that.', delta: true }),
      RESULT,
    ].join('\n');
    expect(extractGeminiAnswer(stdout)).toBe('Five tasks did that.');
  });

  it('shows the CLI\'s own error when the run failed with no answer', () => {
    const stdout = [INIT, USER, line({ type: 'result', status: 'error', error: { type: 'FatalError', message: 'quota exhausted' } })].join('\n');
    expect(() => extractGeminiAnswer(stdout)).toThrow('quota exhausted');
  });

  it('fails a run that reported an error after writing part of an answer, rather than passing the part off as whole', () => {
    const stdout = [
      INIT,
      USER,
      line({ type: 'message', role: 'assistant', content: 'Three tasks changed the ', delta: true }),
      line({ type: 'result', status: 'error', error: { type: 'ApiError', message: 'model overloaded (503)' } }),
    ].join('\n');
    expect(() => extractGeminiAnswer(stdout)).toThrow('model overloaded (503)');
  });
});

/**
 * `removeGeminiChat` deletes files and folders under the user's Gemini home
 * after a headless run, so these run against a real directory tree under a
 * temporary home, never the machine's own. Gemini names a saved chat
 * `session-<time>-<first 8 of the session id>.jsonl` under
 * `~/.gemini/tmp/<slug>/chats/`, and a folder named by the whole id for any
 * subagent it ran.
 */
describe('removeGeminiChat', () => {
  const SESSION_ID = 'b19dead8-e02c-48c9-b7df-ab38685ea826';
  const OTHER_SESSION_ID = 'c4d5e6f7-1a2b-4c3d-8e9f-0a1b2c3d4e5f';
  let temporaryHome: string;
  let workingDirectory: string;
  /** The folder-name slug Gemini falls back to: unique per run, so even a redirect
   *  that failed to take could never name a folder that exists in a real home. */
  let folderSlug: string;

  beforeEach(() => {
    temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-gemini-home-'));
    fakeHome.directory = temporaryHome;
    workingDirectory = fs.mkdtempSync(path.join(temporaryHome, 'cwd-'));
    folderSlug = path.basename(workingDirectory);
  });

  afterEach(() => {
    fakeHome.directory = '';
    fs.rmSync(temporaryHome, { recursive: true, force: true });
  });

  const chatsDirectory = (slug: string): string => path.join(temporaryHome, '.gemini', 'tmp', slug, 'chats');

  function makeChatFile(slug: string, name: string): string {
    const filePath = path.join(chatsDirectory(slug), name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{"type":"message"}\n');
    return filePath;
  }

  function makeChatFolder(slug: string, name: string): string {
    const folderPath = path.join(chatsDirectory(slug), name);
    fs.mkdirSync(folderPath, { recursive: true });
    fs.writeFileSync(path.join(folderPath, 'subagent.jsonl'), '{"type":"message"}\n');
    return folderPath;
  }

  function writeRegistry(projects: Record<string, string>): void {
    fs.mkdirSync(path.join(temporaryHome, '.gemini'), { recursive: true });
    fs.writeFileSync(path.join(temporaryHome, '.gemini', 'projects.json'), JSON.stringify({ projects }));
  }

  it('removes the run\'s own chat file and its subagent folder, and leaves another session\'s alone', async () => {
    // No registry: the working directory's folder name is the slug.
    const ownFile = makeChatFile(folderSlug, 'session-2026-09-28T10-11-b19dead8.jsonl');
    const ownFolder = makeChatFolder(folderSlug, SESSION_ID);
    const otherFile = makeChatFile(folderSlug, 'session-2026-09-28T10-12-c4d5e6f7.jsonl');
    const otherFolder = makeChatFolder(folderSlug, OTHER_SESSION_ID);
    // Carries the short id but is not a saved chat, so it is not this run's to remove.
    const unrelatedFile = makeChatFile(folderSlug, 'notes-b19dead8.txt');

    await removeGeminiChat(workingDirectory, SESSION_ID);

    expect(fs.existsSync(ownFile)).toBe(false);
    expect(fs.existsSync(ownFolder)).toBe(false);
    expect(fs.existsSync(otherFile)).toBe(true);
    expect(fs.existsSync(otherFolder)).toBe(true);
    expect(fs.existsSync(unrelatedFile)).toBe(true);
  });

  it('reads the slug from Gemini\'s project registry when it names the working directory, and leaves the folder-name slug alone', async () => {
    writeRegistry({ [workingDirectory]: 'registered-slug', '/mock/elsewhere': 'elsewhere-slug' });
    const registered = makeChatFile('registered-slug', 'session-2026-09-28T10-11-b19dead8.jsonl');
    // The registry wins over the folder name: this chat is another project's.
    const byFolderName = makeChatFile(folderSlug, 'session-2026-09-28T10-11-b19dead8.jsonl');
    const elsewhere = makeChatFile('elsewhere-slug', 'session-2026-09-28T10-11-b19dead8.jsonl');

    await removeGeminiChat(workingDirectory, SESSION_ID);

    expect(fs.existsSync(registered)).toBe(false);
    expect(fs.existsSync(byFolderName)).toBe(true);
    expect(fs.existsSync(elsewhere)).toBe(true);
  });

  it('falls back to the folder name when the registry has no entry for the directory, or cannot be read', async () => {
    writeRegistry({ '/mock/elsewhere': 'elsewhere-slug' });
    const byFolderName = makeChatFile(folderSlug, 'session-2026-09-28T10-11-b19dead8.jsonl');
    const elsewhere = makeChatFile('elsewhere-slug', 'session-2026-09-28T10-11-b19dead8.jsonl');

    await removeGeminiChat(workingDirectory, SESSION_ID);
    expect(fs.existsSync(byFolderName)).toBe(false);
    expect(fs.existsSync(elsewhere)).toBe(true);

    fs.writeFileSync(path.join(temporaryHome, '.gemini', 'projects.json'), '{ not json');
    const again = makeChatFile(folderSlug, 'session-2026-09-28T10-13-b19dead8.jsonl');
    await removeGeminiChat(workingDirectory, SESSION_ID);
    expect(fs.existsSync(again)).toBe(false);
    expect(fs.existsSync(elsewhere)).toBe(true);
  });

  it('does nothing, and does not throw, when the run saved no chat', async () => {
    await expect(removeGeminiChat(workingDirectory, SESSION_ID)).resolves.toBeUndefined();
    expect(fs.existsSync(path.join(temporaryHome, '.gemini', 'tmp'))).toBe(false);
  });
});

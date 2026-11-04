/**
 * Proof that a Gemini conversation's chat file is gone, so a resume starts
 * fresh from a recap instead of failing. A wrong `true` throws away a live
 * conversation's context, so every case short of proof must answer false.
 * Layout follows Gemini 0.66.0: `<home>/.gemini/tmp/<project>/chats/session-<time>-<first 8 of id>.jsonl`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { proveGeminiConversationGone } from '../../src/main/agent/adapters/gemini/conversation-gone';

const SESSION_ID = '7d21b8e4-5a63-4f0c-b19d-3e8a2c6f4b70';
const FILE_NAME = 'session-2026-09-01T09-00-7d21b8e4.jsonl';

let home: string;
let tmpRoot: string;
let cwd: string;
let previousHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'gemini-gone-'));
  tmpRoot = path.join(home, '.gemini', 'tmp');
  fs.mkdirSync(path.join(tmpRoot, 'petclinic', 'chats'), { recursive: true });
  cwd = path.join(home, 'work', 'petclinic');
  previousHome = process.env.GEMINI_CLI_HOME;
  process.env.GEMINI_CLI_HOME = home;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.GEMINI_CLI_HOME;
  else process.env.GEMINI_CLI_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

const reportedPath = (): string => path.join(tmpRoot, 'petclinic', 'chats', FILE_NAME);

describe('proveGeminiConversationGone', () => {
  it('proves it when the reported chat and every project folder lack it', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'other-project', 'chats'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'other-project', 'chats', 'session-2026-09-01T09-00-aaaaaaaa.jsonl'), '{}\n');
    await expect(proveGeminiConversationGone({ agentSessionId: SESSION_ID, reportedPaths: [reportedPath()], cwd })).resolves.toBe(true);
  });

  it('is not proof while the reported chat is there', async () => {
    fs.writeFileSync(reportedPath(), '{}\n');
    await expect(proveGeminiConversationGone({ agentSessionId: SESSION_ID, reportedPaths: [reportedPath()], cwd })).resolves.toBe(false);
  });

  it('is not proof when another project folder holds the chat (a renamed worktree)', async () => {
    fs.mkdirSync(path.join(tmpRoot, 'petclinic-renamed', 'chats'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'petclinic-renamed', 'chats', FILE_NAME), '{}\n');
    await expect(proveGeminiConversationGone({ agentSessionId: SESSION_ID, reportedPaths: [reportedPath()], cwd })).resolves.toBe(false);
  });

  it('is not proof when the reader\'s own folder holds a chat for the id under another time', async () => {
    fs.writeFileSync(path.join(tmpRoot, 'petclinic', 'chats', 'session-2026-10-01T09-00-7d21b8e4.jsonl'), '{}\n');
    await expect(proveGeminiConversationGone({ agentSessionId: SESSION_ID, reportedPaths: [reportedPath()], cwd })).resolves.toBe(false);
  });

  it('is not proof with no reported path, or one naming another conversation', async () => {
    await expect(proveGeminiConversationGone({ agentSessionId: SESSION_ID, reportedPaths: [], cwd })).resolves.toBe(false);
    const other = path.join(tmpRoot, 'petclinic', 'chats', 'session-2026-09-01T09-00-bbbbbbbb.jsonl');
    await expect(proveGeminiConversationGone({ agentSessionId: SESSION_ID, reportedPaths: [other], cwd })).resolves.toBe(false);
  });

  it('is not proof for a relative path or one outside Gemini\'s tmp/<project>/chats layout', async () => {
    await expect(proveGeminiConversationGone({ agentSessionId: SESSION_ID, reportedPaths: [path.join('chats', FILE_NAME)], cwd })).resolves.toBe(false);
    const stray = path.join(home, 'elsewhere', 'chats', FILE_NAME);
    await expect(proveGeminiConversationGone({ agentSessionId: SESSION_ID, reportedPaths: [stray], cwd })).resolves.toBe(false);
  });

  it('is not proof when Gemini\'s tmp folder cannot be listed', async () => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    await expect(proveGeminiConversationGone({ agentSessionId: SESSION_ID, reportedPaths: [reportedPath()], cwd })).resolves.toBe(false);
  });
});

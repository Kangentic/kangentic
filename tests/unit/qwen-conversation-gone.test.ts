/**
 * `proveQwenConversationGone`: a `qwen --resume <uuid>` of a deleted chat
 * exits with "No saved session found with ID" (packages/cli/src/config/config.ts,
 * v0.26.6), so a resume of a conversation proven gone starts fresh from a
 * recap. Every step short of proof must answer false, which resumes as before:
 * a false "gone" throws away a conversation the CLI could still resume.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { proveQwenConversationGone } from '../../src/main/agent/adapters/qwen-code/conversation-gone';
import { PROJECT_SCAN_BATCH, noFolderHolds } from '../../src/main/agent/shared/project-folders';
import { qwenChatsDir } from '../../src/main/agent/adapters/qwen-code/session-history-parser';

const SESSION_ID = '5d6f1c2a-7b3e-4c1d-9a8f-0e2b4c6d8f10';

let qwenHome: string;
let cwd: string;

beforeEach(() => {
  qwenHome = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gone-home-'));
  cwd = path.join(qwenHome, 'workspace', 'project');
  fs.mkdirSync(cwd, { recursive: true });
  process.env.QWEN_HOME = qwenHome;
  // An exported one would move the chats out of the temp home.
  delete process.env.QWEN_RUNTIME_DIR;
});

afterEach(() => {
  delete process.env.QWEN_HOME;
  fs.rmSync(qwenHome, { recursive: true, force: true });
});

/** The path the SessionStart hook reported: the chats folder exists, the file does not. */
function reportedPath(): string {
  const chats = qwenChatsDir(cwd);
  fs.mkdirSync(chats, { recursive: true });
  return path.join(chats, `${SESSION_ID}.jsonl`);
}

describe('proveQwenConversationGone', () => {
  it('proves a chat gone from the reported path, the reader path and every project folder', async () => {
    const reported = reportedPath();
    fs.mkdirSync(path.join(qwenHome, 'projects', 'another-project', 'chats'), { recursive: true });
    expect(await proveQwenConversationGone({ agentSessionId: SESSION_ID, reportedPaths: [reported], cwd })).toBe(true);
  });

  it('is not proof while the chat is on disk', async () => {
    const reported = reportedPath();
    fs.writeFileSync(reported, '{}\n');
    expect(await proveQwenConversationGone({ agentSessionId: SESSION_ID, reportedPaths: [reported], cwd })).toBe(false);
  });

  it('is not proof while another project folder holds the chat', async () => {
    const reported = reportedPath();
    const elsewhere = path.join(qwenHome, 'projects', 'renamed-worktree', 'chats');
    fs.mkdirSync(elsewhere, { recursive: true });
    fs.writeFileSync(path.join(elsewhere, `${SESSION_ID}.jsonl`), '{}\n');
    expect(await proveQwenConversationGone({ agentSessionId: SESSION_ID, reportedPaths: [reported], cwd })).toBe(false);
  });

  it('is not proof without a reported path naming this conversation', async () => {
    reportedPath();
    expect(await proveQwenConversationGone({ agentSessionId: SESSION_ID, reportedPaths: [], cwd })).toBe(false);
    const other = path.join(qwenChatsDir(cwd), 'another-id.jsonl');
    expect(await proveQwenConversationGone({ agentSessionId: SESSION_ID, reportedPaths: [other], cwd })).toBe(false);
    expect(await proveQwenConversationGone({ agentSessionId: SESSION_ID, reportedPaths: [`chats/${SESSION_ID}.jsonl`], cwd })).toBe(false);
  });

  it('is not proof when the projects folder cannot be read', async () => {
    // A reported path under a runtime folder that is not there at all, as for
    // a WSL distro that is not running.
    const unreachable = path.join(qwenHome, 'gone-runtime', 'projects', 'slug', 'chats', `${SESSION_ID}.jsonl`);
    expect(await proveQwenConversationGone({ agentSessionId: SESSION_ID, reportedPaths: [unreachable], cwd })).toBe(false);
  });

  it('is not proof when the folder above the chats folder is not named projects', async () => {
    // Not Qwen's layout: <root>/foo/chats/<id>.jsonl. The root is readable and
    // holds no copy, but there is no projects folder to search.
    const root = path.join(qwenHome, 'odd-layout');
    const chats = path.join(root, 'foo', 'chats');
    fs.mkdirSync(chats, { recursive: true });
    const reported = path.join(chats, `${SESSION_ID}.jsonl`);
    expect(await proveQwenConversationGone({ agentSessionId: SESSION_ID, reportedPaths: [reported], cwd })).toBe(false);
  });

  // `proveQwenConversationGone` lists the projects folder with readdir, whose
  // order is unsorted on Linux, so it cannot place the holder past the first
  // batch. The scan itself is driven here with an explicit order.
  it('is not proof when the chat sits in a project folder past the first scan batch', async () => {
    const projectsRoot = path.join(qwenHome, 'projects');
    const folders: string[] = [];
    for (let index = 0; index < PROJECT_SCAN_BATCH + 8; index += 1) {
      const folder = path.join(projectsRoot, `project-${String(index).padStart(3, '0')}`);
      fs.mkdirSync(path.join(folder, 'chats'), { recursive: true });
      folders.push(folder);
    }
    const relativePath = path.join('chats', `${SESSION_ID}.jsonl`);
    const holderFile = path.join(folders[PROJECT_SCAN_BATCH + 3], relativePath);
    fs.writeFileSync(holderFile, '{}\n');

    expect(await noFolderHolds(folders, relativePath)).toBe(false);
    // The same scan with the holder removed proves it gone, so the false above is the second batch's doing.
    fs.rmSync(holderFile, { force: true });
    expect(await noFolderHolds(folders, relativePath)).toBe(true);
  });

  it('is not proof when the reader path still holds the chat', async () => {
    // The hook reported a runtime folder the reader does not know, and the
    // reader's own path has the chat.
    const otherRuntime = path.join(qwenHome, 'other-runtime', 'projects', 'slug', 'chats');
    fs.mkdirSync(otherRuntime, { recursive: true });
    const readerChats = qwenChatsDir(cwd);
    fs.mkdirSync(readerChats, { recursive: true });
    fs.writeFileSync(path.join(readerChats, `${SESSION_ID}.jsonl`), '{}\n');
    const reported = path.join(otherRuntime, `${SESSION_ID}.jsonl`);
    expect(await proveQwenConversationGone({ agentSessionId: SESSION_ID, reportedPaths: [reported], cwd })).toBe(false);
  });
});

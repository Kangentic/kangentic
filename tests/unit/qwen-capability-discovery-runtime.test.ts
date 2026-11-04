/**
 * The model scan in discoverQwenCapabilities reads `projects/` under Qwen's
 * RUNTIME directory (`qwenRuntimeDir`), which QWEN_RUNTIME_DIR moves away from
 * QWEN_HOME. Unlike qwen-capability-discovery.test.ts, the history scan here
 * is real: chats are written to temp directories.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
  exec: vi.fn(),
}));

vi.mock('node:util', () => ({
  promisify: (fn: unknown) => fn,
}));

import { execFile, exec } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { discoverQwenCapabilities } from '../../src/main/agent/adapters/qwen-code/capability-discovery';

const execMock = exec as unknown as ReturnType<typeof vi.fn>;
const execFileMock = execFile as unknown as ReturnType<typeof vi.fn>;

let tmpBase: string;
let savedQwenHome: string | undefined;
let savedRuntimeDir: string | undefined;

/** One chat under `<root>/projects/<project>/chats/`, holding an assistant record naming `model`. */
function writeChat(root: string, project: string, model: string): void {
  const chatsDir = path.join(root, 'projects', project, 'chats');
  fs.mkdirSync(chatsDir, { recursive: true });
  const record = {
    uuid: 'msg-1',
    sessionId: 'sess-1',
    timestamp: '2026-04-26T20:18:36.836Z',
    type: 'assistant',
    model,
    message: { role: 'model', parts: [{ text: 'hi' }] },
  };
  fs.writeFileSync(path.join(chatsDir, 'sess-1.jsonl'), JSON.stringify(record) + '\n', 'utf-8');
}

beforeEach(() => {
  savedQwenHome = process.env.QWEN_HOME;
  savedRuntimeDir = process.env.QWEN_RUNTIME_DIR;
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-capability-runtime-'));
  process.env.QWEN_HOME = path.join(tmpBase, 'home');
  process.env.QWEN_RUNTIME_DIR = path.join(tmpBase, 'runtime');
  const helpOutput = Promise.resolve({ stdout: '  -m, --model Model\n' });
  execMock.mockReset();
  execFileMock.mockReset();
  execMock.mockReturnValue(helpOutput);
  execFileMock.mockReturnValue(helpOutput);
});

afterEach(() => {
  if (savedQwenHome === undefined) delete process.env.QWEN_HOME;
  else process.env.QWEN_HOME = savedQwenHome;
  if (savedRuntimeDir === undefined) delete process.env.QWEN_RUNTIME_DIR;
  else process.env.QWEN_RUNTIME_DIR = savedRuntimeDir;
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

describe('discoverQwenCapabilities with QWEN_RUNTIME_DIR', () => {
  it('finds the model in chats under the runtime dir', async () => {
    writeChat(path.join(tmpBase, 'runtime'), 'c--users-dev-repo', 'model-in-runtime-dir');

    const capabilities = await discoverQwenCapabilities('/usr/bin/qwen');

    expect(capabilities.supportsModelOverride).toBe(true);
    expect(capabilities.models).toEqual(['model-in-runtime-dir']);
  });

  it('does not read chats left under QWEN_HOME once the runtime dir is elsewhere', async () => {
    writeChat(path.join(tmpBase, 'runtime'), 'c--users-dev-repo', 'model-in-runtime-dir');
    writeChat(path.join(tmpBase, 'home'), 'c--users-dev-other', 'model-in-home-dir');

    const capabilities = await discoverQwenCapabilities('/usr/bin/qwen');

    expect(capabilities.models).toEqual(['model-in-runtime-dir']);
  });
});

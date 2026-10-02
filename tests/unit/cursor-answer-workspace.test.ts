/**
 * `removeCursorChat` deletes a folder of Cursor's, recursively, from a chat id
 * read off the CLI's own output. What the id may be is all that stands between a
 * malformed line and a delete of the whole chats folder, so these run against a
 * real directory tree under a temporary home, never the machine's own.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeCursorChat } from '../../src/main/agent/adapters/cursor/answer-workspace';

describe('removeCursorChat', () => {
  let temporaryHome: string;
  let chatsRoot: string;

  beforeEach(() => {
    temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-cursor-home-'));
    chatsRoot = path.join(temporaryHome, '.cursor', 'chats');
    // The module reads the home directory through the default `os` import, the
    // same object spied on here.
    vi.spyOn(os, 'homedir').mockReturnValue(temporaryHome);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(temporaryHome, { recursive: true, force: true });
  });

  /** A chat folder with a file in it, under Cursor's workspace-hash layout. */
  function makeChat(workspace: string, chatId: string): string {
    const directory = path.join(chatsRoot, workspace, chatId);
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, 'store.db'), 'chat');
    return directory;
  }

  it('removes the folder of the chat it is given and no other', async () => {
    const target = makeChat('workspace-a', 'chat-1');
    const sibling = makeChat('workspace-a', 'chat-2');
    const otherWorkspace = makeChat('workspace-b', 'chat-3');

    await removeCursorChat('chat-1');

    expect(fs.existsSync(target)).toBe(false);
    expect(fs.existsSync(sibling)).toBe(true);
    expect(fs.existsSync(otherWorkspace)).toBe(true);
  });

  it('finds the chat under whichever workspace holds it, and accepts a uuid and an underscore', async () => {
    const uuid = '3f2a9c1e-7b64-4d2a-9c11-0a1b2c3d4e5f';
    makeChat('workspace-a', 'chat-1');
    const inSecond = makeChat('workspace-b', uuid);
    const underscored = makeChat('workspace-b', 'chat_7');

    await removeCursorChat(uuid);
    expect(fs.existsSync(inSecond)).toBe(false);
    await removeCursorChat('chat_7');
    expect(fs.existsSync(underscored)).toBe(false);
    expect(fs.existsSync(path.join(chatsRoot, 'workspace-a', 'chat-1'))).toBe(true);
  });

  it('removes nothing for an id that is not a plain name, since the id becomes a path segment of a recursive delete', async () => {
    const first = makeChat('workspace-a', 'chat-1');
    const second = makeChat('workspace-b', 'chat-2');

    // `..` and `.` would name the chats folder and a whole workspace, an empty
    // id a whole workspace, and the rest climb out of or widen the chat folder.
    for (const unsafeId of ['..', '.', '', '../workspace-a', 'chat-1/..', 'chat-1\\..', 'workspace-a/chat-1', 'chat 1']) {
      await removeCursorChat(unsafeId);
      const label = `after removeCursorChat(${JSON.stringify(unsafeId)})`;
      expect(fs.existsSync(chatsRoot), label).toBe(true);
      expect(fs.existsSync(path.join(chatsRoot, 'workspace-a')), label).toBe(true);
      expect(fs.existsSync(first), label).toBe(true);
      expect(fs.existsSync(second), label).toBe(true);
    }
  });

  it('does nothing when there are no chats to search', async () => {
    await expect(removeCursorChat('chat-1')).resolves.toBeUndefined();
    expect(fs.existsSync(chatsRoot)).toBe(false);
  });
});

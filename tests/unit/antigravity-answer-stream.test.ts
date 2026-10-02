/**
 * Antigravity's stream-json answer events, from lines captured on agy 1.2.11
 * (trimmed to the fields read).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  antigravityAnswerEvents,
  antigravityConversationId,
  removeAntigravityConversation,
} from '../../src/main/agent/adapters/antigravity/answer-stream';
import { antigravityDataRoot } from '../../src/main/agent/adapters/antigravity/data-paths';

const ID = 'b703337b-c991-4fd6-9136-8b2f57d4c0e9';
const CAPTURED = [
  { event: 'init', conversation_id: ID, init: { cwd: 'C:\\answer-home', tools: ['call_mcp_tool'] } },
  { event: 'step_update', step_update: { conversation_id: ID, step_index: 0, state: 'DONE', step_type: 'user_input' } },
  { event: 'step_update', step_update: { conversation_id: ID, step_index: 2, state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command' } },
  { event: 'step_update', step_update: { conversation_id: ID, step_index: 2, state: 'ERROR', step_type: 'tool', tool_name: 'run_command' } },
  { event: 'step_update', step_update: { conversation_id: ID, step_index: 3, state: 'ACTIVE', step_type: 'agent_response', text_delta: 'One\nTwo' } },
  { event: 'step_update', step_update: { conversation_id: ID, step_index: 3, state: 'DONE', step_type: 'agent_response', text_delta: '\n' } },
  { event: 'result', result: { conversation_id: ID, status: 'SUCCESS', response: 'One\nTwo\n' } },
].map((record) => JSON.stringify(record));

describe('antigravityAnswerEvents', () => {
  it('passes text deltas as they are written and a tool once, as it starts', () => {
    expect(CAPTURED.flatMap(antigravityAnswerEvents)).toEqual([
      { kind: 'tool', name: 'run_command' },
      { kind: 'text', text: 'One\nTwo' },
      { kind: 'text', text: '\n' },
    ]);
  });
});

describe('antigravityConversationId', () => {
  it('reads the conversation id off the init event only', () => {
    expect(antigravityConversationId(CAPTURED[0])).toBe(ID);
    expect(antigravityConversationId(CAPTURED[1])).toBeNull();
  });
});

/**
 * `removeAntigravityConversation` deletes a folder and two files, recursively,
 * from a conversation id read off the CLI's own output. What the id may be is
 * all that stands between a malformed line and a delete of a whole folder of the
 * user's conversations, so these run against a real directory tree under a
 * temporary home, never the machine's own.
 */
describe('removeAntigravityConversation', () => {
  const OTHER_ID = '0f1e2d3c-4b5a-4968-8777-665544332211';
  let temporaryHome: string;
  let dataRoot: string;

  beforeEach(() => {
    temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-agy-home-'));
    // The data root reads the home directory through the default `os` import,
    // the same object spied on here.
    vi.spyOn(os, 'homedir').mockReturnValue(temporaryHome);
    dataRoot = antigravityDataRoot();
    // The redirect took effect: nothing below can act on the machine's own data.
    expect(dataRoot).toBe(path.join(temporaryHome, '.gemini', 'antigravity-cli'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(temporaryHome, { recursive: true, force: true });
  });

  function writeFile(...segments: string[]): string {
    const filePath = path.join(dataRoot, ...segments);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'data');
    return filePath;
  }

  /** What one conversation leaves in the data root: its transcript folder, its database, its presence lock. */
  function makeConversation(conversationId: string) {
    return {
      brainFolder: path.dirname(path.dirname(path.dirname(writeFile('brain', conversationId, '.system_generated', 'logs', 'transcript.jsonl')))),
      database: writeFile('conversations', `${conversationId}.db`),
      lock: writeFile('presence', `${conversationId}.lock`),
    };
  }

  /** Every file and folder in the data root, so a test can tell nothing was touched. */
  const snapshot = (): string[] => fs.readdirSync(dataRoot, { recursive: true }).map(String).sort();

  it('removes the brain folder, the conversation database and the presence lock of its own id, and nothing else', async () => {
    const own = makeConversation(ID);
    const other = makeConversation(OTHER_ID);
    const settings = writeFile('settings.json');
    const lastConversations = writeFile('cache', 'last_conversations.json');

    await removeAntigravityConversation(ID);

    expect(fs.existsSync(own.brainFolder)).toBe(false);
    expect(fs.existsSync(own.database)).toBe(false);
    expect(fs.existsSync(own.lock)).toBe(false);
    expect(fs.existsSync(other.brainFolder)).toBe(true);
    expect(fs.existsSync(other.database)).toBe(true);
    expect(fs.existsSync(other.lock)).toBe(true);
    expect(fs.existsSync(settings)).toBe(true);
    expect(fs.existsSync(lastConversations)).toBe(true);
  });

  it('removes what a run wrote when it ended before writing the rest', async () => {
    const brainOnly = writeFile('brain', ID, '.system_generated', 'logs', 'transcript.jsonl');
    const other = makeConversation(OTHER_ID);

    await expect(removeAntigravityConversation(ID)).resolves.toBeUndefined();

    expect(fs.existsSync(path.join(dataRoot, 'brain', ID))).toBe(false);
    expect(fs.existsSync(brainOnly)).toBe(false);
    expect(fs.existsSync(other.brainFolder)).toBe(true);
  });

  // Real names a loose check would act on: a folder of that name, a 36-character
  // name that is not hex, one character short of a UUID, one over. `..` would
  // name a whole folder of conversations, an empty id the same, and the rest
  // climb out of the conversation's own folder or widen it.
  const LOOKALIKES = ['not-a-uuid', 'g'.repeat(36), ID.slice(0, 35), `${ID}0`];
  it.each([...LOOKALIKES, '', '.', '..', '../brain', `${ID}/..`, `${ID}\\..`, `../conversations/${OTHER_ID}.db`])(
    'removes nothing for the id %j, which is not a UUID, since the id becomes a path segment of a recursive delete',
    async (unsafeId) => {
      makeConversation(ID);
      makeConversation(OTHER_ID);
      for (const lookalike of LOOKALIKES) makeConversation(lookalike);
      const before = snapshot();

      await removeAntigravityConversation(unsafeId);

      expect(snapshot()).toEqual(before);
    },
  );
});

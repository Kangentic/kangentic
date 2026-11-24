/**
 * `toolResultsWrittenIn` (task #1200): a session moved to another account mid-turn restarts only
 * once its transcript holds every result of the message whose call just ended. Lines keep Claude's
 * transcript shape: one line per content block, parallel calls sharing a `message.id`, results in
 * `user` lines. Measured on Claude Code 2.1.331: a result lands 130 ms to 2.4 s after its
 * PostToolUse, so the hook alone is not the moment. Tier: Unit.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TOOL_RESULTS_FIRST_WINDOW_BYTES,
  readToolResultsWritten,
  toolResultsWrittenIn,
} from '../../src/main/agent/adapters/claude/tool-results-written';

function toolUse(messageId: string, toolUseId: string): string {
  return JSON.stringify({
    type: 'assistant',
    message: { id: messageId, role: 'assistant', content: [{ type: 'tool_use', id: toolUseId, name: 'Read', input: {} }] },
  });
}

function toolResult(toolUseId: string): string {
  return JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'ok' }] },
  });
}

const text = (messageId: string): string => JSON.stringify({
  type: 'assistant',
  message: { id: messageId, role: 'assistant', content: [{ type: 'text', text: 'Reading both files.' }] },
});

describe('toolResultsWrittenIn', () => {
  it('is true once the one call of the message has its result', () => {
    expect(toolResultsWrittenIn([text('m1'), toolUse('m1', 'toolu_a'), toolResult('toolu_a')], 'toolu_a')).toBe(true);
  });

  it('is false while the result of the call that just ended is not written yet', () => {
    expect(toolResultsWrittenIn([toolUse('m1', 'toolu_a')], 'toolu_a')).toBe(false);
  });

  it('is false between two parallel calls: the first ended, its sibling has not run', () => {
    const lines = [toolUse('m1', 'toolu_a'), toolUse('m1', 'toolu_b'), toolResult('toolu_a')];
    expect(toolResultsWrittenIn(lines, 'toolu_a')).toBe(false);
    expect(toolResultsWrittenIn([...lines, toolResult('toolu_b')], 'toolu_b')).toBe(true);
  });

  it('judges the message that made the call, never an earlier complete pair', () => {
    const lines = [toolUse('m1', 'toolu_old'), toolResult('toolu_old'), toolUse('m2', 'toolu_new')];
    expect(toolResultsWrittenIn(lines, 'toolu_new')).toBe(false);
  });

  it('is null when the window does not hold the call', () => {
    expect(toolResultsWrittenIn([toolUse('m1', 'toolu_a'), toolResult('toolu_a')], 'toolu_missing')).toBeNull();
  });

  it('skips a line cut short by an append in progress', () => {
    const cut = toolResult('toolu_b').slice(0, 30);
    expect(toolResultsWrittenIn([toolUse('m1', 'toolu_a'), toolResult('toolu_a'), cut], 'toolu_a')).toBe(true);
  });

  describe('a real transcript: five parallel calls of one message', () => {
    // Captured from Claude Code and sanitized: ids renamed, every input and output replaced. The
    // calls are written one line each under one `message.id`, and the results arrive out of order
    // (the fifth call's before the fourth's).
    const fixture = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'claude-parallel-tool-results.jsonl'), 'utf8')
      .split('\n').filter((line) => line.trim() !== '');
    const firstResultLine = fixture.findIndex((line) => line.includes('"tool_result"'));

    it('is false at every point before the last result is written', () => {
      for (let written = firstResultLine; written < fixture.length; written += 1) {
        expect(toolResultsWrittenIn(fixture.slice(0, written), 'toolu_fixture0004')).toBe(false);
      }
    });

    it('is false for the call whose result came first while a sibling is still out', () => {
      // Only the fifth call's result has landed past the first three.
      expect(toolResultsWrittenIn(fixture.slice(0, fixture.length - 1), 'toolu_fixture0012')).toBe(false);
    });

    it('is true once every result is written, asked about any of the calls', () => {
      for (const toolUseId of ['toolu_fixture0004', 'toolu_fixture0010', 'toolu_fixture0012']) {
        expect(toolResultsWrittenIn(fixture, toolUseId)).toBe(true);
      }
    });
  });

  it('reads past a short window when the call sits further back in a long file', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-tool-results-'));
    const file = path.join(folder, 'conversation.jsonl');
    try {
      // A result long enough to push the call out of the first, short read.
      const longResult = JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_a', content: 'x'.repeat(TOOL_RESULTS_FIRST_WINDOW_BYTES * 2) }] },
      });
      fs.writeFileSync(file, `${[toolUse('m1', 'toolu_a'), longResult].join('\n')}\n`);
      expect(await readToolResultsWritten(file, 'toolu_a')).toBe(true);
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });

  it('reads the tail of a real file', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-tool-results-'));
    const file = path.join(folder, 'conversation.jsonl');
    try {
      fs.writeFileSync(file, `${[toolUse('m1', 'toolu_a'), toolResult('toolu_a')].join('\n')}\n`);
      expect(await readToolResultsWritten(file, 'toolu_a')).toBe(true);
      expect(await readToolResultsWritten(path.join(folder, 'missing.jsonl'), 'toolu_a')).toBeNull();
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});

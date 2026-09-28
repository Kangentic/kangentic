/**
 * Antigravity's stream-json answer events, from lines captured on agy 1.2.11
 * (trimmed to the fields read).
 */

import { describe, it, expect } from 'vitest';
import {
  antigravityAnswerEvents,
  antigravityConversationId,
} from '../../src/main/agent/adapters/antigravity/answer-stream';

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

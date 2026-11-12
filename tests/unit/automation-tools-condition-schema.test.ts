/**
 * `kangentic_set_automations`' zod schema, captured off the real registration, lets every
 * Condition shape the handler reads reach it (#1072): `{ "text": pattern | [patterns] }`,
 * `{ "agent": sentence }`, the plain string older skills send, and null. The handler owns the
 * detailed checks so its refusals name the field and the fix; a schema that rejected the object
 * form would refuse every Text match over MCP before the handler ever saw it, in the SDK's words.
 *
 * Same fake-McpServer capture as `mcp-running-work-guard-wiring.test.ts`.
 */

import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod/v4';

vi.mock('../../src/main/agent/mcp-http/handler-helpers', () => ({
  callHandler: vi.fn(),
  runHandler: vi.fn(),
  withProject: vi.fn(),
  detectCrossProjectMention: vi.fn(() => []),
  sanitizeProjectName: vi.fn((name: string) => name),
  PROJECT_SELECTOR_DESCRIPTION: 'optional project selector',
}));

import { registerAutomationTools } from '../../src/main/agent/mcp-http/automation-tools';

function setAutomationsSchema(): z.ZodType {
  let schema: z.ZodType | null = null;
  const server = {
    registerTool: vi.fn((toolName: string, toolConfig: { inputSchema: z.ZodType }) => {
      if (toolName === 'kangentic_set_automations') schema = toolConfig.inputSchema;
    }),
  };
  registerAutomationTools(server as never, {} as never, null);
  if (schema === null) throw new Error('kangentic_set_automations was not registered');
  return schema;
}

const row = (condition: unknown) => ({
  column: 'Executing',
  automations: [{ name: 'Apply findings', type: 'send_message', on: 'turn_end', message: 'Apply them', condition }],
});

describe('kangentic_set_automations: the condition parameter', () => {
  const schema = setAutomationsSchema();

  it.each([
    ['one pattern', { text: '!Design: waiting on you' }],
    ['a list of patterns', { text: ['!Design: waiting on you', '!Design: shelved'] }],
    ['an Agent evaluation', { agent: 'The review found work' }],
    ['the plain string older skills send', 'The review found work'],
    ['null, to always run', null],
  ])('passes %s through to the handler', (_shape, condition) => {
    expect(schema.safeParse(row(condition)).success).toBe(true);
  });

  it.each([
    ['an array', ['A']],
    ['a number', 5],
    ['a boolean', true],
  ])('refuses %s as the condition', (_shape, condition) => {
    expect(schema.safeParse(row(condition)).success).toBe(false);
  });

  it('refuses a string condition of 2001 characters and takes one of 2000', () => {
    expect(schema.safeParse(row('a'.repeat(2001))).success).toBe(false);
    expect(schema.safeParse(row('a'.repeat(2000))).success).toBe(true);
  });

  it('describes itself to an agent as JSON Schema, with both kinds and the ! rule', () => {
    const jsonSchema = JSON.stringify(z.toJSONSchema(schema));
    expect(jsonSchema).toContain('{ \\"agent\\": ');
    expect(jsonSchema).toContain('a leading ! means not');
  });
});

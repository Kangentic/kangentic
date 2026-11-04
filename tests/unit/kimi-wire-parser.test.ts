/**
 * The Kimi Code wire parser (protocol 1.5). Fixtures are shaped to the CLI's
 * own `packages/agent-core-v2/docs/wire-manifest.d.ts` and `loopEventFold.ts`
 * at 2.4.1; no real capture exists yet, so these pin our reading of the source.
 * What a user loses if this breaks: the board's activity, the plan exit move,
 * and the On agent turn end automations for every Kimi task.
 */
import { describe, it, expect } from 'vitest';
import { parseWireJsonl, parseRecordTime, contentPartsText } from '../../src/main/agent/adapters/kimi/wire-parser';
import { KimiSessionHistoryParser } from '../../src/main/agent/adapters/kimi/session-history-parser';
import { HOOK_DETAIL_CAP } from '../../src/main/git/push-command';
import { Activity, AgentTool, EventType, IdleReason } from '../../src/shared/types';

const TIME = 1_792_000_000_000;

function line(type: string, payload: Record<string, unknown> = {}): string {
  return JSON.stringify({ type, agentId: 'main', ...payload, time: TIME });
}

function loop(event: Record<string, unknown>): string {
  return line('context.append_loop_event', { event });
}

function parse(...lines: string[]) {
  return parseWireJsonl(lines.join('\n') + '\n', 'append');
}

describe('parseWireJsonl: turns', () => {
  it('skips the metadata line and a malformed one', () => {
    const result = parse('{"type":"metadata","protocol_version":"1.5","created_at":1}', '{not json');
    expect(result.events).toEqual([]);
    expect(result.activity).toBeNull();
  });

  it('turns turn.prompt into a Prompt with its text, and thinking', () => {
    const result = parse(line('turn.prompt', { input: [{ type: 'text', text: 'Fix it' }], origin: 'user', turnId: 1 }));
    expect(result.activity).toBe(Activity.Thinking);
    expect(result.events).toEqual([{ ts: TIME, type: EventType.Prompt, detail: 'Fix it' }]);
  });

  it('reads turn.steer as a prompt too', () => {
    expect(parse(line('turn.steer', { input: [{ type: 'text', text: 'and this' }] })).events[0]).toMatchObject({ type: EventType.Prompt, detail: 'and this' });
  });

  it('ends a completed turn with an Idle event and forces no activity', () => {
    const result = parse(line('turn.ended', { turnId: 1, reason: 'completed' }));
    expect(result.activity).toBeNull();
    expect(result.events).toEqual([{ ts: TIME, type: EventType.Idle }]);
  });

  it('reports a cancelled turn as interrupted', () => {
    expect(parse(line('turn.ended', { reason: 'cancelled' })).events[0].type).toBe(EventType.Interrupted);
  });

  it('reports a failed turn with its error', () => {
    const result = parse(line('turn.ended', { reason: 'failed', error: { code: 'x', message: 'boom', name: 'RateLimitError', retryable: false } }));
    expect(result.events[0]).toMatchObject({ type: EventType.TurnFailed, detail: 'RateLimitError' });
  });

  it('reports a retried step as retrying, with the error name', () => {
    const result = parse(line('turn.step.retrying', { errorName: 'OverloadedError', nextAttempt: 2, maxAttempts: 3 }));
    expect(result.events[0]).toMatchObject({ type: EventType.TurnRetrying, detail: 'OverloadedError' });
  });

  it('starts thinking on a step begin, with no event', () => {
    const result = parse(loop({ type: 'step.begin', uuid: 'step-1' }));
    expect(result.activity).toBe(Activity.Thinking);
    expect(result.events).toEqual([]);
  });
});

describe('parseWireJsonl: tools', () => {
  it('reads a Bash call by its command, and any other by its name', () => {
    const result = parse(
      loop({ type: 'tool.call', stepUuid: 's', toolCallId: 'c1', name: 'Bash', args: { command: 'git push origin main' } }),
      loop({ type: 'tool.call', stepUuid: 's', toolCallId: 'c2', name: 'Read', args: { path: 'a.ts' } }),
    );
    expect(result.events).toEqual([
      { ts: TIME, type: EventType.ToolStart, tool: AgentTool.Bash, toolId: 'c1', detail: 'git push origin main' },
      { ts: TIME, type: EventType.ToolStart, tool: AgentTool.Bash, toolId: 'c2', detail: 'Read' },
    ]);
  });

  it('ends a tool ok or with an error', () => {
    const result = parse(
      loop({ type: 'tool.result', toolCallId: 'c1', result: { output: 'done' } }),
      loop({ type: 'tool.result', toolCallId: 'c2', result: { output: 'nope', isError: true } }),
    );
    expect(result.events.map((event) => event.detail)).toEqual(['ok', 'error']);
    expect(result.events.every((event) => event.type === EventType.ToolEnd)).toBe(true);
  });

  // The engine pairs an end with its start by name, so a start named Read with
  // an end named Bash would leave the tool open in the usage ledger.
  it('with a session\'s memory, names a tool on both ends across chunks and forgets it after', () => {
    const openToolNames = new Map<string, string>();
    const start = parseWireJsonl(loop({ type: 'tool.call', stepUuid: 's', toolCallId: 'c2', name: 'Read', args: { path: 'a.ts' } }), 'append', { openToolNames });
    expect(start.events[0]).toMatchObject({ type: EventType.ToolStart, tool: 'Read', toolId: 'c2' });
    const end = parseWireJsonl(loop({ type: 'tool.result', toolCallId: 'c2', result: { output: 'text' } }), 'append', { openToolNames });
    expect(end.events[0]).toMatchObject({ type: EventType.ToolEnd, tool: 'Read', toolId: 'c2' });
    expect(openToolNames.size).toBe(0);
  });

  it('with a session\'s memory, keeps a shell command a Bash call and tags an end it never saw start', () => {
    const openToolNames = new Map<string, string>();
    const shell = parseWireJsonl(loop({ type: 'tool.call', stepUuid: 's', toolCallId: 'c1', name: 'Bash', args: { command: 'git push' } }), 'append', { openToolNames });
    expect(shell.events[0]).toMatchObject({ tool: AgentTool.Bash, detail: 'git push' });
    const orphan = parseWireJsonl(loop({ type: 'tool.result', toolCallId: 'unseen', result: { output: 'text' } }), 'append', { openToolNames });
    expect(orphan.events[0].tool).toBe(AgentTool.Bash);
  });

  it('reports no background shell: the adapter does not declare backgroundCommands', () => {
    const result = parse(
      loop({ type: 'tool.result', toolCallId: 'c1', result: { output: 'task_id: bash-abc123\npid: 42\nstatus: running\n' } }),
      line('task.terminated', { info: { kind: 'process', detached: true, taskId: 'bash-abc123', status: 'completed' } }),
    );
    expect(result.events.map((event) => event.type)).toEqual([EventType.ToolEnd]);
  });
});

describe('parseWireJsonl: the plan exit', () => {
  const approved = 'Exited plan mode. Plan mode deactivated. All tools are now available.\n## Approved Plan:\nDo the thing';

  it('names the plan exit on an approved result, with the call in an earlier chunk', () => {
    const start = parse(loop({ type: 'tool.call', stepUuid: 's', toolCallId: 'p1', name: 'ExitPlanMode', args: {} }));
    expect(start.events[0]).toMatchObject({ type: EventType.ToolStart, detail: 'ExitPlanMode' });
    const end = parse(loop({ type: 'tool.result', toolCallId: 'p1', result: { output: approved } }));
    expect(end.events[0]).toMatchObject({ type: EventType.ToolEnd, tool: AgentTool.ExitPlanMode, toolId: 'p1' });
  });

  // An ExitPlanMode end means approved, so a session's memory must not put that
  // name on a rejected plan's end.
  it('with a session\'s memory, still does not call a rejected plan an exit', () => {
    const openToolNames = new Map<string, string>();
    parseWireJsonl(loop({ type: 'tool.call', stepUuid: 's', toolCallId: 'p1', name: 'ExitPlanMode', args: {} }), 'append', { openToolNames });
    const end = parseWireJsonl(loop({ type: 'tool.result', toolCallId: 'p1', result: { output: 'Plan rejected by user.', isError: true } }), 'append', { openToolNames });
    expect(end.events[0].tool).toBe(AgentTool.Bash);
  });

  it.each([
    ['rejected', 'Plan rejected by user. Plan mode remains active.', true],
    ['rejected and exited', 'Plan rejected by user. Plan mode deactivated.', true],
    ['revised', 'User requested revisions. Plan mode remains active.', false],
    ['dismissed', 'Plan approval dismissed. Plan mode remains active.', false],
  ])('does not call a %s plan an exit', (_name, output, isError) => {
    const result = parse(loop({ type: 'tool.result', toolCallId: 'p1', result: { output, isError } }));
    expect(result.events[0].tool).toBe(AgentTool.Bash);
  });

  it('holds the plan review as an approval wait', () => {
    const result = parse(line('interaction.request', { id: 'i1', kind: 'approval', toolCallId: 'p1', request: {} }));
    expect(result.activity).toBeNull();
    expect(result.events[0]).toMatchObject({ type: EventType.Idle, detail: IdleReason.Permission, waitKind: 'approval' });
  });
});

describe('parseWireJsonl: waits, subagents and compaction', () => {
  it('tells a question wait from an approval, and goes back to thinking when it resolves', () => {
    expect(parse(line('interaction.request', { kind: 'question', request: {} })).events[0]).toMatchObject({ waitKind: 'question' });
    expect(parse(line('interaction.resolved', { id: 'i1', response: {} })).activity).toBe(Activity.Thinking);
  });

  it('ignores a user_tool interaction, which waits on no person', () => {
    expect(parse(line('interaction.request', { kind: 'user_tool', request: {} })).events).toEqual([]);
  });

  it('pairs a subagent start and stop by id', () => {
    const result = parse(
      line('subagent.spawned', { subagentId: 'a1', subagentName: 'explore', parentToolCallId: 'c1', runInBackground: false }),
      line('subagent.completed', { subagentId: 'a1', resultSummary: 'ok' }),
      line('subagent.failed', { subagentId: 'a2', error: 'x' }),
      line('subagent.cancelled', { subagentId: 'a3' }),
    );
    expect(result.events[0]).toMatchObject({ type: EventType.SubagentStart, detail: 'explore', subagentId: 'a1' });
    expect(result.events.slice(1).map((event) => [event.type, event.subagentId])).toEqual([
      [EventType.SubagentStop, 'a1'],
      [EventType.SubagentStop, 'a2'],
      [EventType.SubagentStop, 'a3'],
    ]);
    // An empty detail is an inner-loop stop to the engine, which would not count it.
    expect(result.events.slice(1).every((event) => event.detail !== '')).toBe(true);
  });

  it('reports compaction', () => {
    const result = parse(line('full_compaction.begin', { source: 'auto' }));
    expect(result.activity).toBe(Activity.Thinking);
    expect(result.events[0].type).toBe(EventType.Compact);
  });
});

describe('parseWireJsonl: usage and model', () => {
  it('reports a step\'s tokens and the context from the token count', () => {
    const { usage } = parse(
      line('token_counting.measured', { length: 3, tokens: 2000 }),
      loop({ type: 'step.end', uuid: 's', usage: { inputOther: 100, output: 50, inputCacheRead: 30, inputCacheCreation: 20 } }),
    );
    expect(usage?.contextWindow).toEqual({ usedTokens: 2000, totalInputTokens: 150, totalOutputTokens: 50, cacheTokens: 50 });
  });

  it('derives the percentage only with a window from the config, never a guess', () => {
    const lines = [line('llm.request', { model: 'k3', modelAlias: 'kimi-code/k3', provider: 'p', kind: 'loop' }), line('token_counting.turn_recorded', { tokens: 1000, length: 1, turnId: 1 })];
    expect(parse(...lines).usage?.contextWindow).toEqual({ usedTokens: 1000 });
    const withWindow = parseWireJsonl(lines.join('\n'), 'append', { contextWindowForAlias: () => 4000, displayNameForAlias: () => 'K3' });
    expect(withWindow.usage?.contextWindow).toEqual({ usedTokens: 1000, contextWindowSize: 4000, usedPercentage: 25 });
    expect(withWindow.usage?.model).toEqual({ id: 'kimi-code/k3', displayName: 'K3', reportedByAgent: true });
  });

  it('falls back to the provider model id when no request named an alias', () => {
    const { usage } = parse(line('usage.record', { model: 'kimi-k3', usage: { inputOther: 1, output: 1 } }));
    expect(usage?.model).toEqual({ id: 'kimi-k3', displayName: 'kimi-k3', reportedByAgent: true });
  });

  it('reports no usage for a chunk with none, so the merge keeps what it has', () => {
    expect(parse(line('turn.ended', { reason: 'completed' })).usage).toBeNull();
  });
});

describe('KimiSessionHistoryParser.createParse: one session\'s memory', () => {
  const readCall = loop({ type: 'tool.call', stepUuid: 's', toolCallId: 'c1', name: 'Read', args: { path: 'a.ts' } });
  const readResult = loop({ type: 'tool.result', toolCallId: 'c1', result: { output: 'text' } });

  it('tags a result in a later chunk with the tool its call named', () => {
    const parseChunk = KimiSessionHistoryParser.createParse();
    expect(parseChunk(readCall + '\n', 'append').events[0]).toMatchObject({ type: EventType.ToolStart, tool: 'Read' });
    expect(parseChunk(readResult + '\n', 'append').events[0]).toMatchObject({ type: EventType.ToolEnd, tool: 'Read', toolId: 'c1' });
  });

  it('keeps one session\'s open call from another session\'s parser', () => {
    const first = KimiSessionHistoryParser.createParse();
    const second = KimiSessionHistoryParser.createParse();
    first(readCall + '\n', 'append');
    expect(second(readResult + '\n', 'append').events[0].tool).toBe(AgentTool.Bash);
  });

  it('forgets open calls when a turn ends, so a late result reads as a Bash end', () => {
    const parseChunk = KimiSessionHistoryParser.createParse();
    parseChunk(readCall + '\n', 'append');
    parseChunk(line('turn.ended', { reason: 'cancelled' }) + '\n', 'append');
    expect(parseChunk(readResult + '\n', 'append').events[0].tool).toBe(AgentTool.Bash);
  });
});

describe('parseWireJsonl: a shell command in the ToolStart detail', () => {
  const bashCall = (args: unknown) => loop({ type: 'tool.call', stepUuid: 's', toolCallId: 'c1', name: 'Bash', args });

  it.each([
    ['far over the cap', HOOK_DETAIL_CAP * 3, HOOK_DETAIL_CAP],
    ['one over the cap', HOOK_DETAIL_CAP + 1, HOOK_DETAIL_CAP],
    ['exactly the cap', HOOK_DETAIL_CAP, HOOK_DETAIL_CAP],
    ['short', 12, 12],
  ])('keeps a command %s to at most the cap', (_name, commandLength, expectedLength) => {
    const command = 'a'.repeat(commandLength - 1) + 'z';
    const detail = parse(bashCall({ command })).events[0].detail ?? '';
    expect(detail.length).toBe(expectedLength);
    // The head is kept, the tail is what the cap drops.
    expect(command.startsWith(detail.slice(0, 5))).toBe(true);
    expect(detail.endsWith('z')).toBe(commandLength <= HOOK_DETAIL_CAP);
  });

  it('reads args that arrive as a JSON string', () => {
    expect(parse(bashCall('{"command":"git push origin main"}')).events[0].detail).toBe('git push origin main');
  });

  it('falls back to the tool name when the args string is not JSON', () => {
    expect(parse(bashCall('{not json')).events[0].detail).toBe('Bash');
  });

  it('falls back to the tool name when the command is blank', () => {
    expect(parse(bashCall({ command: '   ' })).events[0].detail).toBe('Bash');
  });
});

describe('parseWireJsonl: input shapes and small records', () => {
  it('reads a file written with CRLF line ends', () => {
    const content = [line('turn.prompt', { input: [{ type: 'text', text: 'hi' }] }), line('turn.ended', { reason: 'completed' })].join('\r\n') + '\r\n';
    const result = parseWireJsonl(content, 'full');
    expect(result.events.map((event) => event.type)).toEqual([EventType.Prompt, EventType.Idle]);
    expect(result.events[0].detail).toBe('hi');
  });

  it('reports an interrupted step as a notice, with its reason', () => {
    expect(parse(line('turn.step.interrupted', { reason: 'user_cancel' })).events).toEqual([
      { ts: TIME, type: EventType.Notification, detail: 'step interrupted: user_cancel' },
    ]);
    expect(parse(line('turn.step.interrupted')).events[0].detail).toBe('step interrupted: interrupted');
  });

  it('reports plan mode on and off as notices', () => {
    expect(parse(line('plan_mode.enter')).events).toEqual([{ ts: TIME, type: EventType.Notification, detail: 'plan mode on' }]);
    expect(parse(line('plan_mode.exit')).events).toEqual([{ ts: TIME, type: EventType.Notification, detail: 'plan mode off' }]);
  });

  it('names a tool call with no name "tool", and a subagent with no name "subagent"', () => {
    expect(parse(loop({ type: 'tool.call', stepUuid: 's', toolCallId: 'c1', args: {} })).events[0].detail).toBe('tool');
    expect(parse(line('subagent.spawned', { subagentId: 'a1' })).events[0]).toMatchObject({
      type: EventType.SubagentStart,
      detail: 'subagent',
      subagentId: 'a1',
    });
  });

  it('ends a blocked turn as Idle, like a completed one', () => {
    const result = parse(line('turn.ended', { reason: 'blocked' }));
    expect(result.events).toEqual([{ ts: TIME, type: EventType.Idle }]);
    expect(result.activity).toBeNull();
  });

  it('reads an approved plan whose output starts with whitespace as the plan exit', () => {
    const output = '\n  Exited plan mode. Plan mode deactivated.\n## Approved Plan:\nDo it';
    const result = parse(loop({ type: 'tool.result', toolCallId: 'p1', result: { output } }));
    expect(result.events[0]).toMatchObject({ type: EventType.ToolEnd, tool: AgentTool.ExitPlanMode });
  });
});

describe('record helpers', () => {
  it('reads a record time in ms, and scales one in seconds', () => {
    expect(parseRecordTime(TIME)).toBe(TIME);
    expect(parseRecordTime(1_792_000_000.5)).toBe(1_792_000_000_500);
  });

  it('joins text parts and skips the rest', () => {
    expect(contentPartsText([{ type: 'think', think: 'hm' }, { type: 'text', text: 'a' }, { type: 'text', text: 'b' }])).toBe('a\nb');
    expect(contentPartsText('plain')).toBe('plain');
    expect(contentPartsText([])).toBeNull();
  });
});

/**
 * How each agent's Memory Graph answer run is invoked: the flags that keep it
 * read-only, and a prompt delivery that carries an answer-sized prompt.
 *
 * Every entry here was measured against the real CLI on 2026-09-25 (a
 * 61,584-character prompt answered from its middle row; a file write and a
 * shell command refused), except where the adapter says it comes from the CLI's
 * docs. The flags matter more than they look:
 *
 * - Five adapters passed the prompt as an argument, past the Windows
 *   command-line limit, so none of them could answer a real question there.
 * - Grok's run wrote files under a user's `always-approve` config until `--deny`
 *   rules were added.
 * - Cursor's `-p` has "access to all tools, including write and shell" until
 *   `--mode ask`.
 *
 * So each is pinned: losing one flag changes nothing visible in an answer and
 * everything about what the run may do.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const { answerSpy } = vi.hoisted(() => ({ answerSpy: vi.fn(async () => 'answered') }));

vi.mock('../../src/main/agent/shared/auto-name', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/main/agent/shared/auto-name')>();
  return { ...actual, runCliPrintAnswer: answerSpy };
});

import { ClaudeAdapter } from '../../src/main/agent/adapters/claude/claude-adapter';
import { CopilotAdapter } from '../../src/main/agent/adapters/copilot/copilot-adapter';
import { CursorAdapter } from '../../src/main/agent/adapters/cursor/cursor-adapter';
import { DroidAdapter } from '../../src/main/agent/adapters/droid/droid-adapter';
import { GrokAdapter } from '../../src/main/agent/adapters/grok/grok-adapter';
import { OpenCodeAdapter } from '../../src/main/agent/adapters/opencode/opencode-adapter';
import { CodexAdapter } from '../../src/main/agent/adapters/codex/codex-adapter';
import { GeminiAdapter } from '../../src/main/agent/adapters/gemini/gemini-adapter';
import { KimiAdapter } from '../../src/main/agent/adapters/kimi/kimi-adapter';
import {
  AntigravityAdapter,
  extractAntigravityStreamResponse,
  formatAntigravityUserMessage,
} from '../../src/main/agent/adapters/antigravity/antigravity-adapter';
import { AiderAdapter, extractAiderAnswer } from '../../src/main/agent/adapters/aider/aider-adapter';
import { GooseAdapter } from '../../src/main/agent/adapters/goose/goose-adapter';
import { OllamaAdapter } from '../../src/main/agent/adapters/ollama/ollama-adapter';
import { extractLastTurnAnswer, extractStreamedAnswer } from '../../src/main/agent/shared/auto-name';
import type { RunCliPrintOptions } from '../../src/main/agent/shared/auto-name';

/** The options the adapter handed the runner for one answer. */
async function optionsFor(
  adapter: { answerFromContext?: (prompt: string, cliPath: string, cwd: string, model?: string | null) => Promise<string> },
  model: string | null = 'some-model',
): Promise<RunCliPrintOptions> {
  answerSpy.mockClear();
  await adapter.answerFromContext?.('THE PROMPT', '/bin/agent', '/scratch', model);
  expect(answerSpy).toHaveBeenCalledTimes(1);
  return (answerSpy.mock.calls[0] as unknown as [RunCliPrintOptions])[0];
}

describe('answer run flags and prompt delivery', () => {
  beforeEach(() => answerSpy.mockClear());

  it('Copilot pipes the prompt, reads JSONL, and names its session so the run can remove it', async () => {
    const options = await optionsFor(new CopilotAdapter());
    const sessionIdIndex = options.args.indexOf('--session-id');
    expect(options.args.slice(0, 5)).toEqual(['--silent', '--output-format', 'json', '--stream', 'off']);
    expect(options.args[sessionIdIndex + 1]).toMatch(/^[0-9a-f-]{36}$/);
    expect(options.args).toContain('--no-ask-user');
    expect(options.args.slice(-2)).toEqual(['--model', 'some-model']);
    // No search offered, so no MCP config and no tool rules.
    expect(options.args).not.toContain('--additional-mcp-config');
    expect(options.promptVia ?? 'stdin').toBe('stdin');
  });

  it('Copilot searches with our server as the ONLY tool the model can see', async () => {
    // Measured on CLI 1.0.88: `--available-tools kangentic` disabled every
    // built-in (create, edit, powershell, view, web_fetch, ...) and the search
    // still ran.
    const runDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-answer-test-'));
    try {
      answerSpy.mockClear();
      const events: unknown[] = [];
      await new CopilotAdapter().answerFromContext('THE PROMPT', '/bin/copilot', '/answer-home', null, {
        retrieval: { url: 'http://127.0.0.1:1/mcp/p/answer-chat', token: 'secret' },
        onEvent: (event) => events.push(event),
        runDirectory,
      });
      const options = (answerSpy.mock.calls[0] as unknown as [RunCliPrintOptions])[0];
      const configArg = options.args[options.args.indexOf('--additional-mcp-config') + 1];
      expect(configArg).toBe(`@${path.join(runDirectory, 'copilot-answer-mcp.json')}`);
      expect(JSON.parse(fs.readFileSync(configArg.slice(1), 'utf-8'))).toEqual({
        mcpServers: { kangentic: { type: 'http', url: 'http://127.0.0.1:1/mcp/p/answer-chat', headers: { 'X-Kangentic-Token': 'secret' } } },
      });
      expect(options.args[options.args.indexOf('--available-tools') + 1]).toBe('kangentic');
      expect(options.args[options.args.indexOf('--allow-tool') + 1]).toBe('kangentic');
      expect(options.args).toContain('--disable-builtin-mcps');
      expect(options.args[options.args.indexOf('--stream') + 1]).toBe('on');
      options.onChunk?.(`${JSON.stringify({ type: 'assistant.message_delta', data: { messageId: 'm1', deltaContent: 'Hi' } })}\n`);
      expect(events).toEqual([{ kind: 'text', text: 'Hi' }]);
    } finally {
      fs.rmSync(runDirectory, { recursive: true, force: true });
    }
  });

  it('Cursor runs in ask mode, trusted, with the prompt piped to -p', async () => {
    const options = await optionsFor(new CursorAdapter());
    expect(options.args).toEqual(['--trust', '--mode', 'ask', '--output-format', 'stream-json', '--model', 'some-model', '-p']);
    expect(options.promptVia ?? 'stdin').toBe('stdin');
  });

  it('Cursor searches through a static workspace config and a permission for our one tool', async () => {
    // Measured: ask mode refused the MCP call ("User rejected MCP") until the
    // workspace's cli.json allowed exactly this tool. The url and token are
    // environment references, so neither is written to disk.
    const answerHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-answer-home-'));
    try {
      answerSpy.mockClear();
      await new CursorAdapter().answerFromContext('THE PROMPT', '/bin/cursor-agent', answerHome, null, {
        retrieval: { url: 'http://127.0.0.1:1/mcp/p/answer-chat', token: 'secret' },
        onEvent: () => undefined,
      });
      const options = (answerSpy.mock.calls[0] as unknown as [RunCliPrintOptions])[0];
      expect(options.args).toContain('--approve-mcps');
      expect(options.args).toContain('--stream-partial-output');
      expect(options.args).not.toContain('--force');
      expect(options.env).toEqual({ KANGENTIC_MCP_URL: 'http://127.0.0.1:1/mcp/p/answer-chat', KANGENTIC_MCP_TOKEN: 'secret' });
      const mcpConfig = fs.readFileSync(path.join(answerHome, '.cursor', 'mcp.json'), 'utf-8');
      expect(mcpConfig).not.toContain('secret');
      expect(JSON.parse(mcpConfig).mcpServers.kangentic).toEqual({
        url: '${env:KANGENTIC_MCP_URL}',
        headers: { 'X-Kangentic-Token': '${env:KANGENTIC_MCP_TOKEN}' },
      });
      expect(JSON.parse(fs.readFileSync(path.join(answerHome, '.cursor', 'cli.json'), 'utf-8')).permissions.allow)
        .toEqual(['Mcp(kangentic:kangentic_search)']);
    } finally {
      fs.rmSync(answerHome, { recursive: true, force: true });
    }
  });

  it('Droid pipes the prompt to exec, which is read-only by default', async () => {
    const options = await optionsFor(new DroidAdapter());
    expect(options.args).toEqual(['exec', '-o', 'text', '--model', 'some-model']);
    expect(options.promptVia ?? 'stdin').toBe('stdin');
  });

  it('Grok denies writes and shell, and reads its prompt from a file', async () => {
    const options = await optionsFor(new GrokAdapter());
    expect(options.args).toEqual([
      '--output-format', 'streaming-messages-json',
      '--deny', 'Write', '--deny', 'Edit', '--deny', 'Bash',
      '--no-subagents',
      // An answer draws on its prompt and our search, not the web or the
      // user's own cross-session memory.
      '--disable-web-search',
      '--no-memory',
      '--model', 'some-model',
    ]);
    expect(options.promptVia).toBe('file');
    expect(options.promptFileFlag).toBe('--prompt-file');
    expect(options.extractRaw).toBe(extractLastTurnAnswer);
  });

  it('Grok streams its deltas, and reaches the search tool through the environment, never a file', async () => {
    const grok = new GrokAdapter();
    expect(grok.answerCapabilities.streaming).toBe(true);
    expect(grok.answerCapabilities.search).toBe(true);
    const events: unknown[] = [];
    answerSpy.mockClear();
    // The answer home's trust entry and the static config block are the
    // adapter's own business; no retrieval here keeps this run off disk.
    await grok.answerFromContext('THE PROMPT', '/bin/grok', '/answer-home', null, {
      onEvent: (event) => events.push(event),
      runDirectory: '/run-directory',
    });
    const options = (answerSpy.mock.calls[0] as unknown as [RunCliPrintOptions])[0];
    expect(options.args).toContain('--include-partial-messages');
    // The prompt file goes in the run's own directory, never the shared home.
    expect(options.promptDirectory).toBe('/run-directory');
    expect(options.cwd).toBe('/answer-home');
    // Deltas arrive in the Anthropic Messages wire format.
    options.onChunk?.(`${JSON.stringify({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } } })}\n`);
    expect(events).toEqual([{ kind: 'text', text: 'Hello' }]);
    expect(options.env).toBeUndefined();
  });

  it('OpenCode pipes the prompt to the read-only plan agent, without -q', async () => {
    const options = await optionsFor(new OpenCodeAdapter());
    expect(options.args).toEqual(['run', '--agent', 'plan', '--format', 'json', '--pure', '--model', 'some-model']);
    expect(options.promptVia ?? 'stdin').toBe('stdin');
    expect(options.env).toBeUndefined();
  });

  it('OpenCode adds our server for the one process, through its config environment variable', async () => {
    answerSpy.mockClear();
    await new OpenCodeAdapter().answerFromContext('THE PROMPT', '/bin/opencode', '/answer-home', null, {
      retrieval: { url: 'http://127.0.0.1:1/mcp/p/answer-chat', token: 'secret' },
    });
    const options = (answerSpy.mock.calls[0] as unknown as [RunCliPrintOptions])[0];
    expect(JSON.parse(options.env?.OPENCODE_CONFIG_CONTENT ?? '{}')).toEqual({
      mcp: { kangentic: { type: 'remote', url: 'http://127.0.0.1:1/mcp/p/answer-chat', headers: { 'X-Kangentic-Token': 'secret' }, enabled: true } },
    });
  });

  it('Codex runs exec in its read-only sandbox, without the interactive approval flag', async () => {
    const options = await optionsFor(new CodexAdapter());
    expect(options.args).toEqual(['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--model', 'some-model']);
  });

  it('Gemini skips the folder-trust check the scratch directory would otherwise hit', async () => {
    const options = await optionsFor(new GeminiAdapter());
    expect(options.args).toEqual(['--skip-trust', '--output-format', 'text', '--approval-mode', 'plan', '--model', 'some-model']);
  });

  it('Kimi uses its own plan flag, not Claude\'s', async () => {
    const options = await optionsFor(new KimiAdapter());
    expect(options.args).toEqual(['--quiet', '--plan', '--model', 'some-model']);
  });

  it('Antigravity sends one stream-json message on stdin in plan mode', async () => {
    const options = await optionsFor(new AntigravityAdapter());
    expect(options.args).toEqual([
      '--mode', 'plan', '--input-format', 'stream-json', '--output-format', 'stream-json',
      '--model', 'some-model', '--print=',
    ]);
    expect(options.promptVia ?? 'stdin').toBe('stdin');
    expect(options.prompt).toBe(formatAntigravityUserMessage('THE PROMPT'));
    expect(options.extractRaw).toBe(extractAntigravityStreamResponse);
  });

  it('Aider asks without editing, from a message file, outside git', async () => {
    const options = await optionsFor(new AiderAdapter());
    expect(options.args).toEqual(expect.arrayContaining(['--chat-mode', 'ask', '--no-git', '--no-auto-commits', '--yes']));
    expect(options.args.slice(-2)).toEqual(['--model', 'some-model']);
    expect(options.promptVia).toBe('file');
    expect(options.promptFileFlag).toBe('--message-file');
  });

  it('Goose reads instructions from stdin in chat mode, which has no tools', async () => {
    const options = await optionsFor(new GooseAdapter());
    expect(options.args).toEqual(['run', '-i', '-', '--no-session', '-q', '--model', 'some-model']);
    expect(options.env).toEqual({ GOOSE_MODE: 'chat' });
  });

  it('Ollama runs the chosen model with the prompt piped, and refuses to guess one', async () => {
    const options = await optionsFor(new OllamaAdapter());
    expect(options.args).toEqual(['run', 'some-model']);
    expect(options.promptVia ?? 'stdin').toBe('stdin');

    answerSpy.mockClear();
    await expect(new OllamaAdapter().answerFromContext('THE PROMPT', '/bin/ollama', '/scratch', null))
      .rejects.toThrow(/choose a model for Ollama/);
    expect(answerSpy).not.toHaveBeenCalled();
  });

  it('omits the model flag everywhere when no model is passed', async () => {
    for (const adapter of [new CopilotAdapter(), new CursorAdapter(), new DroidAdapter(), new GrokAdapter()]) {
      const options = await optionsFor(adapter, null);
      expect(options.args).not.toContain('--model');
    }
  });

  it('passes the effort level as each CLI\'s own flag, and omits it when unset', async () => {
    // Each flag probed on the real CLI's headless path: an unknown level is
    // refused BY NAME by all three, so the flag is parsed in that mode.
    const cases = [
      { adapter: new GrokAdapter(), flag: '--reasoning-effort' },
      { adapter: new CopilotAdapter(), flag: '--reasoning-effort' },
      { adapter: new AntigravityAdapter(), flag: '--effort' },
    ];
    for (const { adapter, flag } of cases) {
      expect(adapter.answerCapabilities.effort, `${adapter.name} declares effort`).toBe(true);
      expect(adapter.answerCapabilities.defaultEffort, `${adapter.name} recommends low`).toBe('low');
      answerSpy.mockClear();
      await adapter.answerFromContext('THE PROMPT', '/bin/agent', '/scratch', null, { effort: 'low' });
      const args = (answerSpy.mock.calls[0] as unknown as [RunCliPrintOptions])[0].args;
      expect(args[args.indexOf(flag) + 1], `${adapter.name} passes the level after ${flag}`).toBe('low');
      const withoutLevel = await optionsFor(adapter, null);
      expect(withoutLevel.args, `${adapter.name} omits ${flag} when unset`).not.toContain(flag);
    }
    // Antigravity's inline empty prompt must stay the last argument.
    answerSpy.mockClear();
    await new AntigravityAdapter().answerFromContext('THE PROMPT', '/bin/agy', '/scratch', null, { effort: 'low' });
    expect((answerSpy.mock.calls[0] as unknown as [RunCliPrintOptions])[0].args.at(-1)).toBe('--print=');
  });

  it('runs Claude without extended thinking at low, and lets a higher effort think', async () => {
    // Measured on CLI 2.1.283: Sonnet at max thought for 2,500 to 6,400 tokens
    // and got a count right that low missed; Haiku ignores effort and thinks for
    // 12 to 19 s unless pinned. So low keeps the pin and anything higher lifts it.
    const claude = new ClaudeAdapter();
    expect(claude.answerCapabilities.effort).toBe(true);
    expect(claude.answerCapabilities.defaultEffort).toBe('low');

    const run = async (effort: string | null): Promise<RunCliPrintOptions> => {
      answerSpy.mockClear();
      await claude.answerFromContext('THE PROMPT', '/bin/claude', '/scratch', 'sonnet', { effort });
      return (answerSpy.mock.calls[0] as unknown as [RunCliPrintOptions])[0];
    };

    const low = await run('low');
    expect(low.args[low.args.indexOf('--effort') + 1]).toBe('low');
    expect(low.env).toEqual({ MAX_THINKING_TOKENS: '0' });

    const unset = await run(null);
    expect(unset.args).not.toContain('--effort');
    expect(unset.env).toEqual({ MAX_THINKING_TOKENS: '0' });

    const high = await run('high');
    expect(high.args[high.args.indexOf('--effort') + 1]).toBe('high');
    expect(high.env?.MAX_THINKING_TOKENS).toBeUndefined();
  });

  it('runs Claude without saving the run as a resumable session', async () => {
    // Every run used to save its transcript, whole prompt included, as a new
    // project under ~/.claude/projects keyed by its one-off directory.
    const options = await optionsFor(new ClaudeAdapter());
    expect(options.args).toContain('--no-session-persistence');
  });

  it('declares no effort where the run would not pass it on', () => {
    for (const adapter of [
      new CursorAdapter(), new DroidAdapter(), new OpenCodeAdapter(), new CodexAdapter(), new GeminiAdapter(),
      new KimiAdapter(), new AiderAdapter(), new GooseAdapter(), new OllamaAdapter(),
    ]) {
      expect(adapter.answerCapabilities.effort, adapter.name).toBe(false);
    }
  });
});

describe('answer extraction', () => {
  // A Grok run that read its prompt from a file: a narrating turn with the
  // read, the tool result, then the answer turn, and a result line that fuses
  // the two turns' text with no separator.
  const grokTranscript = [
    JSON.stringify({ type: 'system', subtype: 'init' }),
    JSON.stringify({ type: 'assistant', message: { content: [
      { type: 'text', text: 'I\'ll look up row 377 in the full table.' },
      { type: 'tool_use', name: 'read_file' },
    ] } }),
    JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: 'row 377 | MANGO-7731' }] } }),
    JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'MANGO-7731' }] } }),
    JSON.stringify({ type: 'result', result: 'I\'ll look up row 377 in the full table.MANGO-7731' }),
  ].join('\n');

  it('takes the last assistant turn for a CLI whose result fuses every turn', () => {
    expect(extractLastTurnAnswer(grokTranscript)).toBe('MANGO-7731');
    // The Claude extractor trusts the result line, which is right for Claude and
    // wrong here: it would hand the narration to the reader.
    expect(extractStreamedAnswer(grokTranscript)).toContain('look up row 377');
  });

  it('reads the response off Antigravity\'s result event, nested or flat', () => {
    const nested = [
      JSON.stringify({ event: 'init', conversation_id: 'c1' }),
      JSON.stringify({ event: 'step_update', step_update: { text_delta: 'MAN' } }),
      JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'MANGO-7731\n' } }),
    ].join('\n');
    expect(extractAntigravityStreamResponse(nested)).toBe('MANGO-7731\n');
    const flat = JSON.stringify({ event: 'result', status: 'SUCCESS', response: 'flat answer' });
    expect(extractAntigravityStreamResponse(flat)).toBe('flat answer');
    expect(extractAntigravityStreamResponse(JSON.stringify({ event: 'init' }))).toBe('');
  });

  it('keeps a multi-line prompt as one Antigravity message line', () => {
    const line = formatAntigravityUserMessage('first line\nsecond line');
    expect(line.endsWith('\n')).toBe(true);
    expect(line.trimEnd().includes('\n')).toBe(false);
    expect(JSON.parse(line).message.content[0].text).toBe('first line\nsecond line');
  });

  it('strips Aider\'s status lines around the answer', () => {
    const stdout = [
      'Aider v0.86.1',
      'Main model: gpt-5 with ask edit format',
      'Git repo: none',
      'Repo-map: disabled',
      '',
      'Two tasks changed the renderer, #561 and #573.',
      '',
      'Tokens: 12k sent, 40 received. Cost: $0.01 message, $0.01 session.',
    ].join('\n');
    expect(extractAiderAnswer(stdout)).toBe('Two tasks changed the renderer, #561 and #573.');
  });
});

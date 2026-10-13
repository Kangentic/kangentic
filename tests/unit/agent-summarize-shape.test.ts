/**
 * Verifies each agent adapter's summarize() call hits the right CLI invocation
 * (subcommand, flags, prompt delivery mode). The actual child_process.spawn is
 * stubbed via vi.mock so this test runs offline.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AgentCallUsage } from '../../src/shared/types';

const runCliPrintSummarizeMock = vi.fn(async () => 'Mocked Title');

vi.mock('../../src/main/agent/shared/auto-name', async () => {
  const actual = await vi.importActual<typeof import('../../src/main/agent/shared/auto-name')>(
    '../../src/main/agent/shared/auto-name',
  );
  return {
    ...actual,
    runCliPrintSummarize: runCliPrintSummarizeMock,
  };
});

beforeEach(() => {
  runCliPrintSummarizeMock.mockClear();
});

describe('Adapter summarize() invocation shapes', () => {
  it('Claude runs on the answer flags, with the chosen model and effort, printing JSON, via stdin', async () => {
    const { ClaudeAdapter } = await import('../../src/main/agent/adapters/claude/claude-adapter');
    const adapter = new ClaudeAdapter();
    await adapter.summarize('refactor login flow', '/usr/bin/claude', '/answer-home', { model: 'claude-haiku-5-5', effort: 'low' });
    expect(runCliPrintSummarizeMock).toHaveBeenCalledTimes(1);
    const call = runCliPrintSummarizeMock.mock.calls[0][0];
    expect(call.cliPath).toBe('/usr/bin/claude');
    expect(call.cwd).toBe('/answer-home');
    expect(call.promptVia).toBeUndefined(); // defaults to stdin
    expect(call.prompt).toContain('refactor login flow');
    // The answer run's flags: no built-in tools, no MCP servers, nothing saved
    // as a session, and the model and effort the Automation agent was set to.
    expect(call.args).toEqual(expect.arrayContaining([
      '--print', '--no-session-persistence', '--strict-mcp-config', '--model', 'claude-haiku-5-5', '--effort', 'low',
    ]));
    expect(call.args.join(' ')).toContain('--tools  --strict-mcp-config');
    expect(call.args.join(' ')).toContain('--output-format json');
    // Plan mode rerouted a Haiku request to Sonnet; it must not come back.
    expect(call.args).not.toContain('--permission-mode');
    expect(typeof call.extractRaw).toBe('function');
    expect(call.env).toEqual({ MAX_THINKING_TOKENS: '0' });
  });

  it('Claude omits the model and effort flags when none is chosen', async () => {
    const { ClaudeAdapter } = await import('../../src/main/agent/adapters/claude/claude-adapter');
    await new ClaudeAdapter().summarize('refactor login flow', '/usr/bin/claude', '/answer-home');
    const call = runCliPrintSummarizeMock.mock.calls[0][0];
    expect(call.args).not.toContain('--model');
    expect(call.args).not.toContain('--effort');
  });

  it('Claude reads the title and the call\'s usage out of the JSON result, within the title run\'s output budget', async () => {
    // The real result of a one-model call, captured on CLI 2.1.296 with the
    // answer run's flags. The title run prints the same object, so this is the
    // envelope its extractor reads: the usage goes to the caller's sink and the
    // result text comes back as the title candidate.
    const fixtureText = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'claude-print-result-condition-check.json'), 'utf-8');
    const { ClaudeAdapter } = await import('../../src/main/agent/adapters/claude/claude-adapter');
    const { SUMMARIZE_JSON_OUTPUT_BUDGET } = await import('../../src/main/agent/shared/auto-name');
    const onUsage = vi.fn();
    await new ClaudeAdapter().summarize('refactor login flow', '/usr/bin/claude', '/answer-home', { onUsage });
    const call = runCliPrintSummarizeMock.mock.calls[0][0];

    expect(call.outputBudget).toBe(SUMMARIZE_JSON_OUTPUT_BUDGET);
    expect(call.extractRaw(fixtureText)).toBe('C1: yes - The agent reply\'s final line is "Findings: applied", which matches the condition exactly.');
    expect(onUsage).toHaveBeenCalledTimes(1);
    expect(onUsage).toHaveBeenCalledWith({
      model: 'claude-haiku-5-5',
      inputTokens: 2,
      cacheCreationInputTokens: 2402,
      cacheReadInputTokens: 535,
      outputTokens: 35,
      costUsd: 0.00050345,
    } satisfies AgentCallUsage);
  });

  it('Claude writes the run\'s settings into a directory the caller owns, and leaves that directory in place', async () => {
    // A caller's run directory is the caller's to remove (the answer-run
    // directory sweep). The adapter must not delete it when the call resolves,
    // or the caller's own cleanup and any later read of it find nothing.
    const runDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'summarize-shape-run-'));
    try {
      const { ClaudeAdapter } = await import('../../src/main/agent/adapters/claude/claude-adapter');
      await new ClaudeAdapter().summarize('refactor login flow', '/usr/bin/claude', '/answer-home', { runDirectory });
      const call = runCliPrintSummarizeMock.mock.calls[0][0];
      const settingsPath: string = call.args[call.args.indexOf('--settings') + 1];

      expect(path.dirname(settingsPath)).toBe(runDirectory);
      expect(fs.existsSync(runDirectory)).toBe(true);
      expect(fs.existsSync(settingsPath)).toBe(true);
    } finally {
      fs.rmSync(runDirectory, { recursive: true, force: true });
    }
  });

  it('Claude removes the directory it made itself once the call resolves', async () => {
    // The other half of the ownership rule: with no run directory handed in, the
    // adapter makes one for the settings file and must not leave it behind.
    const { ClaudeAdapter } = await import('../../src/main/agent/adapters/claude/claude-adapter');
    await new ClaudeAdapter().summarize('refactor login flow', '/usr/bin/claude', '/answer-home');
    const call = runCliPrintSummarizeMock.mock.calls[0][0];
    const settingsPath: string = call.args[call.args.indexOf('--settings') + 1];

    expect(path.dirname(settingsPath).startsWith(os.tmpdir())).toBe(true);
    expect(fs.existsSync(path.dirname(settingsPath))).toBe(false);
  });

  // Each adapter takes the model the way its own answerFromContext already does,
  // the trust flag that run needs in the answer home, a folder it never saw,
  // and those of the answer run's read-only and no-session flags that leave its
  // mode alone. A mode change waits for a title measured in that mode.
  const GROK_DENY = ['--deny', 'Write', '--deny', 'Edit', '--deny', 'Bash', '--no-subagents', '--disable-web-search', '--no-memory'];
  type Summarizer = { summarize: (prompt: string, cliPath: string, cwd: string, options?: { model?: string | null; effort?: string | null }) => Promise<string> };
  const summarizers: Array<[string, () => Promise<Summarizer>, string[]]> = [
    ['codex', async () => new (await import('../../src/main/agent/adapters/codex/codex-adapter')).CodexAdapter(), ['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral', '--model', 'm1']],
    ['kimi', async () => new (await import('../../src/main/agent/adapters/kimi/kimi-adapter')).KimiAdapter(), ['--print', '--quiet', '--model', 'm1']],
    ['qwen', async () => new (await import('../../src/main/agent/adapters/qwen-code/qwen-adapter')).QwenAdapter(), ['--output-format', 'text', '--chat-recording=false', '--model', 'm1']],
    ['droid', async () => new (await import('../../src/main/agent/adapters/droid/droid-adapter')).DroidAdapter(), ['exec', '-o', 'text', '--model', 'm1']],
    ['cursor', async () => new (await import('../../src/main/agent/adapters/cursor/cursor-adapter')).CursorAdapter(), ['--trust', '--output-format', 'text', '--model', 'm1', '-p']],
    ['grok', async () => new (await import('../../src/main/agent/adapters/grok/grok-adapter')).GrokAdapter(), ['--output-format', 'plain', ...GROK_DENY, '--model', 'm1', '--reasoning-effort', 'low', '-p']],
  ];
  it.each(summarizers)('%s passes the chosen model as its answer run does', async (_name, create, expectedArgs) => {
    const adapter = await create();
    await adapter.summarize('a description', '/usr/bin/agent', '/answer-home', { model: 'm1', effort: 'low' });
    const call = runCliPrintSummarizeMock.mock.calls[0][0];
    expect(call.args).toEqual(expectedArgs);
    expect(call.cwd).toBe('/answer-home');
  });

  it('Kimi uses --print --quiet via stdin', async () => {
    const { KimiAdapter } = await import('../../src/main/agent/adapters/kimi/kimi-adapter');
    const adapter = new KimiAdapter();
    await adapter.summarize('add docstrings', '/usr/bin/kimi', '/cwd');
    const call = runCliPrintSummarizeMock.mock.calls[0][0];
    expect(call.args).toEqual(['--print', '--quiet']);
    expect(call.promptVia).toBeUndefined();
  });

  it('Codex uses exec --skip-git-repo-check, read-only and kept out of its sessions, via stdin', async () => {
    const { CodexAdapter } = await import('../../src/main/agent/adapters/codex/codex-adapter');
    const adapter = new CodexAdapter();
    await adapter.summarize('debug flaky test', '/usr/bin/codex', '/cwd');
    const call = runCliPrintSummarizeMock.mock.calls[0][0];
    expect(call.args).toEqual(['exec', '--skip-git-repo-check', '--sandbox', 'read-only', '--ephemeral']);
    expect(call.promptVia).toBeUndefined();
  });

  it('Qwen uses --output-format text with no chat saved, via stdin', async () => {
    const { QwenAdapter } = await import('../../src/main/agent/adapters/qwen-code/qwen-adapter');
    const adapter = new QwenAdapter();
    await adapter.summarize('explain bug', '/usr/bin/qwen', '/cwd');
    const call = runCliPrintSummarizeMock.mock.calls[0][0];
    expect(call.args).toEqual(['--output-format', 'text', '--chat-recording=false']);
    expect(call.promptVia).toBeUndefined();
  });

  it('Cursor trusts the folder and uses --output-format text -p via positional arg', async () => {
    const { CursorAdapter } = await import('../../src/main/agent/adapters/cursor/cursor-adapter');
    const adapter = new CursorAdapter();
    await adapter.summarize('audit security', '/usr/bin/agent', '/cwd');
    const call = runCliPrintSummarizeMock.mock.calls[0][0];
    expect(call.args).toEqual(['--trust', '--output-format', 'text', '-p']);
    expect(call.promptVia).toBe('arg');
  });

  it('Droid uses exec -o text via positional arg', async () => {
    const { DroidAdapter } = await import('../../src/main/agent/adapters/droid/droid-adapter');
    const adapter = new DroidAdapter();
    await adapter.summarize('improve perf', '/usr/bin/droid', '/cwd');
    const call = runCliPrintSummarizeMock.mock.calls[0][0];
    expect(call.args).toEqual(['exec', '-o', 'text']);
    expect(call.promptVia).toBe('arg');
  });

  it('Grok uses --output-format plain with the answer run\'s deny rules, -p via positional arg', async () => {
    const { GrokAdapter } = await import('../../src/main/agent/adapters/grok/grok-adapter');
    const adapter = new GrokAdapter();
    await adapter.summarize('triage crash report', '/usr/bin/grok', '/cwd');
    const call = runCliPrintSummarizeMock.mock.calls[0][0];
    expect(call.args).toEqual(['--output-format', 'plain', ...GROK_DENY, '-p']);
    expect(call.promptVia).toBe('arg');
  });

  it('all adapters with summarize wrap the prompt via buildSummarizePrompt', async () => {
    // Pick one to spot-check: the wrapped prompt should contain the system prefix.
    const { CodexAdapter } = await import('../../src/main/agent/adapters/codex/codex-adapter');
    const adapter = new CodexAdapter();
    await adapter.summarize('user description text', '/usr/bin/codex', '/cwd');
    const call = runCliPrintSummarizeMock.mock.calls[0][0];
    expect(call.prompt).toContain('Summarize the following');
    expect(call.prompt).toContain('user description text');
  });
});

// Three agents title on their own answer run, which carries their read-only
// flags and removes the session it leaves (pinned in answer-run-delivery.test.ts).
// Each was measured turning the title prompt into a clean title on it, on
// 2026-10-13: Gemini in 3.6 s, OpenCode in 7.1 s, Copilot in 8.0 s.
describe('Adapters that title on their answer run', () => {
  type AnswerRunSummarizer = {
    summarize: (prompt: string, cliPath: string, cwd: string, options?: { model?: string | null; effort?: string | null; runDirectory?: string; onUsage?: () => void }) => Promise<string>;
    answerFromContext: (...args: unknown[]) => Promise<string>;
  };
  const answerRunSummarizers: Array<[string, () => Promise<AnswerRunSummarizer>, boolean]> = [
    ['gemini', async () => new (await import('../../src/main/agent/adapters/gemini/gemini-adapter')).GeminiAdapter(), false],
    ['copilot', async () => new (await import('../../src/main/agent/adapters/copilot/copilot-adapter')).CopilotAdapter(), true],
    ['opencode', async () => new (await import('../../src/main/agent/adapters/opencode/opencode-adapter')).OpenCodeAdapter(), false],
  ];

  it.each(answerRunSummarizers)('%s hands the wrapped prompt, model, run directory and usage sink to answerFromContext', async (_name, create, takesEffort) => {
    const adapter = await create();
    const answer = vi.spyOn(adapter, 'answerFromContext').mockResolvedValue('  "Fix the Login Timeout."  ');
    const onUsage = vi.fn();
    const title = await adapter.summarize('fix the login timeout', '/usr/bin/agent', '/answer-home', { model: 'm1', effort: 'low', runDirectory: '/run', onUsage });
    expect(title).toBe('Fix the Login Timeout');
    expect(runCliPrintSummarizeMock).not.toHaveBeenCalled();
    const [prompt, cliPath, cwd, model, options] = answer.mock.calls[0] as [string, string, string, string, Record<string, unknown>];
    expect(prompt).toContain('Summarize the following');
    expect(prompt).toContain('fix the login timeout');
    expect([cliPath, cwd, model]).toEqual(['/usr/bin/agent', '/answer-home', 'm1']);
    expect(options.runDirectory).toBe('/run');
    expect(options.onUsage).toBe(onUsage);
    expect(options.effort).toBe(takesEffort ? 'low' : undefined);
    // Neither streaming nor search: a title is one line from what it was handed.
    expect(options.onEvent).toBeUndefined();
    expect(options.retrieval).toBeUndefined();
  });

  it.each(answerRunSummarizers)('%s throws when its answer leaves nothing title-shaped', async (_name, create) => {
    const adapter = await create();
    vi.spyOn(adapter, 'answerFromContext').mockResolvedValue('```\nno title text here\n```');
    await expect(adapter.summarize('fix the login timeout', '/usr/bin/agent', '/answer-home')).rejects.toThrow('the agent produced empty output');
  });
});

describe('Adapters without summarize support', () => {
  it('Aider does not implement summarize', async () => {
    const { AiderAdapter } = await import('../../src/main/agent/adapters/aider/aider-adapter');
    const adapter = new AiderAdapter();
    expect((adapter as { summarize?: unknown }).summarize).toBeUndefined();
  });

  it('Warp does not implement summarize', async () => {
    const { WarpAdapter } = await import('../../src/main/agent/adapters/warp/warp-adapter');
    const adapter = new WarpAdapter();
    expect((adapter as { summarize?: unknown }).summarize).toBeUndefined();
  });
});

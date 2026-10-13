/**
 * Verifies each agent adapter's summarize() call hits the right CLI invocation
 * (subcommand, flags, prompt delivery mode). The actual child_process.spawn is
 * stubbed via vi.mock so this test runs offline.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

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

  // Each adapter takes the model the way its own answerFromContext already does,
  // and the trust flag that run needs in the answer home, a folder it never saw.
  type Summarizer = { summarize: (prompt: string, cliPath: string, cwd: string, options?: { model?: string | null; effort?: string | null }) => Promise<string> };
  const summarizers: Array<[string, () => Promise<Summarizer>, string[]]> = [
    ['codex', async () => new (await import('../../src/main/agent/adapters/codex/codex-adapter')).CodexAdapter(), ['exec', '--skip-git-repo-check', '--model', 'm1']],
    ['kimi', async () => new (await import('../../src/main/agent/adapters/kimi/kimi-adapter')).KimiAdapter(), ['--print', '--quiet', '--model', 'm1']],
    ['qwen', async () => new (await import('../../src/main/agent/adapters/qwen-code/qwen-adapter')).QwenAdapter(), ['--output-format', 'text', '--model', 'm1']],
    ['opencode', async () => new (await import('../../src/main/agent/adapters/opencode/opencode-adapter')).OpenCodeAdapter(), ['run', '--model', 'm1']],
    ['droid', async () => new (await import('../../src/main/agent/adapters/droid/droid-adapter')).DroidAdapter(), ['exec', '-o', 'text', '--model', 'm1']],
    ['gemini', async () => new (await import('../../src/main/agent/adapters/gemini/gemini-adapter')).GeminiAdapter(), ['--skip-trust', '--output-format', 'text', '--model', 'm1']],
    ['cursor', async () => new (await import('../../src/main/agent/adapters/cursor/cursor-adapter')).CursorAdapter(), ['--trust', '--output-format', 'text', '--model', 'm1', '-p']],
    ['grok', async () => new (await import('../../src/main/agent/adapters/grok/grok-adapter')).GrokAdapter(), ['--output-format', 'plain', '--model', 'm1', '--reasoning-effort', 'low', '-p']],
    ['copilot', async () => new (await import('../../src/main/agent/adapters/copilot/copilot-adapter')).CopilotAdapter(), ['--silent', '--model', 'm1', '--reasoning-effort', 'low', '-p']],
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

  it('Codex uses exec --skip-git-repo-check via stdin', async () => {
    const { CodexAdapter } = await import('../../src/main/agent/adapters/codex/codex-adapter');
    const adapter = new CodexAdapter();
    await adapter.summarize('debug flaky test', '/usr/bin/codex', '/cwd');
    const call = runCliPrintSummarizeMock.mock.calls[0][0];
    expect(call.args).toEqual(['exec', '--skip-git-repo-check']);
    expect(call.promptVia).toBeUndefined();
  });

  it('Gemini skips the folder-trust check and asks for text via stdin', async () => {
    const { GeminiAdapter } = await import('../../src/main/agent/adapters/gemini/gemini-adapter');
    const adapter = new GeminiAdapter();
    await adapter.summarize('summarize architecture', '/usr/bin/gemini', '/cwd');
    const call = runCliPrintSummarizeMock.mock.calls[0][0];
    expect(call.args).toEqual(['--skip-trust', '--output-format', 'text']);
    expect(call.promptVia).toBeUndefined();
  });

  it('Qwen uses --output-format text via stdin', async () => {
    const { QwenAdapter } = await import('../../src/main/agent/adapters/qwen-code/qwen-adapter');
    const adapter = new QwenAdapter();
    await adapter.summarize('explain bug', '/usr/bin/qwen', '/cwd');
    const call = runCliPrintSummarizeMock.mock.calls[0][0];
    expect(call.args).toEqual(['--output-format', 'text']);
    expect(call.promptVia).toBeUndefined();
  });

  it('OpenCode uses run via stdin, without -q, which printed nothing', async () => {
    const { OpenCodeAdapter } = await import('../../src/main/agent/adapters/opencode/opencode-adapter');
    const adapter = new OpenCodeAdapter();
    await adapter.summarize('rename variable', '/usr/bin/opencode', '/cwd');
    const call = runCliPrintSummarizeMock.mock.calls[0][0];
    expect(call.args).toEqual(['run']);
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

  it('Grok uses --output-format plain -p via positional arg', async () => {
    const { GrokAdapter } = await import('../../src/main/agent/adapters/grok/grok-adapter');
    const adapter = new GrokAdapter();
    await adapter.summarize('triage crash report', '/usr/bin/grok', '/cwd');
    const call = runCliPrintSummarizeMock.mock.calls[0][0];
    expect(call.args).toEqual(['--output-format', 'plain', '-p']);
    expect(call.promptVia).toBe('arg');
  });

  it('Copilot uses --silent -p via positional arg', async () => {
    const { CopilotAdapter } = await import('../../src/main/agent/adapters/copilot/copilot-adapter');
    const adapter = new CopilotAdapter();
    await adapter.summarize('write commit message', '/usr/bin/copilot', '/cwd');
    const call = runCliPrintSummarizeMock.mock.calls[0][0];
    expect(call.args).toEqual(['--silent', '-p']);
    expect(call.promptVia).toBe('arg');
  });

  it('all adapters with summarize wrap the prompt via buildSummarizePrompt', async () => {
    // Pick one to spot-check: the wrapped prompt should contain the system prefix.
    const { GeminiAdapter } = await import('../../src/main/agent/adapters/gemini/gemini-adapter');
    const adapter = new GeminiAdapter();
    await adapter.summarize('user description text', '/usr/bin/gemini', '/cwd');
    const call = runCliPrintSummarizeMock.mock.calls[0][0];
    expect(call.prompt).toContain('Summarize the following');
    expect(call.prompt).toContain('user description text');
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

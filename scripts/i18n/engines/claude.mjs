/**
 * The Claude engine: headless `claude -p`, the first-pass translator and the
 * bake-off's judge.
 *
 * Headless Claude Code rather than the Anthropic API, because it runs on the
 * developer's existing Claude Code login with no API key and no SDK dependency,
 * and it validates the reply against a JSON Schema itself (`--json-schema`).
 * `--bare` is out for the same reason: it reads only `ANTHROPIC_API_KEY`.
 *
 * The flags are the Claude adapter's `answerArgs` for a one-shot answer with no
 * tools (src/main/agent/adapters/claude/claude-adapter.ts), the same set
 * scripts/eval-condition-check.mjs runs. `--system-prompt` replaces Claude
 * Code's coding-agent prompt with the translator's. Each call runs from an empty
 * temp folder, so no project CLAUDE.md loads, with the `CLAUDE*` variables of a
 * surrounding Claude Code session removed.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readReplies, REPLY_SCHEMA, systemPrompt, userPrompt } from '../prompt.mjs';

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';
export const DEFAULT_CLAUDE_EFFORT = 'medium';
/** What the Claude adapter's `writeAnswerSettings` writes for every answer call. */
const ANSWER_SETTINGS = { advisorModel: '', autoMemoryEnabled: false };
const RUN_TIMEOUT_MS = 10 * 60_000;

export function claudeArgs({ settingsPath, model, effort, system, schema }) {
  return [
    '--print',
    '--no-session-persistence',
    '--permission-prompts', 'none',
    '--tools', '',
    '--strict-mcp-config',
    '--settings', settingsPath,
    '--output-format', 'json',
    '--model', model,
    '--effort', effort,
    '--system-prompt', system,
    '--json-schema', JSON.stringify(schema),
  ];
}

/** This shell's env minus Claude session markers, with thinking off at low as the adapter's `answerEnv` does. */
export function claudeEnv(baseEnv, effort) {
  const env = { ...baseEnv };
  for (const name of Object.keys(env)) if (name.startsWith('CLAUDE')) delete env[name];
  delete env.MAX_THINKING_TOKENS;
  if (effort === 'low') env.MAX_THINKING_TOKENS = '0';
  return env;
}

/**
 * Throws when the CLI cannot start. Without a shell a bare name reaches only a
 * real executable on PATH: on Windows an npm install puts only the `claude.cmd`
 * shim there, so pass `--cli` with the path to the real executable.
 */
export function assertCliStarts(cli) {
  try {
    execFileSync(cli, ['--version'], { stdio: 'ignore', windowsHide: true, timeout: 30_000 });
  } catch (error) {
    throw new Error(`Cannot start the Claude CLI "${cli}" (${error instanceof Error ? error.message : String(error)}). Pass --cli <path to the claude executable>.`);
  }
}

/** A temp folder removal that never throws: on Windows a CLI's leftover child can still hold it. */
function removeDirectory(directory) {
  try {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    // Left in the temp folder; the OS clears it.
  }
}

/** Stop the CLI and anything it started. On Windows `child.kill()` ends only the CLI. */
function stopTree(child) {
  if (process.platform !== 'win32') {
    child.kill();
    return;
  }
  try {
    execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    // Already gone.
  }
}

/** One call from an empty temp folder. Never rejects: a CLI that cannot start resolves with code -1. */
function runOnce(cli, argv, stdinText, env) {
  return new Promise((resolve) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-i18n-claude-'));
    const started = performance.now();
    let child;
    try {
      child = spawn(cli, argv, { cwd, env, shell: false, windowsHide: true });
    } catch (error) {
      removeDirectory(cwd);
      resolve({ code: -1, stdout: '', stderr: error instanceof Error ? error.message : String(error), wallMs: 0 });
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const settle = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      removeDirectory(cwd);
      resolve({ code, stdout, stderr: stderr.slice(-2000), wallMs: performance.now() - started });
    };
    const timer = setTimeout(() => stopTree(child), RUN_TIMEOUT_MS);
    child.on('error', (error) => {
      stderr += `${error.message}\n`;
      settle(-1);
    });
    child.stdin.on('error', () => {});
    child.stdout.on('data', (chunk) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
    child.on('close', (code) => settle(code));
    child.stdin.end(stdinText);
  });
}

/** What one `--output-format json` call returned: the structured reply when a schema was given. */
export function readJsonResult(stdout) {
  const lines = String(stdout).trim().split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const record = JSON.parse(lines[index]);
      if (record && record.type === 'result') {
        const usage = record.usage ?? {};
        const count = (value) => (typeof value === 'number' ? value : 0);
        return {
          answer: typeof record.result === 'string' ? record.result : null,
          structured: record.structured_output ?? null,
          costUsd: typeof record.total_cost_usd === 'number' ? record.total_cost_usd : 0,
          durationMs: typeof record.duration_ms === 'number' ? record.duration_ms : 0,
          isError: record.is_error === true,
          inputTokens: count(usage.input_tokens) + count(usage.cache_creation_input_tokens) + count(usage.cache_read_input_tokens),
          outputTokens: count(usage.output_tokens),
        };
      }
    } catch {
      // Not the result line.
    }
  }
  return { answer: null, structured: null, costUsd: 0, durationMs: 0, isError: true, inputTokens: 0, outputTokens: 0 };
}

/**
 * A Claude caller for one model and effort: `ask({ system, user, schema })`
 * resolves the parsed JSON reply and the call's usage, and throws on a failed
 * call. `close()` removes the settings folder.
 */
export function createClaudeCaller({ cli = 'claude', model = DEFAULT_CLAUDE_MODEL, effort = DEFAULT_CLAUDE_EFFORT } = {}) {
  assertCliStarts(cli);
  const settingsDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-i18n-settings-'));
  const settingsPath = path.join(settingsDirectory, 'settings.json');
  fs.writeFileSync(settingsPath, JSON.stringify(ANSWER_SETTINGS));
  return {
    model,
    async ask({ system, user, schema }) {
      const outcome = await runOnce(cli, claudeArgs({ settingsPath, model, effort, system, schema }), user, claudeEnv(process.env, effort));
      const result = readJsonResult(outcome.stdout);
      if (outcome.code !== 0 || result.isError) {
        throw new Error(`claude exited ${outcome.code}: ${(result.answer ?? outcome.stderr).slice(-400)}`);
      }
      const reply = result.structured ?? JSON.parse(result.answer ?? '');
      return {
        reply,
        usage: { inputTokens: result.inputTokens, outputTokens: result.outputTokens, costUsd: result.costUsd, durationMs: result.durationMs || outcome.wallMs },
      };
    },
    close() {
      removeDirectory(settingsDirectory);
    },
  };
}

/** The translation engine over a Claude caller. */
export function createClaudeEngine(options = {}) {
  const caller = createClaudeCaller(options);
  return {
    name: `claude:${caller.model}`,
    async translateBatch({ locale, items }) {
      const { reply, usage } = await caller.ask({ system: systemPrompt(locale), user: userPrompt(items), schema: REPLY_SCHEMA });
      return { replies: readReplies(reply), usage };
    },
    close: () => caller.close(),
  };
}

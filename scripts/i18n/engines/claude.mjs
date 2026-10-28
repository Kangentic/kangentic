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
 * temp folder, so no project CLAUDE.md loads, with the markers of a surrounding
 * Claude Code session removed.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { removeDirectory, runOnce } from '../../lib/headless-cli.mjs';
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

/**
 * This shell's env minus the markers a Claude Code session sets for itself
 * (`CLAUDECODE`, `CLAUDE_CODE_*`, which the app's spawn env drops too), with
 * thinking off at low as the adapter's `answerEnv` does. `CLAUDE_CONFIG_DIR`
 * stays, since it says where the developer's login lives.
 */
export function claudeEnv(baseEnv, effort) {
  const env = { ...baseEnv };
  for (const name of Object.keys(env)) if (name === 'CLAUDECODE' || name.startsWith('CLAUDE_CODE_')) delete env[name];
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
      const outcome = await runOnce(cli, claudeArgs({ settingsPath, model, effort, system, schema }), user, claudeEnv(process.env, effort), {
        tempPrefix: 'kangentic-i18n-claude-',
        timeoutMs: RUN_TIMEOUT_MS,
      });
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

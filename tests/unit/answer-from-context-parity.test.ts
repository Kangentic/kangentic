/**
 * Every agent that can auto-name a task can also answer a question from the
 * index.
 *
 * Ask shipped with `answerFromContext` on Claude alone, so the Answering agent
 * dropdown had exactly one entry on a machine with eleven agents installed. The
 * filter was right - an agent that cannot answer must not be offered - but the
 * gap was invisible: nothing said "the others are capable, nobody wrote the
 * method".
 *
 * `summarize` is the honest proxy for "this CLI has a working headless mode we
 * have already proven". Answering is that same spawn with different budgets, so
 * any adapter with one and not the other is an oversight rather than a
 * limitation - which is exactly what this pins.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ADAPTERS_DIR = path.join(__dirname, '..', '..', 'src', 'main', 'agent', 'adapters');

/** Every `*-adapter.ts`, plus the runner files a couple of adapters split out. */
function adapterSources(): Array<{ agent: string; file: string; source: string }> {
  const entries: Array<{ agent: string; file: string; source: string }> = [];
  for (const agentDir of fs.readdirSync(ADAPTERS_DIR)) {
    const dir = path.join(ADAPTERS_DIR, agentDir);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith('.ts')) continue;
      entries.push({
        agent: agentDir,
        file: path.join(agentDir, file),
        source: fs.readFileSync(path.join(dir, file), 'utf-8'),
      });
    }
  }
  return entries;
}

/** Agents whose adapter declares a method, by scanning for its definition. */
function agentsDeclaring(method: string): Set<string> {
  const found = new Set<string>();
  for (const entry of adapterSources()) {
    if (new RegExp(`\\basync ${method}\\s*\\(`).test(entry.source)) found.add(entry.agent);
  }
  return found;
}

/**
 * Agents that genuinely CANNOT answer, with the measurement that says so.
 *
 * This is not a todo list. An entry here is a limitation of that CLI, and it
 * has to stay short and justified or the parity check above becomes a
 * formality.
 */
const CANNOT_ANSWER: Record<string, string> = {
  // Antigravity used to sit here: its PTY print runner passes the prompt as
  // one argv entry. Its answer run now sends the prompt on stdin as one
  // stream-json message instead, so it answers.
  //
  // Warp has no `summarize`, so the parity scan never asks about it. It is
  // named here anyway so the gap is a decision rather than an absence: its
  // adapter drives `oz agent run`, which carries out a task rather than
  // answering read-only, and Warp's docs retire `oz` in favour of the `warp`
  // binary, which documents no one-shot run at all.
  warp: 'no documented read-only headless run (oz agent run acts; warp has no one-shot mode)',
};

describe('answerFromContext parity', () => {
  it('is implemented by every agent that implements summarize', () => {
    const summarizers = agentsDeclaring('summarize');
    const answerers = agentsDeclaring('answerFromContext');

    // Guards the guard: if the scan stops finding summarize the test would pass
    // vacuously, which is how a parity check quietly stops checking.
    expect(summarizers.size).toBeGreaterThanOrEqual(10);

    const missing = [...summarizers]
      .filter((agent) => !answerers.has(agent) && !(agent in CANNOT_ANSWER))
      .sort();
    expect(
      missing,
      `These agents can auto-name but cannot answer, so the Memory Graph's\n`
      + `Answering agent dropdown will not list them:\n`
      + missing.map((agent) => `  - ${agent}`).join('\n')
      + `\n\nAdd answerFromContext beside summarize, using that CLI's read-only\n`
      + `mode and its own model flag.`,
    ).toEqual([]);
  });

  it('keeps the cannot-answer list honest', () => {
    // An entry that has since been implemented is a stale claim about a CLI's
    // limits, which is worse than no list at all.
    const answerers = agentsDeclaring('answerFromContext');
    const stale = Object.keys(CANNOT_ANSWER).filter((agent) => answerers.has(agent));
    expect(stale, 'These agents CAN answer now - drop them from CANNOT_ANSWER').toEqual([]);
  });

  it('takes the model as its fourth parameter everywhere', () => {
    // The signature is what lets the Search tab pick a cheaper model. An
    // adapter that ignores it silently answers at the CLI default, and the
    // setting appears to do nothing.
    const offenders: string[] = [];
    for (const entry of adapterSources()) {
      const match = entry.source.match(/async answerFromContext\(([\s\S]*?)\): Promise<string>/);
      if (!match) continue;
      if (!/model\?:\s*string \| null/.test(match[1])) offenders.push(entry.file);
    }
    expect(offenders, `answerFromContext must accept \`model?: string | null\``).toEqual([]);
  });

  it('never passes the answer prompt on the command line', () => {
    // An answer prompt runs to about 50k characters. Windows caps a command
    // line at 32,767, and 8,191 through cmd.exe, so a prompt passed as an
    // argument cannot answer a real question there. Five adapters shipped that
    // way; the probe that qualified them used a one-line prompt and missed it.
    // Stdin, or a prompt file for a CLI that reads one, carries any size.
    const offenders: string[] = [];
    for (const entry of adapterSources()) {
      const method = entry.source.match(/async answerFromContext\([\s\S]*?\n  \}/)?.[0];
      if (method && /promptVia:\s*'arg'/.test(method)) offenders.push(entry.file);
    }
    expect(offenders, 'answerFromContext must deliver the prompt on stdin or through a file').toEqual([]);
  });

  it('declares answerCapabilities beside every answerFromContext', () => {
    // What the run can do beyond the base (streaming, search, a model) is read
    // generically by the handler and by Settings > Search. An adapter that
    // answers without declaring it would read as "takes no model", and the
    // Answering model row would stop being required for it.
    const answerers = agentsDeclaring('answerFromContext');
    const declared = new Set<string>();
    for (const entry of adapterSources()) {
      if (/readonly answerCapabilities\s*=/.test(entry.source)) declared.add(entry.agent);
    }
    const missing = [...answerers].filter((agent) => !declared.has(agent)).sort();
    expect(missing, 'Declare `readonly answerCapabilities = { streaming, search, model, effort }`').toEqual([]);
  });

  it('asks Claude with no built-in tools, one scoped MCP server, and a stream', () => {
    // MEASURED, and it dwarfed everything else on this surface. A ten-token
    // prompt through this call carried ~52,000 tokens of context, because the
    // CLI loads its built-in tool definitions and every MCP server the user
    // has configured. Ask uses neither: the prompt is self-contained and the
    // rules tell the agent to answer only from what is in it.
    //
    //   as it was                        ~52,000
    //   with these two flags             ~26,800
    //   and from a neutral cwd            ~8,000
    //
    // Losing either flag restores the cost silently - nothing in an answer
    // would look different, and only a token measurement would ever notice.
    const claude = adapterSources().find((entry) => entry.file.includes('claude-adapter'));
    expect(claude, 'the Claude adapter must exist for this to mean anything').toBeTruthy();
    const method = claude?.source.match(/async answerFromContext\([\s\S]*?\n  \}/)?.[0] ?? '';
    // The flags live in one function both answer paths build from, the fresh
    // run and the warm session, so the two cannot drift apart.
    // Through its `return [`: the parameter type closes with a column-0 brace too.
    const flags = claude?.source.match(/function answerArgs\([\s\S]*?return \[[\s\S]*?\n\}/)?.[0] ?? '';
    const session = claude?.source.match(/openAnswerSession\(input[\s\S]*?\n  \}/)?.[0] ?? '';
    const environment = claude?.source.match(/function answerEnv\([\s\S]*?\n\}/)?.[0] ?? '';

    expect(method, 'answerFromContext must be found for this check to bite').toContain('runCliPrintAnswer');
    expect(method, 'the fresh run builds from the shared flags').toContain('answerArgs(');
    expect(session, 'the warm session builds from the shared flags').toContain('answerArgs(');
    expect(session, 'the warm session reads its turns as stream-json').toMatch(/'--input-format',\s*'stream-json'/);
    expect(flags, 'built-in tools must be switched off').toMatch(/'--tools',\s*''/);
    expect(flags, 'the config file must be the WHOLE server list').toContain('--strict-mcp-config');
    // An answer is not a session to resume: saved, every run left its whole
    // prompt under ~/.claude/projects as a project of its own.
    expect(flags, 'answer runs must not be saved as sessions').toContain('--no-session-persistence');

    // NOT plan mode. It rode along as a "redundant second lock" until it was
    // measured on CLI 2.1.260: `--permission-mode plan` with `--model haiku`
    // answered from claude-sonnet-5 (message_start.model) at ~3x the notional
    // cost and with ~10k more tokens of system prompt, and the identical call
    // without it answered from haiku. The Answering model setting was silently
    // doing nothing. The read-only guarantee is the empty tool list plus the
    // allowlist; prompts are switched off so a headless run can neither block
    // on one nor be granted anything by one.
    expect(flags, 'plan mode reroutes the model').not.toMatch(/'--permission-mode',\s*'plan'/);
    expect(flags, 'nothing may prompt, or be granted by a prompt').toMatch(/'--permission-prompts',\s*'none'/);

    // The ONE tool it may reach: Kangentic's own conversation search, handed
    // over by a scoped config and pre-approved on the allowlist so a headless
    // run never blocks on a permission prompt it cannot answer. Strict mode
    // above is what keeps the user's own servers out of that file.
    expect(flags, 'the scoped server config must be named').toContain('--mcp-config');
    expect(flags, 'the search tool must be pre-approved').toMatch(/'--allowedTools',\s*ANSWER_RETRIEVAL_TOOL/);
    expect(claude?.source).toMatch(/ANSWER_RETRIEVAL_TOOL = 'mcp__kangentic__kangentic_search'/);
    // That file carries a live token and must not outlive the call. It lives in
    // the call's own config directory, which goes whole.
    expect(method, 'the call\'s config directory must be deleted when the call ends').toMatch(
      /finally[\s\S]*rmSync\(configDirectory,\s*\{\s*recursive:\s*true/,
    );

    // The user's own advisor must not ride along. With `advisorModel: "opus"`
    // in their settings, every answer consulted Opus: 17 to 21 s and up to
    // $0.18 a question, against 3 to 5 s without it (CLI 2.1.283). `null` does
    // not turn it off; the empty string does.
    expect(flags, 'the answer settings overlay must be named').toMatch(/'--settings',\s*settingsPath/);
    expect(claude?.source).toMatch(/ANSWER_SETTINGS = \{ advisorModel: '',/);
    // And no auto-memory: with it on, every run left a project folder under
    // ~/.claude/projects, keyed by its one-off run directory.
    expect(claude?.source).toMatch(/ANSWER_SETTINGS = \{[^}]*autoMemoryEnabled: false/);

    // Progress streams: one line per assistant turn as it happens, which is
    // what lets the renderer show text at first-token time (measured 1.1 to
    // 1.8s) rather than a spinner until the end (measured ~6s).
    expect(flags, 'the answer must stream').toMatch(/'--output-format',\s*'stream-json'/);
    // Without partial messages stream-json is one line per COMPLETED turn, so
    // a one-turn answer still arrives all at once at the end.
    expect(flags, 'the stream must carry the model\'s own deltas').toContain('--include-partial-messages');
    // A stream is a transcript, not an answer. At the answer-sized budget the
    // CLI was killed after its second tool call and the "answer" was the
    // agent's own narration; the stream needs its own, far larger bound.
    expect(method, 'a streamed answer needs the stream-sized stdout budget').toContain('ANSWER_STREAM_OUTPUT_BUDGET');

    // And no extended thinking, which is the latency of the whole feature.
    // Measured on a realistic prompt: thinking on cost 4,038ms of API time and
    // 253 output tokens of which 231 were thinking; off cost 2,041ms and 19,
    // and returned the identical answer. Losing this line doubles how long a
    // user waits for a result that does not change.
    expect(environment, 'extended thinking must be off for the answer call').toMatch(
      /MAX_THINKING_TOKENS:\s*'0'/,
    );
    expect(method, 'the fresh run takes the answer environment').toContain('answerEnv(');
    expect(session, 'the warm session takes the answer environment').toContain('answerEnv(');
  });
});

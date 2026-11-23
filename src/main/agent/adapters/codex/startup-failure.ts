import { finalLinesOf, identifyLoginFailure } from '../../shared/user-setup-failure';
import type { UserSetupMatch } from '../../../../shared/user-configuration-error';

/**
 * Codex CLI's own words for a login it can no longer refresh, read out of the
 * 0.163.0 binary beside `login/src/auth/manager.rs`. Bare `Not logged in` is not
 * here: `codex login status` and `/mcp` print it in a working session. Neither is
 * a 401 on a request (0.171.0 answered the first request after a fresh API key
 * login with one, and the next request worked).
 */
const LOGIN_SENTENCES: readonly RegExp[] = [
  /^Your access token could not be refreshed because your refresh token (?:has expired|was already used|was revoked)\. Please log out and sign in again\.$/,
  /^Your access token could not be refreshed\. Please log out and sign in again\.$/,
];

/**
 * Codex refusing a repository's own `.codex/config.toml` and exiting at launch,
 * in the words 0.171.0 printed (a TOML parse error in that file). Kangentic writes
 * nothing in a project's `.codex` folder, so the file is the user's. Not
 * `Error loading config.toml`: Kangentic writes trust tables into the home
 * `config.toml` and passes `-c` overrides, so a refusal of those may be ours.
 * Only the sentence's start is matched: the path makes the line long, and the
 * terminal wraps it at its width.
 */
const PROJECT_CONFIG_REFUSED = /^Error: Error parsing project config file \S/;

/** See `AgentAdapter.identifyUserSetupFailure`. */
export function identifyCodexUserSetupFailure(finalOutput: string): UserSetupMatch | null {
  const login = identifyLoginFailure(finalOutput, LOGIN_SENTENCES);
  if (login) return login;
  const refused = finalLinesOf(finalOutput).find((line) => PROJECT_CONFIG_REFUSED.test(line));
  return refused === undefined ? null : { failure: 'bad_configuration', line: refused };
}

/** Where in the file the parser stopped, when the line kept it (a narrow terminal wraps it off). */
const PARSE_POSITION = /: (TOML parse error at line \d+, column \d+)/;

/**
 * The start of the line Codex 0.171.0 prints for `codex resume <id>` of a
 * conversation it has no record of, then exits 1 about 2 s in (measured in a PTY,
 * `tests/fixtures/codex-0.171.0-resume-missing.txt`). The rest of the line ("Run
 * `codex resume` without an ID ...") is advice a narrow terminal wraps off.
 */
const RESUME_MISS_LEAD = 'ERROR: No saved session found with ID ';
const RESUME_MISS = /^ERROR: No saved session found with ID ([0-9a-fA-F-]{8,})\./;

/** See `AgentAdapter.namesMissingConversation`. A line that starts with the refusal, for this id. */
export function codexNamesMissingConversation(finalOutput: string, agentSessionId: string): boolean {
  const expected = `${RESUME_MISS_LEAD}${agentSessionId}.`;
  return finalLinesOf(finalOutput).some((line) => line.startsWith(expected));
}

/**
 * See `AgentAdapter.describeStartupFailure`. Codex exits at launch on these and
 * its shell stays, so the agent-absence sweep finds it gone, and without a
 * sentence here the card went quiet. Only failures Codex names in its own words.
 */
export function describeCodexStartupFailure(finalOutput: string, _exitCode: number): string | null {
  const resumeMiss = finalLinesOf(finalOutput).map((line) => RESUME_MISS.exec(line)).find((match) => match !== null);
  if (resumeMiss) {
    // Three sentences under the notice's 200-character cap, the remedy last.
    return `Codex found no conversation to resume (session ${resumeMiss[1].slice(0, 8)}). Its history was cleaned up `
      + 'or moved. Move the task to To Do and back to start fresh.';
  }
  const setupFailure = identifyCodexUserSetupFailure(finalOutput);
  if (!setupFailure) return null;
  if (setupFailure.failure === 'login_required') return `Codex needs a new sign-in. ${setupFailure.line}`;
  const position = PARSE_POSITION.exec(setupFailure.line)?.[1];
  return `Codex could not read this project's .codex/config.toml${position ? ` (${position})` : ''}. Fix the file, then start the task again.`;
}

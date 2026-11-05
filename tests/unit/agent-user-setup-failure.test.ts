/**
 * Each adapter's `identifyUserSetupFailure`, over the REAL registered adapters.
 *
 * What these name stays out of Sentry and gets no retry, so a match that is too
 * wide hides a real bug, and the opposite cases below matter as much as the
 * positive ones. Every sentence is the CLI's own wording as each adapter's
 * `startup-failure.ts` records it, read out of the shipped bundle or binary at the
 * version named there. None is a live capture. The table replays every branch of
 * every adapter's regex list once, so a typo in one branch fails here.
 *
 * Outcomes pinned here: a login or configuration failure a CLI names is the
 * user's. Anything else from an installed CLI stays a report: a bare phrase, a
 * sentence quoted in a typed prompt, a file Kangentic writes, and an unknown failure.
 */
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { agentRegistry } from '../../src/main/agent/agent-registry';

/** Agents with no measured wording. Unidentified is the safe side, so a failure of theirs is reported. */
const NO_RECOGNIZER = ['aider', 'goose', 'kimi', 'ollama'];

function identify(agent: string, output: string): string | null {
  const identifyFailure = agentRegistry.get(agent).identifyUserSetupFailure;
  if (!identifyFailure) throw new Error(`${agent} has no recognizer`);
  return identifyFailure.call(agentRegistry.get(agent), output)?.failure ?? null;
}

/** The shape a real failure reaches the ring in: the shell's line, the CLI's, the prompt. */
function shellRun(line: string): string {
  return `PS C:\\mock> agent --print\r\n\x1b[31m${line}\x1b[0m\r\nPS C:\\mock> `;
}

const LOGIN_SENTENCES: ReadonlyArray<[string, string]> = [
  ['claude', 'Not logged in · Please run /login'],
  ['claude', 'Login expired · Please run /login'],
  ['claude', 'OAuth token revoked · Please run /login'],
  ['claude', 'Login reached its time limit · Please run /login'],
  ['claude', 'Invalid API key · Fix external API key'],
  ['claude', 'Invalid auth token · Fix external auth token'],
  ['claude', 'Authentication required · Sign in again to continue'],
  ['codex', 'Your access token could not be refreshed because your refresh token has expired. Please log out and sign in again.'],
  ['codex', 'Your access token could not be refreshed because your refresh token was revoked. Please log out and sign in again.'],
  ['codex', 'Your access token could not be refreshed because your refresh token was already used. Please log out and sign in again.'],
  ['codex', 'Your access token could not be refreshed. Please log out and sign in again.'],
  ['gemini', 'Please set an Auth method in your /mock/.gemini/settings.json or specify one of the following environment variables before running: GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA'],
  ['gemini', 'When using Gemini API, you must specify the GEMINI_API_KEY environment variable.'],
  ['gemini', 'Authentication consent could not be obtained.'],
  ['gemini', 'Manual authorization is required but the current session is non-interactive. Please run the Gemini CLI in an interactive terminal to log in, provide a GEMINI_API_KEY, or ensure Application Default Credentials are configured.'],
  ['qwen', 'No auth type is selected. Please configure an auth type (e.g. via settings or `--auth-type`) before running in non-interactive mode.'],
  ['qwen', 'Missing API key for OpenAI-compatible auth. Set the OPENAI_API_KEY environment variable.'],
  ['qwen', 'Qwen OAuth credentials expired. Please use /auth to re-authenticate with qwen-oauth.'],
  ['qwen', "Refresh token expired or invalid. Please use '/auth' to re-authenticate."],
  ['copilot', 'Error: No authentication information found.'],
  ['grok', 'Your session has expired. Run `grok login` to sign in again.'],
  ['grok', 'Not signed in. Run `grok login` to authenticate (or `grok login --device-code` if no browser is available).'],
  ['grok', 'Headless mode requires a grok.com session. Run `grok login` to sign in, or use `grok agent stdio` for API-key access.'],
  ['grok', 'Your auth token is invalid or expired. Run `grok login` to re-authenticate.'],
  ['grok', 'Your GROK_DEPLOYMENT_KEY is invalid or expired. Please contact a team admin.'],
  ['opencode','Authentication is missing or has expired (the endpoint is likely behind an SSO or identity-aware proxy).'],
  ['antigravity', "Error: authentication required. Run 'agy login' to log in."],
  ['antigravity', "Error: authentication required. Run 'agy login' to log in, then retry."],
  ['antigravity', 'Print mode: not logged in and no controlling terminal; cannot complete interactive login'],
  ['cursor', "Error: Authentication required. Run 'cursor-agent login', pass --api-key/--auth-token, or set CURSOR_API_KEY/CURSOR_AUTH_TOKEN."],
  ['cursor', '⚠ Warning: The provided API key is invalid.'],
  ['droid', 'Not authenticated. Please log in using /login or set a valid FACTORY_API_KEY environment variable.'],
  ['droid', 'Authentication failed. FACTORY_API_KEY is set but appears to be invalid. Unset it or replace it with a valid key.'],
  ['droid', 'Authentication failed. Please log in using /login or set a valid FACTORY_API_KEY environment variable.'],
  ['droid', 'Authentication failed. Your login session may have expired. Please log in again using /login.'],
  ['warp', "Your API key is invalid. Please provide a valid key via '--api-key' or the WARP_API_KEY environment variable."],
  ['warp', "Failed to authenticate with server - please log in via 'oz login', provide an API key via '--api-key <key>', or set the WARP_API_KEY environment variable"],
  ['warp', 'You are not logged in - please log in with `oz login` to continue.'],
  ['warp', 'Your credentials are invalid. Please log in again with `oz login`.'],
  ['warp', "Authentication required. Log in via 'oz login', provide an API key via '--api-key', or set the WARP_API_KEY environment variable."],
];

describe('a login failure the CLI names', () => {
  it.each(LOGIN_SENTENCES)('%s: %s', (agent, sentence) => {
    expect(identify(agent, shellRun(sentence))).toBe('login_required');
  });
});

describe('the line that named it, which the notice shows', () => {
  it('is the CLI\'s own line, with its colour gone', () => {
    const match = agentRegistry.get('claude').identifyUserSetupFailure?.(shellRun('Not logged in · Please run /login'));
    expect(match).toEqual({ failure: 'login_required', line: 'Not logged in · Please run /login' });
  });

  it('is the refused file\'s line for a bad configuration', () => {
    const file = path.join(os.homedir(), '.gemini', 'settings.json');
    const match = agentRegistry.get('gemini').identifyUserSetupFailure?.(`Error in ${file}: Unexpected token\r\nPlease fix the configuration file(s) and try again.\r\n`);
    expect(match).toEqual({ failure: 'bad_configuration', line: `Error in ${file}: Unexpected token` });
  });
});

describe('a settings file the CLI refuses', () => {
  const homeSettings = (folder: string): string => path.join(os.homedir(), folder, 'settings.json');
  const refused = (file: string): string => `Error in ${file}: Unexpected token\r\nPlease fix the configuration file(s) and try again.\r\n$ `;

  it.each([['gemini', '.gemini'], ['qwen', '.qwen']])('%s: the user\'s own file in their home folder', (agent, folder) => {
    expect(identify(agent, refused(homeSettings(folder)))).toBe('bad_configuration');
  });

  it.each([['gemini', '.gemini'], ['qwen', '.qwen']])('%s: not the project file, which Kangentic writes hooks into', (agent, folder) => {
    expect(identify(agent, refused(path.join(os.tmpdir(), 'project', folder, 'settings.json')))).toBeNull();
  });

  it('needs both lines, since a lone error line can be anything', () => {
    expect(identify('gemini', `Error in ${homeSettings('.gemini')}: Unexpected token\r\n`)).toBeNull();
    expect(identify('gemini', 'Please fix the configuration file(s) and try again.\r\n')).toBeNull();
  });
});

describe('what stays a report, because it may be our bug', () => {
  it.each(LOGIN_SENTENCES)('%s, quoted in a typed prompt: %s', (agent, sentence) => {
    // A shell echoes the line it is typed, and a task can be about this very text.
    expect(identify(agent, `$ agent --print 'handle "${sentence}" better'\r\n$ `)).toBeNull();
  });

  it.each(LOGIN_SENTENCES)('%s, at the end of a typed line: %s', (agent, sentence) => {
    expect(identify(agent, `$ agent --print fix ${sentence}\r\n$ `)).toBeNull();
  });

  it.each([
    ['codex', 'Not logged in'],
    ['codex', '• Auth: Not logged in'],
    ['cursor', 'Not logged in. Run /login first.'],
    ['cursor', 'Authentication required'],
    ['claude', 'Not logged in'],
    ['claude', 'Invalid API key'],
    ['claude', 'Please run /login'],
    ['droid', 'Error: Not authenticated. Run \'droid headless login\'.'],
    ['grok', 'You are not authenticated.'],
    ['codex', "Not signed in. Please run 'codex login' to sign in with ChatGPT, then re-run 'codex cloud'."],
    ['antigravity', 'Please sign in to view available models. Launch the CLI without arguments to sign in.'],
    ['antigravity', 'Welcome back! You are currently not signed in.'],
    // The CLI itself says this one may be the network.
    ['copilot', 'Error: Authentication token found but could not be validated.'],
    // A warning, and the run goes on.
    ['gemini', 'Invalid configuration in /mock/.gemini/settings.json:'],
    ['copilot', 'Warning: Failed to load config file, using defaults.'],
  ])('%s, a phrase a working session prints: %s', (agent, line) => {
    expect(identify(agent, shellRun(line))).toBeNull();
  });

  it.each([
    'Error: Settings file not found: /mock/project/.kangentic/sessions/1/settings.json',
    'Error: Invalid JSON provided to --settings',
    'Error: Cannot use settings file',
  ])('Claude refusing the settings file Kangentic wrote: %s', (line) => {
    expect(identify('claude', shellRun(line))).toBeNull();
  });

  it.each(agentRegistry.list().filter((name) => !NO_RECOGNIZER.includes(name)))('%s: an unknown failure, or nothing', (agent) => {
    expect(identify(agent, shellRun('Segmentation fault'))).toBeNull();
    expect(identify(agent, shellRun('zsh: command not found: agent'))).toBeNull();
    expect(identify(agent, shellRun("error: unknown option '--session-id'"))).toBeNull();
    expect(identify(agent, '')).toBeNull();
  });

  it('reads the end of the output, so a line long past cannot speak for this launch', () => {
    const later = Array.from({ length: 20 }, (_, index) => `line ${index}`).join('\r\n');
    expect(identify('claude', `Not logged in · Please run /login\r\n${later}`)).toBeNull();
  });
});

describe('an agent with no measured wording', () => {
  it.each(NO_RECOGNIZER)('%s identifies nothing, so its failures are reported', (agent) => {
    expect(agentRegistry.get(agent).identifyUserSetupFailure).toBeUndefined();
  });
});

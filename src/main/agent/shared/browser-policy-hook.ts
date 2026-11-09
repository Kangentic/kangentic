import { BROWSER_POLICY_REPLACEMENT_TOOL, encodeHookSpec, quoteBridgePath, type HookShell } from './hook-utils';

/**
 * The contract between an adapter and the browser policy hook
 * (`src/main/agent/browser-policy-bridge.js`), task #977.
 *
 * While the Agent Browser is on, it is the only browser an agent drives. An
 * agent in a project whose `.mcp.json` shipped Playwright MCP drove that
 * server's Chrome instead, for a whole task, while the `kangentic_browser_*`
 * tools sat in its tool list. The hook denies a third-party browser server's
 * tool at the moment the agent picks it, and its reason names the replacement.
 *
 * The bridge reads the Agent Browser switch from Kangentic's global config on
 * every call, so turning the Agent Browser off frees a running session at once
 * and turning it on blocks at once, with no respawn. Everything agent-specific
 * (the tool name field, the reply the CLI reads as a deny) is the adapter's
 * spec; the bridge knows none of it.
 */

/** The string the bridge replaces with the denied tool's name, anywhere inside a `reply` string. */
export const BROWSER_POLICY_TOOL_PLACEHOLDER = '{{tool}}';

/** The tool an agent is pointed at, and the marker that recognizes a Kangentic browser policy hook. */
export { BROWSER_POLICY_REPLACEMENT_TOOL };

/** What a denied call is told, inside the CLI's reply envelope. */
export const BROWSER_POLICY_DENY_TEXT =
  `Kangentic blocked ${BROWSER_POLICY_TOOL_PLACEHOLDER}: the Kangentic browser is the only browser in this session. `
  + `Call ${BROWSER_POLICY_REPLACEMENT_TOOL} with the URL, then use the kangentic_browser_* tools. `
  + 'kangentic_browser_screenshot, _screenshot_element, _query_dom (page HTML) and _eval take saveToFile to write a large capture to a file. '
  + 'Do not switch to a Playwright, Puppeteer or Selenium script instead.';

/**
 * The system prompt text an agent CLI that takes one gets while the Agent
 * Browser is on. The MCP instructions carry a shorter form of the same policy
 * for every agent (`server-instructions.ts`).
 *
 * One line, with no double quote, backtick, `$`, `%` or `!`, because it rides
 * the command line as one quoted argument: cmd.exe keeps only the first line of
 * a multi-line argument through an npm `.cmd` shim (#353), and each of those
 * characters is special to at least one host shell.
 * `tests/unit/claude-browser-policy.test.ts` pins that.
 */
export const BROWSER_POLICY_PROMPT = [
  'BROWSER: The Kangentic browser (the kangentic_browser_* tools) is the only browser you drive.',
  'That holds for any web page, whether localhost, staging, production or a third-party site, and for any purpose: verifying the app, inspecting a page, capturing screenshots or DOM for your own work or an artifact, comparing production with a local build, or scraping.',
  'Do not use mcp__playwright__* tools, mcp__claude-in-chrome__* tools, chrome-devtools or puppeteer MCP servers, a computer-use tool, or a Playwright, Puppeteer or Selenium script you write yourself.',
  'Each drives a different browser from the pane the user watches, and Kangentic blocks those MCP tools in this session.',
  'Running the project test suite (npx playwright test, for example) is not driving a browser and is fine.',
  'Open a browser only when the work needs one, and when it does, use this one.',
  `If no pane is open, call ${BROWSER_POLICY_REPLACEMENT_TOOL} with the URL; you do not need to ask.`,
  'For a large capture, pass saveToFile to kangentic_browser_screenshot, _screenshot_element, _query_dom (page HTML) or _eval, which writes it to a file and returns the path instead of filling your context.',
].join(' ');

/**
 * Lowercase fragments of a server name that mark a browser-automation server
 * whose config Kangentic never read: a plugin's server
 * (`mcp__plugin_playwright_playwright__`), a managed one, or one added after
 * the session started. Claude in Chrome is built in, so only its name exists.
 */
export const BROWSER_SERVER_NAME_TOKENS: readonly string[] = [
  'playwright',
  'puppeteer',
  'chrome-devtools',
  'claude-in-chrome',
  'browsermcp',
];

/**
 * Lowercase fragments of a server's `command`, `args` or `url` that mark a
 * browser-automation server, whatever the user named it.
 */
const BROWSER_SERVER_PACKAGE_TOKENS: readonly string[] = [
  '@playwright/mcp',
  'playwright-mcp',
  'mcp-server-playwright',
  'chrome-devtools-mcp',
  'puppeteer',
  '@browsermcp/mcp',
  'browserbase',
];

/**
 * The server Kangentic itself runs. Never denied, whatever its tools are named.
 * `browser-policy-bridge.js` cannot import this module and holds the same
 * literal as `KANGENTIC_SERVER`; change both together.
 */
const KANGENTIC_SERVER_NAME = 'kangentic';

/** One MCP server entry as a CLI's config file describes it. Only these fields are read. */
export interface McpServerDescription {
  name: string;
  command?: unknown;
  args?: unknown;
  url?: unknown;
}

/** True when a server's launch or address names a browser-automation package, or its name does. */
export function isBrowserAutomationServer(server: McpServerDescription): boolean {
  if (server.name === KANGENTIC_SERVER_NAME) return false;
  const launch = [server.command, ...(Array.isArray(server.args) ? server.args : []), server.url]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
    .toLowerCase();
  if (BROWSER_SERVER_PACKAGE_TOKENS.some((token) => launch.includes(token))) return true;
  const name = server.name.toLowerCase();
  return BROWSER_SERVER_NAME_TOKENS.some((token) => name.includes(token));
}

/**
 * A server name the way a tool name carries it: every character but a letter,
 * digit, `_` or `-` becomes `_`.
 */
export function toolNameServerSegment(serverName: string): string {
  return serverName.replace(/[^A-Za-z0-9_-]/g, '_');
}

/** What every MCP tool name starts with, and what ends its server segment. */
const MCP_TOOL_PREFIX = 'mcp__';
const MCP_SERVER_SEPARATOR = '__';

/** What every tool of a server starts with: `mcp__<segment>__`. */
export function browserServerToolPrefix(serverName: string): string {
  return `${MCP_TOOL_PREFIX}${toolNameServerSegment(serverName)}${MCP_SERVER_SEPARATOR}`;
}

/** A JSON value a reply template can hold. */
export type BrowserPolicyReplyValue =
  | string
  | number
  | boolean
  | null
  | BrowserPolicyReplyValue[]
  | { [key: string]: BrowserPolicyReplyValue };

export interface BrowserPolicyHookSpec {
  /** The stdin field naming the tool about to run. */
  toolField: string;
  /** What every MCP tool name starts with; the server name follows it, then `serverSeparator`. */
  toolPrefix: string;
  /** What ends the server name inside a tool name. */
  serverSeparator: string;
  /** Server names denied exactly (`toolNameServerSegment` form): the browser servers found in the CLI's config. */
  servers: string[];
  /** Lowercase fragments that deny a server whose name contains one. */
  serverTokens: string[];
  /** Kangentic's global config file, read on every call for the Agent Browser switch. */
  configPath: string;
  /** Where the switch sits in that file. */
  enabledPath: string[];
  /** The switch's value when the file has none. */
  enabledDefault: boolean;
  /** What the hook prints to deny, with `BROWSER_POLICY_TOOL_PLACEHOLDER` in place. */
  reply: BrowserPolicyReplyValue;
}

/** Where `AppConfig.browserAutomation.enabled` sits in the global config file, and its default. */
export const BROWSER_AUTOMATION_ENABLED_PATH: readonly string[] = ['browserAutomation', 'enabled'];
export const BROWSER_AUTOMATION_ENABLED_DEFAULT = true;

/** The spec's fields every CLI shares, given its tool field and its deny reply. */
export function browserPolicySpec(input: {
  toolField: string;
  servers: string[];
  configPath: string;
  reply: BrowserPolicyReplyValue;
}): BrowserPolicyHookSpec {
  return {
    toolField: input.toolField,
    toolPrefix: MCP_TOOL_PREFIX,
    serverSeparator: MCP_SERVER_SEPARATOR,
    servers: [...new Set(input.servers.map(toolNameServerSegment))],
    serverTokens: [...BROWSER_SERVER_NAME_TOKENS],
    configPath: input.configPath,
    enabledPath: [...BROWSER_AUTOMATION_ENABLED_PATH],
    enabledDefault: BROWSER_AUTOMATION_ENABLED_DEFAULT,
    reply: input.reply,
  };
}

function escapeForRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A token as a pattern that matches it in any case: `[Pp][Ll][Aa]...`. The
 * bridge compares a server name to a token case-insensitively, and Claude
 * filters hooks with a case-sensitive regex, so a lowercase token alone would
 * keep the hook from running for a server named `Playwright`.
 */
function anyCasePattern(token: string): string {
  return [...token].map((character) => {
    const lower = character.toLowerCase();
    const upper = character.toUpperCase();
    return lower === upper ? escapeForRegExp(character) : `[${upper}${lower}]`;
  }).join('');
}

/**
 * A hook matcher that covers every tool the spec can deny, and none of
 * Kangentic's own: `mcp__(?!kangentic__).*(?:<tokens>|<names>).*`. Tokens
 * match in any case, as the bridge compares them. A superset, since a tool
 * whose own name holds a token matches too. The bridge decides exactly, so the
 * hook runs only for a call it might deny.
 */
export function browserPolicyMatcher(spec: Pick<BrowserPolicyHookSpec, 'toolPrefix' | 'serverSeparator' | 'servers' | 'serverTokens'>): string {
  const alternatives = [
    ...new Set(spec.serverTokens.map(anyCasePattern)),
    ...new Set(spec.servers.map(escapeForRegExp)),
  ];
  const ownServer = escapeForRegExp(`${KANGENTIC_SERVER_NAME}${spec.serverSeparator}`);
  return `${escapeForRegExp(spec.toolPrefix)}(?!${ownServer}).*(?:${alternatives.join('|')}).*`;
}

/**
 * Build the hook command: `node "<bridge>" <base64 spec>`, the bridge path
 * quoted for the adapter's declared `windowsShell`.
 */
export function buildBrowserPolicyCommand(
  windowsShell: HookShell,
  bridgePath: string,
  spec: BrowserPolicyHookSpec,
): string {
  return `node ${quoteBridgePath(bridgePath, windowsShell)} ${encodeHookSpec(spec)}`;
}

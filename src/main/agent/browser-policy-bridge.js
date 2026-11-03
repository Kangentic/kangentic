#!/usr/bin/env node
/**
 * Browser Policy Bridge - denies a third-party browser-automation MCP tool
 * while the Kangentic Agent Browser is on, and tells the agent what to use
 * instead (task #977).
 *
 * An agent in a project whose `.mcp.json` shipped Playwright MCP drove that
 * server's Chrome for a whole task, with the `kangentic_browser_*` tools in its
 * tool list. The CLI shows a PreToolUse deny's reason to the model as the tool
 * result, so the redirect lands at the moment the agent picks a browser.
 *
 * Usage:
 *   node browser-policy-bridge.js <spec>
 *
 * <spec>  base64(JSON) from `buildBrowserPolicyCommand`
 *         (`src/main/agent/shared/browser-policy-hook.ts`):
 *         {
 *           toolField: string,        stdin field naming the tool
 *           toolPrefix: string,       what an MCP tool name starts with ("mcp__")
 *           serverSeparator: string,  what ends the server name ("__")
 *           servers: string[],        server names denied exactly
 *           serverTokens: string[],   lowercase fragments that deny a server name
 *           configPath: string,       Kangentic's global config file
 *           enabledPath: string[],    where the Agent Browser switch sits in it
 *           enabledDefault: boolean,  the switch when the file has none
 *           reply: object             printed; "{{tool}}" inside any string
 *                                     becomes the tool name
 *         }
 *
 * The switch is read from the config file on every call, so turning the Agent
 * Browser off frees a running session at once. A tool that is not a listed
 * browser server's, the switch off, an unreadable config file, an oversized or
 * malformed stdin, or any error prints NOTHING and exits 0: the call runs as it
 * would without the hook.
 *
 * Measured on Claude Code 2.1.317 (`scripts/probe-claude-browser-deny.js`): the
 * deny held in every permission mode, bypassPermissions included, and for a
 * subagent's call. No PostToolUse or PostToolUseFailure fires for a denied
 * call; the activity engine clears the event bridge's unmatched `tool_start`
 * at the turn's Stop.
 *
 * Main also loads this file, for a CLI installed in a WSL distro: there the
 * hook publishes its request to a file (`wsl-hook-transport.ts`) and Kangentic
 * answers it with `browserPolicyReply`. Loading it has no side effect.
 */

const fs = require('node:fs');

const MAX_STDIN_CHARACTERS = 1024 * 1024;
// This script runs outside the bundle and cannot import browser-policy-hook.ts,
// which holds the same two values (BROWSER_POLICY_TOOL_PLACEHOLDER and
// KANGENTIC_SERVER_NAME). Change both together.
const TOOL_PLACEHOLDER = '{{tool}}';
const KANGENTIC_SERVER = 'kangentic';

/** Copy the reply template, putting the tool name in place inside every string. */
function fill(template, toolName) {
  if (typeof template === 'string') return template.split(TOOL_PLACEHOLDER).join(toolName);
  if (Array.isArray(template)) return template.map((entry) => fill(entry, toolName));
  if (template && typeof template === 'object') {
    const filled = {};
    for (const [key, value] of Object.entries(template)) filled[key] = fill(value, toolName);
    return filled;
  }
  return template;
}

/** The server segment of an MCP tool name, or null for any other tool. */
function serverOf(toolName, prefix, separator) {
  if (typeof prefix !== 'string' || prefix.length === 0 || !toolName.startsWith(prefix)) return null;
  const rest = toolName.slice(prefix.length);
  const end = typeof separator === 'string' && separator.length > 0 ? rest.indexOf(separator) : -1;
  if (end <= 0) return null;
  return rest.slice(0, end);
}

/**
 * True when the spec names this tool's server, exactly or by a fragment of its
 * name. A listed server is matched against the whole tool name, since its own
 * name may hold the separator (`web__tester` gives `mcp__web__tester__navigate`,
 * whose first segment is only `web`).
 */
function isDeniedServer(toolName, server, spec) {
  if (server === KANGENTIC_SERVER) return false;
  const rest = toolName.slice(spec.toolPrefix.length);
  if (Array.isArray(spec.servers) && spec.servers.some((listed) => (
    typeof listed === 'string' && listed.length > 0 && rest.startsWith(`${listed}${spec.serverSeparator}`)
  ))) return true;
  const lowered = server.toLowerCase();
  return Array.isArray(spec.serverTokens)
    && spec.serverTokens.some((token) => typeof token === 'string' && token.length > 0 && lowered.includes(token));
}

/**
 * The Agent Browser switch, read from the config file now. Null when the file
 * cannot be read or parsed: the hook then answers nothing, since a wrong deny
 * strands an agent with no browser at all.
 */
function readEnabled(spec, readConfigText) {
  let text;
  try {
    text = readConfigText(spec.configPath);
  } catch (error) {
    // A machine that never saved a setting has no config file: the default holds.
    if (error && error.code === 'ENOENT') return spec.enabledDefault === true;
    return null;
  }
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    return null;
  }
  let value = config;
  for (const segment of Array.isArray(spec.enabledPath) ? spec.enabledPath : []) {
    value = value && typeof value === 'object' ? value[segment] : undefined;
  }
  return typeof value === 'boolean' ? value : spec.enabledDefault === true;
}

function readFileText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

/**
 * What the hook prints for one tool call, or null to print nothing. Never
 * throws.
 *
 * @param {string | undefined} encodedSpec
 * @param {string} input the hook's stdin as received
 * @param {(filePath: string) => string} [readConfigText] reads the config file; tests pass their own
 * @returns {string | null}
 */
function browserPolicyReply(encodedSpec, input, readConfigText = readFileText) {
  try {
    if (!encodedSpec || typeof input !== 'string' || input.length > MAX_STDIN_CHARACTERS) return null;
    const spec = JSON.parse(Buffer.from(encodedSpec, 'base64').toString('utf8'));
    if (!spec || typeof spec !== 'object' || !spec.reply || typeof spec.toolField !== 'string') return null;

    let context;
    try {
      context = JSON.parse(input);
    } catch {
      return null;
    }
    if (!context || typeof context !== 'object') return null;
    const toolName = context[spec.toolField];
    if (typeof toolName !== 'string') return null;

    const server = serverOf(toolName, spec.toolPrefix, spec.serverSeparator);
    if (!server || !isDeniedServer(toolName, server, spec)) return null;
    if (readEnabled(spec, readConfigText) !== true) return null;

    return JSON.stringify(fill(spec.reply, toolName));
  } catch {
    // Prints nothing: the call runs as it would without the hook.
    return null;
  }
}

module.exports = { browserPolicyReply };

if (require.main === module) {
  const [, , encodedSpec] = process.argv;
  let input = '';
  let overflowed = false;
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    if (overflowed) return;
    input += chunk;
    if (input.length > MAX_STDIN_CHARACTERS) {
      overflowed = true;
      input = '';
    }
  });
  process.stdin.on('end', () => {
    if (overflowed) return;
    const reply = browserPolicyReply(encodedSpec, input);
    if (reply !== null) process.stdout.write(reply);
  });
}

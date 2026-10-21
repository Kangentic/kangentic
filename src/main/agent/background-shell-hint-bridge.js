#!/usr/bin/env node
/**
 * Background Shell Hint Bridge - tells the agent, beside a tool result, that
 * the background command it just started keeps its task marked as working,
 * and how to say the command is a service instead (task #857).
 *
 * A background shell holds its session `thinking` until it exits, because the
 * agent may be waiting on it. A dev server or watcher it leaves running then
 * held the task busy forever, and the column's On agent turn end automations
 * never ran. Only the agent knows which kind a shell is, so this hook asks it
 * at the moment it knows. The reply is the CLI's "added context" output; the
 * agent answers through the `kangentic_mark_background_service` MCP tool.
 *
 * Usage:
 *   node background-shell-hint-bridge.js <spec>
 *
 * <spec>  base64(JSON) from `buildBackgroundShellHintCommand`
 *         (`src/main/agent/shared/background-shell-hint-hook.ts`). All agent
 *         knowledge travels here, never in this file. Two shapes:
 *
 *         v2 (task #859), the launch match the event bridge's
 *         `appendBackgroundLaunch` directive carries, so the hint and the hold
 *         answer exactly the same calls:
 *         {
 *           launch: { toolField, tools, when, unless, idSources, commandPath,
 *                     optOutFlag },
 *           reply: object
 *         }
 *
 *         v1 (Claude's, kept byte for byte):
 *         {
 *           toolField: string,     stdin field naming the tool
 *           tools: string[],       the tools that can start a background shell
 *           inputField: string,    stdin field holding the tool input
 *           commandField: string,  input field holding the command
 *           responseField: string, stdin field holding the tool result
 *           idFields: string[],    result fields that can carry the shell id
 *           optOutFlag: string,    a command carrying it gets no hint
 *           reply: object          printed; "{{shellId}}" inside any string
 *                                  becomes the shell id
 *         }
 *
 * Answers only a background launch: a listed tool whose result carries an
 * id-shaped shell id, and whose command does not carry the opt-out flag. A
 * foreground call, any other tool, an oversized or malformed stdin, or any
 * error prints NOTHING and exits 0, so it can never fail or block a tool.
 */

const MAX_STDIN_CHARACTERS = 1024 * 1024;
const SHELL_ID_PLACEHOLDER = '{{shellId}}';

const [, , encodedSpec] = process.argv;

// BEGIN background-call-match
// Shared verbatim by event-bridge.js and background-shell-hint-bridge.js (a
// workspace copy of either bridge is one file, so it cannot require a module). The shape is
// BackgroundCallMatch in src/shared/background-command-spec.ts.
// tests/unit/background-call-match-parity.test.ts keeps the two copies equal.
const BACKGROUND_MATCH_SCAN_CAP = 64 * 1024;
// Mirrors `looksLikeShellId` (src/main/activity-engine/background-shell/looks-like-shell-id.ts).
// A literal, so no id regex is built from argv; the parity test pins it to SHELL_ID_PATTERN_SOURCE.
const SHELL_ID_PATTERN = /^[\w-]{1,64}$/;

function valueAtPath(root, pathSegments) {
  if (!Array.isArray(pathSegments) || pathSegments.length === 0) return undefined;
  let value = root;
  for (const segment of pathSegments) {
    value = value && typeof value === 'object' ? value[segment] : undefined;
  }
  return value;
}

function conditionHolds(root, condition) {
  return Boolean(condition) && valueAtPath(root, condition.path) === condition.equals;
}

function idFromSources(root, sources) {
  if (!Array.isArray(sources)) return null;
  for (const source of sources) {
    if (!source) continue;
    const value = valueAtPath(root, source.path);
    let candidate = null;
    if (typeof source.pattern === 'string') {
      if (typeof value !== 'string') continue;
      try {
        const match = value.slice(0, BACKGROUND_MATCH_SCAN_CAP).match(new RegExp(source.pattern));
        if (match && typeof match[1] === 'string') candidate = match[1];
      } catch {
        continue;
      }
    } else if (typeof value === 'string' || typeof value === 'number') {
      candidate = String(value);
    }
    if (candidate && SHELL_ID_PATTERN.test(candidate)) return candidate;
  }
  return null;
}

/** The id of a call `match` names, or null. Never throws. */
function matchBackgroundCall(root, match) {
  if (!root || typeof root !== 'object' || !match || typeof match !== 'object') return null;
  if (typeof match.toolField !== 'string' || !Array.isArray(match.tools)) return null;
  const tool = root[match.toolField];
  if (typeof tool !== 'string' || !match.tools.includes(tool)) return null;
  const when = Array.isArray(match.when) ? match.when : [];
  const unless = Array.isArray(match.unless) ? match.unless : [];
  if (!when.every((condition) => conditionHolds(root, condition))) return null;
  if (unless.some((condition) => conditionHolds(root, condition))) return null;
  const id = idFromSources(root, match.idSources);
  return id ? { tool, id } : null;
}

/** True when the command at `commandPath` carries `flag`. */
function commandCarries(root, commandPath, flag) {
  const command = valueAtPath(root, commandPath);
  return typeof command === 'string' && typeof flag === 'string' && flag.length > 0 && command.includes(flag);
}
// END background-call-match

/** Copy the reply template, putting the shell id in place inside every string. */
function fill(template, shellId) {
  if (typeof template === 'string') return template.split(SHELL_ID_PLACEHOLDER).join(shellId);
  if (Array.isArray(template)) return template.map((entry) => fill(entry, shellId));
  if (template && typeof template === 'object') {
    const filled = {};
    for (const [key, value] of Object.entries(template)) filled[key] = fill(value, shellId);
    return filled;
  }
  return template;
}

function shellIdOf(response, idFields) {
  for (const field of idFields) {
    const value = response[field];
    if (typeof value === 'string' && SHELL_ID_PATTERN.test(value)) return value;
  }
  return null;
}

/** v1: Claude's spec. The shell id of a background launch, or null. */
function legacyLaunchId(spec, context) {
  if (!Array.isArray(spec.tools) || !Array.isArray(spec.idFields)) return null;
  if (!spec.tools.includes(context[spec.toolField])) return null;

  const response = context[spec.responseField];
  if (!response || typeof response !== 'object') return null;
  const shellId = shellIdOf(response, spec.idFields);
  if (!shellId) return null;

  const toolInput = context[spec.inputField];
  const command = toolInput && typeof toolInput === 'object' ? toolInput[spec.commandField] : undefined;
  if (typeof command === 'string' && typeof spec.optOutFlag === 'string' && spec.optOutFlag && command.includes(spec.optOutFlag)) return null;
  return shellId;
}

/** v2: the launch match the event bridge reads. The id of a background launch, or null. */
function launchId(launch, context) {
  const match = matchBackgroundCall(context, launch);
  if (!match) return null;
  if (commandCarries(context, launch.commandPath, launch.optOutFlag)) return null;
  return match.id;
}

let input = '';
let overflowed = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  if (overflowed) return;
  input += chunk;
  // A background launch's payload is small. A huge one is a foreground
  // command's output, which is never answered.
  if (input.length > MAX_STDIN_CHARACTERS) {
    overflowed = true;
    input = '';
  }
});
process.stdin.on('end', () => {
  try {
    if (overflowed || !encodedSpec) return;
    const spec = JSON.parse(Buffer.from(encodedSpec, 'base64').toString('utf8'));
    if (!spec || typeof spec !== 'object' || !spec.reply) return;

    let context;
    try {
      context = JSON.parse(input);
    } catch {
      return;
    }
    if (!context || typeof context !== 'object') return;

    const shellId = spec.launch && typeof spec.launch === 'object'
      ? launchId(spec.launch, context)
      : legacyLaunchId(spec, context);
    if (!shellId) return;

    process.stdout.write(JSON.stringify(fill(spec.reply, shellId)));
  } catch {
    // Prints nothing: the tool result reaches the agent as it would without the hook.
  }
});

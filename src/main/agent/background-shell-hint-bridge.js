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
 *         knowledge travels here, never in this file:
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
// Mirrors `looksLikeShellId` (src/main/activity-engine/background-shell/looks-like-shell-id.ts).
const SHELL_ID_PATTERN = /^[\w-]{1,64}$/;
const SHELL_ID_PLACEHOLDER = '{{shellId}}';

const [, , encodedSpec] = process.argv;

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
    if (!spec || typeof spec !== 'object' || !spec.reply || !Array.isArray(spec.tools) || !Array.isArray(spec.idFields)) return;

    let context;
    try {
      context = JSON.parse(input);
    } catch {
      return;
    }
    if (!context || typeof context !== 'object') return;
    if (!spec.tools.includes(context[spec.toolField])) return;

    const response = context[spec.responseField];
    if (!response || typeof response !== 'object') return;
    const shellId = shellIdOf(response, spec.idFields);
    if (!shellId) return;

    const toolInput = context[spec.inputField];
    const command = toolInput && typeof toolInput === 'object' ? toolInput[spec.commandField] : undefined;
    if (typeof command === 'string' && typeof spec.optOutFlag === 'string' && spec.optOutFlag && command.includes(spec.optOutFlag)) return;

    process.stdout.write(JSON.stringify(fill(spec.reply, shellId)));
  } catch {
    // Prints nothing: the tool result reaches the agent as it would without the hook.
  }
});

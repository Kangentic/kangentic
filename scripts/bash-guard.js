#!/usr/bin/env node
/**
 * PreToolUse hook -- blocks chained/piped Bash commands.
 *
 * Reads hook context JSON from stdin. If the tool is Bash and the command
 * contains forbidden shell operators outside of quoted strings, emits a
 * deny decision to stdout. Otherwise exits silently (implicit allow).
 */

const FORBIDDEN = ['&&', '||', ' | ', '; ', '2>/dev/null', '2>&1'];

/**
 * Command substitution runs a second command, so it breaks the one-command
 * rule wherever bash expands it: unquoted AND inside double quotes. Only
 * single quotes make it literal. Checking it outside quotes alone let
 * `node -e "... \`npm start\` ..."` through, and bash ran the backticked text
 * as commands, which started a real dev server.
 */
const FORBIDDEN_UNLESS_SINGLE_QUOTED = ['`', '$('];

/**
 * Walk `str` char-by-char, tracking single/double quote state and backslash
 * escapes. Returns the first pattern from `outsideQuotes` found outside any
 * quotes, or from `unlessSingleQuoted` found anywhere but single quotes, or
 * null.
 */
function findForbidden(str, outsideQuotes, unlessSingleQuoted) {
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < str.length; i++) {
    const ch = str[i];

    // A backslash makes the next character literal, except inside single
    // quotes, where bash treats the backslash itself as literal.
    if (ch === '\\' && !inSingle) {
      i += 1;
      continue;
    }
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
      continue;
    }
    if (ch === '"' && !inSingle) {
      inDouble = !inDouble;
      continue;
    }

    if (inSingle) continue;

    for (const pat of unlessSingleQuoted) {
      if (str.startsWith(pat, i)) {
        return pat;
      }
    }

    if (inDouble) continue;

    for (const pat of outsideQuotes) {
      if (str.startsWith(pat, i)) {
        return pat;
      }
    }
  }
  return null;
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { input += chunk; });
process.stdin.on('end', () => {
  let data;
  try {
    data = JSON.parse(input);
  } catch {
    return; // malformed JSON -- allow
  }

  if (data.tool_name !== 'Bash') return;

  const command = data.tool_input && data.tool_input.command;
  if (typeof command !== 'string') return;

  const found = findForbidden(command, FORBIDDEN, FORBIDDEN_UNLESS_SINGLE_QUOTED);
  if (!found) return;

  const label = found.trim() || found;
  const isSubstitution = FORBIDDEN_UNLESS_SINGLE_QUOTED.includes(found);
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: isSubstitution
        ? `Command substitution (${label}) runs a second command, even inside double quotes. ` +
          'Write the text to a file and pass the file (node <script>, git commit -F <file>), ' +
          'or use single quotes if the text must stay literal.'
        : `Single-command Bash calls only. Found: ${label}. ` +
          'Use separate Bash calls or dedicated tools (Read, Grep, Glob).',
    },
  };
  process.stdout.write(JSON.stringify(output));
});

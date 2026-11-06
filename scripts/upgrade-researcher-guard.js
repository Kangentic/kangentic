#!/usr/bin/env node
/**
 * PreToolUse hook for the upgrade-researcher agent, declared in that agent's frontmatter, so it binds
 * that agent and nothing else.
 *
 * A research agent reads release notes that anyone can write, about packages that can be minutes old.
 * /upgrade-deps has no age gate, so nothing has looked at those packages before it does. It must read a
 * package and never run one. An instruction did not hold: an agent told to use read-only commands
 * extracted a tarball published hours earlier and loaded it in node to compare exports. So this is an
 * allowlist that fails closed, and a command nobody listed is refused.
 *
 * Bash may read through npm, gh and git. Write may touch only a brief.
 */
const path = require('node:path');

const READ_ONLY_COMMANDS = [
  /^npm view(\s|$)/,
  /^gh api\s/,
  /^gh search\s/,
  /^gh (release|issue|pr) (view|list)(\s|$)/,
  /^git (log|show|grep|diff|rev-parse|ls-tree|ls-files)(\s|$)/,
  /^ls(\s|$)/,
];

/** The one way to read the clock, which a brief's `evaluatedAt` needs. */
const CLOCK_COMMAND = 'node -p "new Date().toISOString()"';

/** `gh api` turns POST on with any of these, so a read must carry none. */
const GH_API_WRITES = /(^|\s)(-X|--method|-f|-F|--field|--raw-field|--input)(\s|=|$)|(^|\s)-X[A-Za-z]/;

/**
 * git writes a file with `--output` on log, show and diff alike, and `git grep -O<program>` runs that
 * program. External diff and textconv drivers come from git config, which this agent cannot write, but
 * refusing the flags keeps a read from depending on that.
 */
const GIT_UNSAFE = /(^|\s)(--output|--open-files-in-pager|-O[^\s]*|--ext-diff|--textconv)(\s|=|$)/;

/**
 * Whether the command does anything past running one program with arguments: a chain, a pipe, a
 * redirect, a background job or a substitution. Allowed programs are only safe alone. A redirect makes
 * any of them a file writer, and `bash-guard.js` catches neither `>` nor an unspaced `|`.
 */
function hasShellSyntax(command) {
  let inSingle = false;
  let inDouble = false;
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (character === '\\' && !inSingle) {
      index += 1;
    } else if (character === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (character === '"' && !inSingle) {
      inDouble = !inDouble;
    } else if (!inSingle) {
      if (character === '`' || command.startsWith('$(', index)) return true;
      if (!inDouble && /[|&;<>\n\r]/.test(character)) return true;
    }
  }
  return false;
}

function bashRefusal(command) {
  const trimmed = command.trim();
  if (trimmed === CLOCK_COMMAND) return null;
  if (hasShellSyntax(trimmed)) {
    return 'One program per call, with no chain, pipe, redirect or substitution. Quote any URL that holds an ampersand.';
  }
  if (!READ_ONLY_COMMANDS.some((pattern) => pattern.test(trimmed))) {
    return `Research reads a package and never runs one, and "${trimmed.split(/\s+/).slice(0, 2).join(' ')}" is not on the read-only list. `
      + 'Use npm view, gh api, gh search, or read release files with WebFetch. '
      + 'Anything that needs a package run or installed goes in `unverified` for the task to prove.';
  }
  if (/^gh api\s/.test(trimmed) && GH_API_WRITES.test(trimmed)) return 'gh api may only read here, so no method or field flags.';
  if (/^git /.test(trimmed) && GIT_UNSAFE.test(trimmed)) return 'git may only read here, so no flag that writes a file or runs a program.';
  return null;
}

function writeRefusal(filePath) {
  const normalized = path.posix.normalize(String(filePath ?? '').replace(/\\/g, '/'));
  if (/\/\.upgrade-deps\/briefs\/[^/]+\.json$/.test(normalized)) return null;
  return 'Research writes only its briefs, at <cache path>/briefs/<group>.json.';
}

/**
 * Why a call is refused, or null to let it through.
 *
 * @param {string} toolName
 * @param {{ command?: unknown, file_path?: unknown }} toolInput
 * @returns {string | null}
 */
function refusalFor(toolName, toolInput) {
  if (toolName === 'Bash') {
    return typeof toolInput?.command === 'string' ? bashRefusal(toolInput.command) : 'A Bash call needs a command.';
  }
  if (toolName === 'Write') return writeRefusal(toolInput?.file_path);
  return null;
}

function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  }));
}

if (require.main === module) {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => { input += chunk; });
  process.stdin.on('end', () => {
    let data;
    try {
      data = JSON.parse(input);
    } catch {
      deny('The guard could not read this call, so it is refused.');
      return;
    }
    const reason = refusalFor(data.tool_name, data.tool_input);
    if (reason !== null) deny(reason);
  });
}

module.exports = { refusalFor };

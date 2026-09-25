import { describe, it, expect } from 'vitest';
import { buildCommand, envPrefix, parseEnvArgs, buildAppleScriptCommand } from '../../scripts/worktree-preview.js';

/**
 * `worktree-preview.js --env KEY=VALUE` splices a variable into the terminal
 * command it launches, because the terminal tab the launcher opens inherits
 * the terminal HOST's environment, not the launcher's. A quoting bug here is
 * silent (the preview launches, the variable is simply wrong or missing), so
 * the shell forms are pinned mechanically.
 */

const WORKTREE = 'C:\\Users\\dev\\repo\\.kangentic\\worktrees\\1';

describe('parseEnvArgs', () => {
  it('collects both spellings, in order, and keeps an = inside the value', () => {
    expect(parseEnvArgs(['node', 'x', '--env', 'A=1', '--env=B=two words', '--env', 'C=a=b'])).toEqual([
      { key: 'A', value: '1' },
      { key: 'B', value: 'two words' },
      { key: 'C', value: 'a=b' },
    ]);
  });

  it('returns an empty list when the flag is absent', () => {
    expect(parseEnvArgs(['node', 'x', '--fresh'])).toEqual([]);
  });

  it('rejects a missing assignment, an invalid key, and characters that would break the quoting', () => {
    expect(() => parseEnvArgs(['--env'])).toThrow(/KEY=VALUE/);
    expect(() => parseEnvArgs(['--env', 'NOVALUE'])).toThrow(/KEY=VALUE/);
    expect(() => parseEnvArgs(['--env', '=1'])).toThrow(/KEY=VALUE/);
    expect(() => parseEnvArgs(['--env', 'BAD-KEY=1'])).toThrow(/not a valid environment variable name/);
    expect(() => parseEnvArgs(['--env', 'A="quoted"'])).toThrow(/may not contain/);
    expect(() => parseEnvArgs(['--env', 'A=x&&calc'])).toThrow(/may not contain/);
    expect(() => parseEnvArgs(['--env', 'A=%PATH%'])).toThrow(/may not contain/);
  });
});

describe('envPrefix', () => {
  const env = [
    { key: 'KANGENTIC_TELEMETRY', value: '1' },
    { key: 'SPACED', value: 'two words' },
  ];

  it('uses the quoted set form for cmd.exe', () => {
    expect(envPrefix(env, 'win32')).toBe('set "KANGENTIC_TELEMETRY=1"&& set "SPACED=two words"&& ');
  });

  it('uses single-quoted assignments for the POSIX shells', () => {
    expect(envPrefix(env, 'darwin')).toBe("KANGENTIC_TELEMETRY='1' SPACED='two words' ");
    expect(envPrefix(env, 'linux')).toBe("KANGENTIC_TELEMETRY='1' SPACED='two words' ");
  });

  it('is empty with no variables', () => {
    expect(envPrefix([], 'win32')).toBe('');
  });
});

describe('buildCommand', () => {
  it('prefixes the dev server command with the variables and keeps the flags', () => {
    const command = buildCommand(WORKTREE, 5188, {
      env: [{ key: 'KANGENTIC_TELEMETRY', value: '1' }],
      platform: 'win32',
    });
    expect(command.startsWith('set "KANGENTIC_TELEMETRY=1"&& node "')).toBe(true);
    expect(command.endsWith('--port=5188 --ephemeral')).toBe(true);
    expect(command).toContain('dev.js');
  });

  it('is unchanged without --env', () => {
    const command = buildCommand(WORKTREE, 5174, { fresh: true, platform: 'win32' });
    expect(command.startsWith('node "')).toBe(true);
    expect(command.endsWith('--port=5174 --ephemeral --fresh')).toBe(true);
  });
});

/**
 * `buildAppleScriptCommand` (openTerminalMac, macOS-only) escapes the same
 * string through two layers: a POSIX shell single-quote around `cwd`, then the
 * whole assembled `cd ... && <command>; exit` line as an AppleScript
 * double-quoted string literal. A quoting bug here is silent - osascript
 * either runs a subtly wrong command or the do-script literal terminates
 * early and Terminal.app runs a truncated fragment - so it is pinned two ways
 * rather than against a handful of copied implementation outputs:
 *
 * 1. A round trip: decoding the AppleScript literal with AppleScript's own
 *    escape rules (`\\` -> `\`, `\"` -> `"`) must reproduce the exact shell
 *    command line, for any cwd/command containing the characters that layer
 *    has to protect (`'`, `"`, `\`).
 * 2. Well-formedness: every `"` inside the extracted literal is preceded by
 *    an odd-length run of backslashes (i.e. actually escaped), so the
 *    do-script string cannot terminate before the real closing quote. The
 *    round trip alone does not catch this - a bare, unescaped `"` still
 *    decodes back to itself byte-for-byte, it just also ends the AppleScript
 *    string early when osascript parses it for real.
 */
describe('buildAppleScriptCommand', () => {
  /** POSIX shell single-quote escaping: the documented, unchanged inner layer. */
  function posixSingleQuote(value: string): string {
    return `'${value.replace(/'/g, "'\\''")}'`;
  }

  /** Inverts the AppleScript escapes the source applies, in the order AppleScript itself reads them. */
  function decodeAppleScriptLiteral(escaped: string): string {
    let result = '';
    for (let i = 0; i < escaped.length; i++) {
      if (escaped[i] === '\\') {
        i += 1;
        result += escaped[i];
      } else {
        result += escaped[i];
      }
    }
    return result;
  }

  /** Pulls the quoted do-script argument out of the full AppleScript text. */
  function extractDoScriptLiteral(script: string): string {
    const match = script.match(/do script "([\s\S]*)"\nend tell$/);
    if (!match) throw new Error(`do script literal not found in:\n${script}`);
    return match[1] as string;
  }

  /** Every `"` in the literal must be preceded by an odd-length backslash run. */
  function everyQuoteIsEscaped(literal: string): boolean {
    for (let i = 0; i < literal.length; i++) {
      if (literal[i] !== '"') continue;
      let run = 0;
      let j = i - 1;
      while (j >= 0 && literal[j] === '\\') { run += 1; j -= 1; }
      if (run % 2 === 0) return false;
    }
    return true;
  }

  function expectRoundTrips(cwd: string, command: string): void {
    const script = buildAppleScriptCommand(cwd, command);
    const literal = extractDoScriptLiteral(script);
    const expectedShellCommand = `cd ${posixSingleQuote(cwd)} && ${command}; exit`;
    expect(decodeAppleScriptLiteral(literal)).toBe(expectedShellCommand);
    expect(everyQuoteIsEscaped(literal)).toBe(true);
  }

  it('wraps a plain cwd/command pair in the expected template', () => {
    const script = buildAppleScriptCommand('/Users/dev/project', 'npm start');
    expect(script.startsWith('tell application "Terminal"\n  activate\n  do script "')).toBe(true);
    expect(script.endsWith('end tell')).toBe(true);
    expectRoundTrips('/Users/dev/project', 'npm start');
  });

  it('round-trips a cwd containing an apostrophe (the shell-quote-escaping backslash must survive doubling)', () => {
    // The discriminating case: the inner POSIX single-quote escaping turns
    // each `'` in cwd into the four characters `'\''`, introducing a
    // backslash the OUTER AppleScript layer must also escape. Skipping that
    // (the pre-fix behavior) lets the decoder consume the apostrophe that
    // follows the backslash and mis-decode the literal.
    expectRoundTrips("/Users/dev/O'Brien Projects", 'npm start');
  });

  it('round-trips a command containing double quotes (buildCommand always quotes devScript this way)', () => {
    expectRoundTrips('/Users/dev/repo', 'node "/Users/dev/repo/scripts/dev.js" --port=5174 --ephemeral');
  });

  it('round-trips a command containing a literal backslash immediately before a quote', () => {
    // Adjacent to a quote is the case that most easily breaks a chain that
    // escapes quotes before backslashes: the backslash must be doubled FIRST,
    // or it would pair with the backslash later added for the quote and
    // leave the quote unescaped.
    expectRoundTrips('/Users/dev/repo', 'echo "trailing\\\\" && npm start');
  });

  it('is well-formed even when cwd itself contains a double quote', () => {
    // Round-tripping alone cannot catch this case (a bare, unescaped `"`
    // decodes back to itself), so this is the well-formedness assertion's
    // reason to exist: the previous implementation never escaped cwd for
    // AppleScript at all, and a `"` in cwd would have terminated the
    // do-script literal early.
    const script = buildAppleScriptCommand('/Users/dev/weird"quote', 'npm start');
    expect(everyQuoteIsEscaped(extractDoScriptLiteral(script))).toBe(true);
  });
});

/**
 * Context-correct escaping for substituted template values.
 *
 * A task title is not always text the user wrote: a task imported from a GitHub
 * issue carries a stranger's title. Substitution used to be context-blind, so
 * that title went raw into a shell script body and into a JSON webhook body
 * alike. These are the cases that made it a bug rather than a nicety.
 */
import { describe, it, expect } from 'vitest';
import {
  applyTemplateEscape,
  escapeForJsonString,
  escapeForUrl,
  stripShellMetacharacters,
} from '../../src/shared/template-escape';
import { resolveShortcutCommand } from '../../src/shared/template-vars';

describe('stripShellMetacharacters', () => {
  it('defuses a title that would chain a second command', () => {
    expect(stripShellMetacharacters('fix; rm -rf ~')).toBe('fix rm -rf ~');
    expect(stripShellMetacharacters('fix && curl evil.example.com')).toBe('fix  curl evil.example.com');
    expect(stripShellMetacharacters('fix `whoami`')).toBe('fix whoami');
    expect(stripShellMetacharacters('fix $(whoami)')).toBe('fix whoami');
    expect(stripShellMetacharacters('fix | tee out')).toBe('fix  tee out');
  });

  it('defuses a newline, which ends a command as surely as a semicolon', () => {
    expect(stripShellMetacharacters('fix\nrm -rf ~')).toBe('fixrm -rf ~');
    expect(stripShellMetacharacters('fix\r\nrm -rf ~')).toBe('fixrm -rf ~');
  });

  it('leaves ordinary prose alone', () => {
    expect(stripShellMetacharacters('Fix the login redirect on Safari 18')).toBe('Fix the login redirect on Safari 18');
  });

  it('is the same on every platform, which is the reason it strips rather than quotes', () => {
    // Correct quoting differs per shell and SessionManager caches one shell for
    // the focused project, so a quoting scheme is right on the machine that
    // picked it and wrong on a teammate's. The lossless path is the
    // KANGENTIC_* environment variables a script also receives.
    const value = 'a "quoted" & piped | value';
    expect(stripShellMetacharacters(value)).toBe(stripShellMetacharacters(value));
    expect(stripShellMetacharacters(value)).not.toContain('"');
  });
});

describe('escapeForJsonString', () => {
  it('keeps a quoted title from breaking the payload', () => {
    const body = `{"title": "${escapeForJsonString('the "quoted" bug')}"}`;
    expect(JSON.parse(body)).toEqual({ title: 'the "quoted" bug' });
  });

  it('escapes backslashes and control characters', () => {
    const body = `{"path": "${escapeForJsonString('C:\\Users\\dev\nnext')}"}`;
    expect(JSON.parse(body)).toEqual({ path: 'C:\\Users\\dev\nnext' });
  });

  it('adds no quotes of its own, because the template already supplies them', () => {
    expect(escapeForJsonString('plain')).toBe('plain');
  });
});

describe('escapeForUrl', () => {
  it('encodes a value that would otherwise add a query parameter', () => {
    expect(escapeForUrl('a&b=c')).toBe('a%26b%3Dc');
    expect(escapeForUrl('a b')).toBe('a%20b');
  });
});

describe('applyTemplateEscape', () => {
  it('passes a raw value through only where the field says it may', () => {
    const value = 'the "quoted" bug & more';
    expect(applyTemplateEscape(value, 'none')).toBe(value);
    expect(applyTemplateEscape(value, 'shell')).not.toBe(value);
    expect(applyTemplateEscape(value, 'json')).not.toBe(value);
    expect(applyTemplateEscape(value, 'url')).not.toBe(value);
  });
});

describe('the Shortcut command system still behaves', () => {
  it('sanitizes the task title and leaves the controlled paths alone', () => {
    // resolveShortcutCommand now shares one definition of the strip with the
    // automations, rather than keeping a private copy.
    const command = resolveShortcutCommand('code "{{cwd}}" # {{taskTitle}}', {
      cwd: 'C:\\Users\\dev\\project',
      branchName: 'feature/x',
      taskTitle: 'fix; rm -rf ~',
      projectPath: 'C:\\Users\\dev\\project',
    });

    expect(command).toBe('code "C:\\Users\\dev\\project" # fix rm -rf ~');
  });
});

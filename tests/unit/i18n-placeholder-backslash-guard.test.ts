import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { i18n, setupI18n } from '@lingui/core';
import { compileMessage } from '@lingui/message-utils/compileMessage';
import { msg } from '@lingui/core/runtime-macro';
import { guardPlaceholderBackslashes } from '../../src/shared/i18n/placeholder-backslash-guard';
import { englishI18n } from '../../src/shared/i18n/english';

// Guards src/shared/i18n/placeholder-backslash-guard.ts: Lingui decodes `\xHH` and
// `\uHHHH` across a message's interpolated result, values included, so a Windows
// path placed in a message lost its backslashes unless every instance is guarded.

const REPO_ROOT = path.resolve(__dirname, '../..');
const WINDOWS_PATH = 'C:\\build\\x64\\app';
const ESCAPED_TITLE = 'Fix \\u00e9 handling';

function freshInstance(messages: Record<string, string> = {}) {
  const instance = setupI18n({ locale: 'en', messages: { en: messages } });
  instance.setMessagesCompiler(compileMessage);
  return instance;
}

describe('placeholder backslash guard', () => {
  it('an unguarded instance rewrites escape sequences inside a placed value (the bug)', () => {
    const instance = freshInstance();
    const projectPath = WINDOWS_PATH;
    expect(instance._(msg`Moved to ${{ projectPath }}`)).toBe('Moved to C:\\buildd\\app');
  });

  it('a guarded instance keeps descriptor values, explicit values and t exactly as given', () => {
    const instance = freshInstance();
    guardPlaceholderBackslashes(instance);
    const projectPath = WINDOWS_PATH;
    const taskTitle = ESCAPED_TITLE;
    expect(instance._(msg`Moved to ${{ projectPath }}`)).toBe(`Moved to ${WINDOWS_PATH}`);
    expect(instance._(msg`Renamed ${{ taskTitle }}`)).toBe(`Renamed ${ESCAPED_TITLE}`);
    expect(instance._('Moved to {projectPath}', { projectPath: WINDOWS_PATH })).toBe(`Moved to ${WINDOWS_PATH}`);
    expect(instance.t(msg`Moved to ${{ projectPath }}`)).toBe(`Moved to ${WINDOWS_PATH}`);
  });

  it('still decodes the translation text itself, which is what the decoding is for', () => {
    const descriptor = msg`Saved`;
    const instance = freshInstance({ [descriptor.id]: 'Gespeichert \\u00e9' });
    guardPlaceholderBackslashes(instance);
    expect(instance._(descriptor)).toBe('Gespeichert \u00e9');
  });

  it('installs once, so a second call does not wrap again', () => {
    const instance = freshInstance();
    guardPlaceholderBackslashes(instance);
    const guarded = instance._;
    guardPlaceholderBackslashes(instance);
    expect(instance._).toBe(guarded);
  });

  it('guards the session instance and the English instance the app uses', () => {
    const projectPath = WINDOWS_PATH;
    expect(i18n._(msg`Moved to ${{ projectPath }}`)).toBe(`Moved to ${WINDOWS_PATH}`);
    expect(englishI18n._(msg`Moved to ${{ projectPath }}`)).toBe(`Moved to ${WINDOWS_PATH}`);
  });

  it('every place that builds an I18n instance guards it', () => {
    // main's global instance cannot be told apart from the renderer's in one vitest
    // process, so these are read from source.
    const sites: Array<{ file: string; call: string }> = [
      { file: 'src/main/i18n/main-i18n.ts', call: 'guardPlaceholderBackslashes(i18n)' },
      { file: 'src/renderer/i18n/catalogs.ts', call: 'guardPlaceholderBackslashes(i18n)' },
      { file: 'src/renderer/i18n/catalogs.ts', call: 'guardPlaceholderBackslashes(localeI18n)' },
      { file: 'src/shared/i18n/english.ts', call: 'guardPlaceholderBackslashes(englishI18n)' },
    ];
    for (const site of sites) {
      const source = fs.readFileSync(path.join(REPO_ROOT, site.file), 'utf8');
      expect(source, `${site.file} must call ${site.call}`).toContain(site.call);
    }
    // A new setupI18n call elsewhere needs the guard too.
    const builders = ['src/main', 'src/renderer', 'src/shared'].flatMap((root) => listSourceFiles(path.join(REPO_ROOT, root)))
      .filter((file) => fs.readFileSync(file, 'utf8').includes('setupI18n('))
      .map((file) => path.relative(REPO_ROOT, file).replace(/\\/g, '/'))
      .sort();
    expect(builders).toEqual(['src/renderer/i18n/catalogs.ts', 'src/shared/i18n/english.ts']);
  });
});

function listSourceFiles(directory: string): string[] {
  const found: string[] = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) found.push(...listSourceFiles(fullPath));
    else if (/\.tsx?$/.test(entry.name)) found.push(fullPath);
  }
  return found;
}

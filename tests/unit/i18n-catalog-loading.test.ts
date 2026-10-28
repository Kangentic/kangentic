/**
 * Catalog loading and the places a catalog's text reaches a formatter.
 *
 * i18n-locales.test.ts covers the pure locale helpers and main's translator; this
 * covers the renderer's catalogs (src/renderer/i18n/catalogs.ts: which PO files
 * load for a locale, and what an unknown or already-active locale does), main's
 * handling of an unreadable compiled catalog, and that `formatDuration` takes its
 * unit letters from the ACTIVE catalog instead of hardcoding English.
 *
 * Translated text here comes from catalogs the test builds itself, so a reviewer
 * correcting a real PO entry cannot break it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { i18n } from '@lingui/core';
import { msg } from '@lingui/core/runtime-macro';
import { compileMessage } from '@lingui/message-utils/compileMessage';
import {
  activateLocale,
  catalogLocale,
  createLocaleI18n,
  loadLocaleMessages,
} from '../../src/renderer/i18n/catalogs';
import { readCompiledCatalog } from '../../src/main/i18n/main-i18n';
import { formatDuration } from '../../src/renderer/utils/format-session';
import type { AppLocale } from '../../src/shared/i18n/locales';

afterEach(() => {
  // The setup file leaves English active; put it back for the tests after.
  i18n.activate('en');
});

describe('catalogLocale', () => {
  it('reads the locale folder out of a catalog path', () => {
    expect(catalogLocale('../../locales/zh-CN/settings.po')).toBe('zh-CN');
    expect(catalogLocale('../../locales/de/src-renderer.po')).toBe('de');
  });

  it('reads a Windows-separated path the same way', () => {
    expect(catalogLocale('..\\..\\locales\\pt-BR\\board.po')).toBe('pt-BR');
  });

  it('answers an empty string for a path with no folder', () => {
    expect(catalogLocale('board.po')).toBe('');
  });
});

describe('loadLocaleMessages', () => {
  const durationMessage = msg`${{ seconds: 4 }}s`;

  it('returns the bundled English messages without loading anything', async () => {
    const messages = await loadLocaleMessages('en');
    expect(messages[durationMessage.id]).toBeDefined();
    // The same merged object every time: English is already in memory.
    expect(await loadLocaleMessages('en')).toBe(messages);
  });

  it('merges the lazily loaded areas of another locale into one object', async () => {
    const messages = await loadLocaleMessages('de');
    expect(messages).toBeTypeOf('object');
    expect(messages).not.toBe(await loadLocaleMessages('en'));
  });

  it('answers an empty catalog for a locale folder that does not exist', async () => {
    expect(await loadLocaleMessages('xx' as AppLocale)).toEqual({});
  });
});

describe('activateLocale', () => {
  it('keeps English for a value that is not an app locale (a hand-edited config)', async () => {
    await activateLocale('klingon' as AppLocale);
    expect(i18n.locale).toBe('en');
    await activateLocale(undefined as unknown as AppLocale);
    expect(i18n.locale).toBe('en');
  });

  it('does nothing when the locale is already active', async () => {
    const before = i18n.messages;
    await activateLocale('en');
    expect(i18n.locale).toBe('en');
    expect(i18n.messages).toBe(before);
  });

  it('loads and activates another app locale', async () => {
    await activateLocale('de');
    expect(i18n.locale).toBe('de');
  });
});

describe('createLocaleI18n', () => {
  it('builds a second instance for one locale and leaves the session language alone', async () => {
    const other = await createLocaleI18n('de');
    expect(other.locale).toBe('de');
    expect(other).not.toBe(i18n);
    expect(i18n.locale).toBe('en');
  });
});

describe("main's compiled catalog reader", () => {
  const temporaryDirectories: string[] = [];

  function directoryWith(fileName: string, contents: string): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'kangentic-compiled-catalog-'));
    temporaryDirectories.push(directory);
    fs.writeFileSync(path.join(directory, fileName), contents);
    return directory;
  }

  afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
  });

  it('returns the messages of a well-formed catalog', () => {
    const directory = directoryWith('de.json', JSON.stringify({ messages: { abc: 'Hallo' } }));
    expect(readCompiledCatalog(directory, 'de')).toEqual({ abc: 'Hallo' });
  });

  it('answers null for a missing file, so the session starts in English', () => {
    const directory = directoryWith('fr.json', JSON.stringify({ messages: {} }));
    expect(readCompiledCatalog(directory, 'de')).toBeNull();
  });

  it('answers null for a file that is not valid JSON', () => {
    expect(readCompiledCatalog(directoryWith('de.json', '{ not json'), 'de')).toBeNull();
  });

  it('answers null for JSON without a messages object', () => {
    expect(readCompiledCatalog(directoryWith('de.json', JSON.stringify({ other: 1 })), 'de')).toBeNull();
    expect(readCompiledCatalog(directoryWith('de.json', JSON.stringify({ messages: 'text' })), 'de')).toBeNull();
    expect(readCompiledCatalog(directoryWith('de.json', 'null'), 'de')).toBeNull();
  });
});

describe('formatDuration under the active catalog', () => {
  // The unit letters are catalog text ("h", "m", "s"), so a language that writes them
  // differently must reach the output. The ids come from the same descriptors the
  // formatter declares, so this does not depend on a shipped translation.
  const hoursAndMinutes = msg`${{ hours: 1 }}h ${{ minutes: 1 }}m`;
  const minutesAndSeconds = msg`${{ minutes: 1 }}m ${{ seconds: 1 }}s`;
  const secondsOnly = msg`${{ seconds: 1 }}s`;

  it('reads English with the English catalog', () => {
    expect(formatDuration(90 * 60_000)).toBe('1h 30m');
    expect(formatDuration(4 * 60_000 + 12_000)).toBe('4m 12s');
    expect(formatDuration(9_000)).toBe('9s');
  });

  it('takes the unit letters from the active language', () => {
    i18n.setMessagesCompiler(compileMessage);
    i18n.loadAndActivate({
      locale: 'de',
      messages: {
        [hoursAndMinutes.id]: '{hours} Std. {minutes} Min.',
        [minutesAndSeconds.id]: '{minutes} Min. {seconds} Sek.',
        [secondsOnly.id]: '{seconds} Sek.',
      },
    });

    expect(formatDuration(90 * 60_000)).toBe('1 Std. 30 Min.');
    expect(formatDuration(4 * 60_000 + 12_000)).toBe('4 Min. 12 Sek.');
    expect(formatDuration(9_000)).toBe('9 Sek.');
  });
});

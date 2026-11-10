import { describe, expect, it } from 'vitest';
import { deriveGeminiAccountSettings, parseGeminiSettings } from '../../src/main/agent/adapters/gemini/accounts';

describe('parseGeminiSettings', () => {
  it('does not read // after an escaped quote inside a string as a comment', () => {
    const parsed = parseGeminiSettings(String.raw`{"note": "say \" // still text", "count": 1}`);
    expect(parsed).toEqual({ note: 'say " // still text', count: 1 });
  });

  it('drops an unterminated block comment to the end of the text', () => {
    expect(parseGeminiSettings('{"count": 1} /* never closed')).toEqual({ count: 1 });
    expect(parseGeminiSettings('{"count": 1, /* never closed')).toBeNull();
  });
});

describe('deriveGeminiAccountSettings', () => {
  it('drops security when it held only auth.selectedType and the account has none', () => {
    const next = deriveGeminiAccountSettings({ security: { auth: { selectedType: 'gemini-api-key' } }, theme: 'dark' }, {});
    expect(next).toEqual({ theme: 'dark' });
    expect(next).not.toHaveProperty('security');
  });

  it('keeps security without the selection when it holds another key', () => {
    const next = deriveGeminiAccountSettings(
      { security: { auth: { selectedType: 'gemini-api-key' }, folderTrust: { enabled: true } } },
      {},
    );
    expect(next).toEqual({ security: { folderTrust: { enabled: true } } });
  });

  it('puts the account own selection in place of the user one', () => {
    const next = deriveGeminiAccountSettings(
      { security: { auth: { selectedType: 'gemini-api-key' } } },
      { security: { auth: { selectedType: 'oauth-personal' } } },
    );
    expect(next).toEqual({ security: { auth: { selectedType: 'oauth-personal' } } });
  });
});

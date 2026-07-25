import { describe, expect, it } from 'vitest';
import { EXTERNAL_OPEN_SCHEMES, TERMINAL_LINK_SCHEMES, isAllowedExternalUrl } from '../../src/shared/external-url';

describe('isAllowedExternalUrl', () => {
  describe('TERMINAL_LINK_SCHEMES (http/https only)', () => {
    it.each([
      ['http', 'http://localhost:3000'],
      ['https', 'https://kangentic.com/docs'],
    ])('accepts %s URLs', (_label, url) => {
      expect(isAllowedExternalUrl(url, TERMINAL_LINK_SCHEMES)).toBe(true);
    });

    it.each([
      ['mailto', 'mailto:someone@example.com'],
      ['javascript', 'javascript:alert(1)'],
      ['file', 'file:///etc/passwd'],
      ['data', 'data:text/html,<script>alert(1)</script>'],
      ['a windows protocol handler', 'ms-msdt:/id PCWDiagnostic'],
      ['empty string', ''],
      ['a relative path', './foo.md'],
      ['an unparseable string', 'not a url'],
    ])('rejects %s', (_label, url) => {
      expect(isAllowedExternalUrl(url, TERMINAL_LINK_SCHEMES)).toBe(false);
    });
  });

  // The allowlist compares against `URL.protocol`, which the WHATWG spec
  // lowercases and which is only reached after the parser strips leading and
  // trailing whitespace plus embedded TAB/CR/LF. Both behaviors are load-bearing
  // for the scheme check, so pin them rather than rely on recalled spec
  // semantics surviving a future Node/ada-url change.
  describe('scheme normalization boundary', () => {
    it.each([
      ['an uppercase scheme', 'HTTPS://kangentic.com/docs'],
      ['a mixed-case scheme', 'HtTp://localhost:3000'],
      ['a whitespace-padded URL', '  https://kangentic.com/docs  '],
    ])('still accepts %s', (_label, url) => {
      expect(isAllowedExternalUrl(url, TERMINAL_LINK_SCHEMES)).toBe(true);
    });

    it.each([
      ['a mixed-case javascript scheme', 'JavaScript:alert(1)'],
      ['a TAB-obfuscated javascript scheme', 'java\tscript:alert(1)'],
      ['a newline-obfuscated javascript scheme', 'java\nscript:alert(1)'],
    ])('still rejects %s', (_label, url) => {
      expect(isAllowedExternalUrl(url, TERMINAL_LINK_SCHEMES)).toBe(false);
      expect(isAllowedExternalUrl(url, EXTERNAL_OPEN_SCHEMES)).toBe(false);
    });
  });

  describe('EXTERNAL_OPEN_SCHEMES (http/https/mailto)', () => {
    it.each([
      ['http', 'http://localhost:3000'],
      ['https', 'https://kangentic.com/docs'],
      ['mailto', 'mailto:someone@example.com'],
    ])('accepts %s URLs', (_label, url) => {
      expect(isAllowedExternalUrl(url, EXTERNAL_OPEN_SCHEMES)).toBe(true);
    });

    it.each([
      ['javascript', 'javascript:alert(1)'],
      ['file', 'file:///etc/passwd'],
      ['data', 'data:text/html,<script>alert(1)</script>'],
      ['a windows protocol handler', 'ms-msdt:/id PCWDiagnostic'],
      ['empty string', ''],
      ['an unparseable string', 'not a url'],
    ])('rejects %s', (_label, url) => {
      expect(isAllowedExternalUrl(url, EXTERNAL_OPEN_SCHEMES)).toBe(false);
    });
  });
});

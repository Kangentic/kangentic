/**
 * Unit tests for src/shared/relay.ts.
 *
 * Three invariants are load-bearing here and get their own dedicated cases:
 * (1) validateRelayUrl delegates its TLS/loopback decision to the protocol
 * package's isSecureRelayAddress rather than reimplementing it with
 * new URL().hostname comparisons - a hostname-based rewrite would silently
 * accept relay addresses the shipped mobile app rejects, which is the exact
 * "QR the phone silently refuses" bug this module exists to prevent. (2)
 * resolveRelayUrl always returns either a normalized-and-valid URL or a
 * hardcoded constant, never a raw/un-normalized stored string - so a value
 * saved before this schema existed, or written with WHATWG's IPv4/IPv6
 * canonicalizations, can never reach the pairing QR unnormalized. (3)
 * relayMode: 'local' resolves to plaintext loopback ONLY in a dev build.
 * `mobileBridge.*` is global config in a shared configDir, so a value saved
 * from a dev build (or hand-edited) can reach a production build on the same
 * machine; resolveRelayUrl must fall through to the hosted relay there
 * rather than dialing ws://127.0.0.1:8080.
 *
 * KANGENTIC_HOSTED_RELAY_URL and LOCAL_DEV_RELAY_URL are themselves
 * build-mode-independent constants - only what 'local' MODE resolves TO
 * depends on __KANGENTIC_DEV__ (invariant 3 above), which vitest.config.ts
 * pins to `false`, so this suite exercises the production branch: the
 * 'local' case below asserts the hosted fallback, not loopback. The dev
 * branch (an actual `npm start` session resolving to loopback) is exercised
 * by tests/ui/mobile-devices-settings.spec.ts, whose webServer runs in dev
 * mode.
 */
import { describe, expect, it } from 'vitest';
import {
  KANGENTIC_HOSTED_RELAY_URL,
  LOCAL_DEV_RELAY_URL,
  relayHealthUrl,
  resolveRelayUrl,
  validateRelayUrl,
} from '../../src/shared/relay';
import { MAX_RELAY_ADDRESS_LENGTH, isSecureRelayAddress } from '../../packages/protocol/src/pairing/relay-address';
import type { AppConfig } from '../../src/shared/types';

describe('relay constants', () => {
  it('are each a secure relay address', () => {
    expect(isSecureRelayAddress(KANGENTIC_HOSTED_RELAY_URL)).toBe(true);
    expect(isSecureRelayAddress(LOCAL_DEV_RELAY_URL)).toBe(true);
  });
});

describe('validateRelayUrl', () => {
  describe('accepts', () => {
    it.each([
      ['trailing slash', 'wss://relay.kangentic.com/', 'wss://relay.kangentic.com/'],
      ['explicit port', 'wss://relay.kangentic.com:8443', 'wss://relay.kangentic.com:8443/'],
      ['a path', 'wss://relay.kangentic.com/relay', 'wss://relay.kangentic.com/relay'],
      ['an existing query string', 'wss://relay.kangentic.com?token=abc', 'wss://relay.kangentic.com/?token=abc'],
      ['ws:// localhost', 'ws://localhost:8080', 'ws://localhost:8080/'],
      ['ws:// 127.0.0.1', 'ws://127.0.0.1:8080', 'ws://127.0.0.1:8080/'],
      ['ws:// bracketed IPv6 loopback', 'ws://[::1]:8080', 'ws://[::1]:8080/'],
      ['surrounding whitespace', '  wss://relay.kangentic.com  ', 'wss://relay.kangentic.com/'],
      ['uppercase scheme', 'WSS://relay.kangentic.com', 'wss://relay.kangentic.com/'],
    ])('%s', (_label, input, expectedNormalized) => {
      const result = validateRelayUrl(input);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.normalized).toBe(expectedNormalized);
    });
  });

  describe('accepts and normalizes WHATWG IPv4/IPv6 canonicalizations', () => {
    // These are exactly the cases where checking the RAW string would accept
    // something the phone's isSecureRelayAddress prefix rule then rejects -
    // normalizing first (and persisting/embedding the normalized form) is
    // what keeps the desktop and the phone in agreement.
    it.each([
      ['decimal IPv4', 'ws://2130706433', 'ws://127.0.0.1/'],
      ['hex IPv4', 'ws://0x7f.0.0.1', 'ws://127.0.0.1/'],
      ['short-form IPv4', 'ws://127.1', 'ws://127.0.0.1/'],
      ['trailing-dot IPv4', 'ws://127.0.0.1.', 'ws://127.0.0.1/'],
      ['expanded IPv6 loopback', 'ws://[0:0:0:0:0:0:0:1]:8080', 'ws://[::1]:8080/'],
    ])('%s', (_label, input, expectedNormalized) => {
      const result = validateRelayUrl(input);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.normalized).toBe(expectedNormalized);
        expect(isSecureRelayAddress(result.normalized)).toBe(true);
      }
    });
  });

  describe('applies the byte cap to the normalized value, not just the raw draft', () => {
    // Regression: the cap was checked only against `raw`. Normalization can
    // GROW the string (an authority-only URL gains a trailing '/'), so a raw
    // input sitting exactly at the cap normalized to one byte over it and was
    // still returned as ok. That over-cap value got persisted and embedded in
    // the pairing QR, and then failed this very check on every later
    // resolveRelayUrl() - silently falling back to the hosted relay with no
    // error anywhere in the UI, because the custom-mode branch does not render
    // the resolved-URL pill and the draft error was cleared at commit time.
    it('rejects a raw input at the cap whose normalized form exceeds it', () => {
      const rawAtExactlyTheCap = 'wss://' + 'a'.repeat(MAX_RELAY_ADDRESS_LENGTH - 'wss://'.length);
      expect(new TextEncoder().encode(rawAtExactlyTheCap).length).toBe(MAX_RELAY_ADDRESS_LENGTH);
      expect(new TextEncoder().encode(new URL(rawAtExactlyTheCap).href).length).toBe(MAX_RELAY_ADDRESS_LENGTH + 1);

      expect(validateRelayUrl(rawAtExactlyTheCap).ok).toBe(false);
    });

    it('still accepts a raw input whose normalized form lands exactly on the cap', () => {
      const rawOneUnderTheCap = 'wss://' + 'a'.repeat(MAX_RELAY_ADDRESS_LENGTH - 'wss://'.length - 1);
      const result = validateRelayUrl(rawOneUnderTheCap);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(new TextEncoder().encode(result.normalized).length).toBe(MAX_RELAY_ADDRESS_LENGTH);
      }
    });
  });

  describe('rejects', () => {
    it.each([
      ['a hostname that merely starts with localhost (the boundary case)', 'ws://localhost.evil.com'],
      ['a trailing-dot domain (dot preserved, unlike IPv4)', 'ws://localhost.'],
      ['userinfo even when the host is loopback', 'ws://evil.com@localhost/'],
      ['a plain non-loopback ws:// address', 'ws://evil.com'],
      ['127.0.0.2 (in 127/8 but outside the exact loopback allowlist)', 'ws://127.0.0.2'],
      ['0.0.0.0', 'ws://0.0.0.0'],
      ['https scheme', 'https://relay.kangentic.com'],
      ['http scheme, even for localhost', 'http://localhost:8080'],
      ['a #fragment', 'wss://relay.kangentic.com/#frag'],
      ['a raw backslash', 'ws:\\\\localhost\\'],
      ['no scheme', 'relay.kangentic.com'],
      ['empty string', ''],
      ['whitespace only', '   '],
      ['unparseable garbage', 'not a url'],
    ])('%s', (_label, input) => {
      const result = validateRelayUrl(input);
      expect(result.ok).toBe(false);
    });

    it('an oversized URL (over 512 bytes)', () => {
      const result = validateRelayUrl('wss://' + 'a'.repeat(600));
      expect(result.ok).toBe(false);
    });

    it('a URL under 512 characters but over 512 bytes (multi-byte)', () => {
      const relayUrl = 'wss://' + '€'.repeat(200);
      expect(relayUrl.length).toBeLessThan(512);
      const result = validateRelayUrl(relayUrl);
      expect(result.ok).toBe(false);
    });
  });
});

describe('resolveRelayUrl', () => {
  it('resolves to the hosted relay when mobileBridge is undefined', () => {
    expect(resolveRelayUrl(undefined)).toBe(KANGENTIC_HOSTED_RELAY_URL);
  });

  it('resolves to the hosted relay when relayMode is unset and relayUrl is empty', () => {
    const bridge: AppConfig['mobileBridge'] = { enabled: true };
    expect(resolveRelayUrl(bridge)).toBe(KANGENTIC_HOSTED_RELAY_URL);
  });

  it('resolves to the hosted relay when relayMode is explicitly "hosted", even with a relayUrl set', () => {
    const bridge: AppConfig['mobileBridge'] = { relayMode: 'hosted', relayUrl: 'wss://ignored.example.com' };
    expect(resolveRelayUrl(bridge)).toBe(KANGENTIC_HOSTED_RELAY_URL);
  });

  it('resolves relayMode "local" to the hosted relay, not loopback, in a production build (__KANGENTIC_DEV__ = false)', () => {
    const bridge: AppConfig['mobileBridge'] = { relayMode: 'local', relayUrl: 'wss://ignored.example.com' };
    expect(resolveRelayUrl(bridge)).toBe(KANGENTIC_HOSTED_RELAY_URL);
  });

  it('infers "custom" when relayMode is unset but relayUrl is a saved value (pre-resolver schema)', () => {
    const bridge: AppConfig['mobileBridge'] = { relayUrl: 'wss://legacy.example.com' };
    expect(resolveRelayUrl(bridge)).toBe('wss://legacy.example.com/');
  });

  it('falls back to the hosted relay when the inferred-custom legacy value is invalid, rather than returning it raw', () => {
    const bridge: AppConfig['mobileBridge'] = { relayUrl: 'not-a-url' };
    expect(resolveRelayUrl(bridge)).toBe(KANGENTIC_HOSTED_RELAY_URL);
  });

  it('falls back to the hosted relay when relayMode is "custom" but relayUrl is empty - never returns ""', () => {
    const bridge: AppConfig['mobileBridge'] = { relayMode: 'custom', relayUrl: '' };
    const resolved = resolveRelayUrl(bridge);
    expect(resolved).not.toBe('');
    expect(resolved).toBe(KANGENTIC_HOSTED_RELAY_URL);
  });

  it('falls back to the hosted relay when relayMode is "custom" but relayUrl is invalid', () => {
    const bridge: AppConfig['mobileBridge'] = { relayMode: 'custom', relayUrl: 'ws://not-loopback.example.com' };
    expect(resolveRelayUrl(bridge)).toBe(KANGENTIC_HOSTED_RELAY_URL);
  });

  it('returns the normalized custom URL, not the stored value verbatim', () => {
    const bridge: AppConfig['mobileBridge'] = { relayMode: 'custom', relayUrl: 'WSS://Relay.Example.com' };
    expect(resolveRelayUrl(bridge)).toBe('wss://relay.example.com/');
  });

  it('resolves a raw un-normalized stored value to its normalized form - the invariant that keeps a raw string out of the QR', () => {
    const bridge: AppConfig['mobileBridge'] = { relayMode: 'custom', relayUrl: 'ws://127.1' };
    expect(resolveRelayUrl(bridge)).toBe('ws://127.0.0.1/');
  });
});

describe('relayHealthUrl', () => {
  it('maps wss -> https and appends /healthz', () => {
    expect(relayHealthUrl('wss://relay.kangentic.com')).toBe('https://relay.kangentic.com/healthz');
  });

  it('maps ws -> http and preserves the port', () => {
    expect(relayHealthUrl('ws://127.0.0.1:8080')).toBe('http://127.0.0.1:8080/healthz');
  });

  it('does not produce a double slash for a trailing-slash input', () => {
    expect(relayHealthUrl('wss://relay.kangentic.com/')).toBe('https://relay.kangentic.com/healthz');
  });

  it('preserves an existing query string (a self-hosted relay may be token-gated)', () => {
    expect(relayHealthUrl('wss://relay.kangentic.com?token=abc')).toBe('https://relay.kangentic.com/healthz?token=abc');
  });
});

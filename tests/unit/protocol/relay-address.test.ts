/**
 * Unit tests for packages/protocol/src/pairing/relay-address.ts.
 *
 * This module mirrors the mobile app's src/pairing/qr.ts relay-address
 * check byte-for-byte, and MUST stay dependency-free: it is deep-imported
 * by src/shared/relay.ts, which the renderer bundles, and pulling in the
 * rest of the protocol package (crypto/primitives -> @noble/*) would drag
 * Noise crypto into the renderer bundle for no reason. The import-list
 * assertion below is what actually keeps that true - nothing else does.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isSecureRelayAddress, MAX_RELAY_ADDRESS_LENGTH } from '../../../packages/protocol/src/pairing/relay-address';

describe('MAX_RELAY_ADDRESS_LENGTH', () => {
  it('equals the protocol package byte cap', () => {
    expect(MAX_RELAY_ADDRESS_LENGTH).toBe(512);
  });
});

describe('isSecureRelayAddress', () => {
  it('accepts any wss:// address', () => {
    expect(isSecureRelayAddress('wss://relay.kangentic.com')).toBe(true);
    expect(isSecureRelayAddress('wss://relay.kangentic.com/?slot=abc')).toBe(true);
    expect(isSecureRelayAddress('wss://my-self-hosted-relay.example.com:9443')).toBe(true);
  });

  it('accepts ws:// only for an exact loopback host, with a boundary check', () => {
    expect(isSecureRelayAddress('ws://localhost')).toBe(true);
    expect(isSecureRelayAddress('ws://localhost:8080')).toBe(true);
    expect(isSecureRelayAddress('ws://localhost/path')).toBe(true);
    expect(isSecureRelayAddress('ws://localhost?slot=abc')).toBe(true);
    expect(isSecureRelayAddress('ws://127.0.0.1')).toBe(true);
    expect(isSecureRelayAddress('ws://127.0.0.1:8080')).toBe(true);
    expect(isSecureRelayAddress('ws://[::1]')).toBe(true);
    expect(isSecureRelayAddress('ws://[::1]:8080')).toBe(true);
  });

  it('rejects a hostname that merely starts with a loopback prefix (the boundary case)', () => {
    expect(isSecureRelayAddress('ws://localhost.evil.com')).toBe(false);
    expect(isSecureRelayAddress('ws://127.0.0.1.evil.com')).toBe(false);
    expect(isSecureRelayAddress('ws://[::1]evil.com')).toBe(false);
  });

  it('rejects a plain non-loopback ws:// address', () => {
    expect(isSecureRelayAddress('ws://relay.kangentic.com')).toBe(false);
    expect(isSecureRelayAddress('ws://my-server.example.com')).toBe(false);
    expect(isSecureRelayAddress('ws://0.0.0.0')).toBe(false);
    expect(isSecureRelayAddress('ws://127.0.0.2')).toBe(false);
  });

  it('rejects a non-ws(s) scheme entirely', () => {
    expect(isSecureRelayAddress('https://relay.kangentic.com')).toBe(false);
    expect(isSecureRelayAddress('http://localhost:8080')).toBe(false);
    expect(isSecureRelayAddress('not a url')).toBe(false);
    expect(isSecureRelayAddress('')).toBe(false);
  });
});

describe('relay-address.ts dependency-free leaf invariant', () => {
  it('imports nothing', () => {
    const filePath = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../packages/protocol/src/pairing/relay-address.ts');
    const source = fs.readFileSync(filePath, 'utf-8');
    const importLines = source.split('\n').filter((line) => /^\s*import\s/.test(line));
    expect(importLines).toEqual([]);
  });
});

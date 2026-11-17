/**
 * The kangentic.com token handoff, desktop side: the `state` the service reads
 * and the sealed payload it sends back.
 *
 * What a user loses without each case: a state the service's `parseState`
 * refuses leaves the browser on a plain 400 page while Kangentic waits out its
 * timeout; a payload the desktop cannot open fails every Sign in with Atlassian
 * or Trello; and a payload that opens for the wrong nonce or info would let one
 * attempt's answer finish another.
 *
 * The service side (`helpers/kangentic-token-service.ts`) is a port of
 * kangentic.com's `seal.ts` on WebCrypto, the pairing production runs.
 */
import { describe, it, expect } from 'vitest';
import {
  JIRA_SEAL_INFO,
  TRELLO_SEAL_INFO,
  SealedPayloadError,
  createSealedSignInKeys,
} from '../../src/main/boards/shared/sealed-token';
import { parseState, seal } from './helpers/kangentic-token-service';

/** Atlassian's token answer as it comes, extra keys included. */
const ATLASSIAN_ANSWER = JSON.stringify({
  access_token: 'atlassian-access',
  refresh_token: 'atlassian-refresh',
  expires_in: 3600,
  scope: 'read:jira-work offline_access',
  token_type: 'Bearer',
});

describe('the sign-in state', () => {
  it('passes the service check, with exactly port, pub and nonce', async () => {
    const keys = createSealedSignInKeys();
    const state = keys.stateFor(51234);
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(state.length).toBeLessThanOrEqual(1024);
    const parsed = await parseState(state);
    expect(parsed).not.toBeNull();
    expect(parsed?.port).toBe(51234);
    expect(parsed?.nonce).toBe(keys.nonce);
    const decoded = JSON.parse(Buffer.from(state, 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(Object.keys(decoded).sort()).toEqual(['nonce', 'port', 'pub']);
    expect(typeof decoded.port).toBe('number');
  });

  it('refuses a port the service would refuse', () => {
    const keys = createSealedSignInKeys();
    expect(() => keys.stateFor(80)).toThrow(RangeError);
    expect(() => keys.stateFor(70000)).toThrow(RangeError);
  });

  it('gives each attempt its own key and nonce', () => {
    const first = createSealedSignInKeys();
    const second = createSealedSignInKeys();
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.stateFor(50000)).not.toBe(second.stateFor(50000));
  });
});

describe('opening a sealed payload', () => {
  it("opens Atlassian's answer sealed for Jira, byte for byte", async () => {
    const keys = createSealedSignInKeys();
    const state = await parseState(keys.stateFor(50001));
    const payload = await seal(ATLASSIAN_ANSWER, state!, JIRA_SEAL_INFO);
    expect(keys.open(payload, JIRA_SEAL_INFO)).toBe(ATLASSIAN_ANSWER);
  });

  it('opens a Trello token sealed by the return page', async () => {
    const keys = createSealedSignInKeys();
    const state = await parseState(keys.stateFor(50002));
    const payload = await seal(JSON.stringify({ token: 'trello-token' }), state!, TRELLO_SEAL_INFO);
    expect(JSON.parse(keys.open(payload, TRELLO_SEAL_INFO))).toEqual({ token: 'trello-token' });
  });

  it('refuses a payload sealed for another attempt', async () => {
    const mine = createSealedSignInKeys();
    const other = createSealedSignInKeys();
    const otherState = await parseState(other.stateFor(50003));
    const payload = await seal(ATLASSIAN_ANSWER, otherState!, JIRA_SEAL_INFO);
    expect(() => mine.open(payload, JIRA_SEAL_INFO)).toThrow(SealedPayloadError);
  });

  it('refuses a payload sealed with my key but another nonce', async () => {
    const keys = createSealedSignInKeys();
    const state = await parseState(keys.stateFor(50004));
    const otherSalt = globalThis.crypto.getRandomValues(new Uint8Array(32));
    const payload = await seal(ATLASSIAN_ANSWER, { ...state!, salt: otherSalt }, JIRA_SEAL_INFO);
    expect(() => keys.open(payload, JIRA_SEAL_INFO)).toThrow(SealedPayloadError);
  });

  it("refuses a Jira payload opened as Trello's", async () => {
    const keys = createSealedSignInKeys();
    const state = await parseState(keys.stateFor(50005));
    const payload = await seal(ATLASSIAN_ANSWER, state!, JIRA_SEAL_INFO);
    expect(() => keys.open(payload, TRELLO_SEAL_INFO)).toThrow(SealedPayloadError);
  });

  it('refuses a payload with one ciphertext byte changed', async () => {
    const keys = createSealedSignInKeys();
    const state = await parseState(keys.stateFor(50006));
    const bytes = Buffer.from(await seal(ATLASSIAN_ANSWER, state!, JIRA_SEAL_INFO), 'base64url');
    bytes[65 + 12 + 3] ^= 0x01;
    expect(() => keys.open(bytes.toString('base64url'), JIRA_SEAL_INFO)).toThrow(SealedPayloadError);
  });

  it('refuses a payload cut short or not base64url', () => {
    const keys = createSealedSignInKeys();
    expect(() => keys.open('AAAA', JIRA_SEAL_INFO)).toThrow(SealedPayloadError);
    expect(() => keys.open('not base64url!', JIRA_SEAL_INFO)).toThrow(SealedPayloadError);
  });
});

describe('the nonce check', () => {
  it('matches only the nonce this attempt sent', () => {
    const keys = createSealedSignInKeys();
    expect(keys.nonceMatches(keys.nonce)).toBe(true);
    expect(keys.nonceMatches(null)).toBe(false);
    expect(keys.nonceMatches('')).toBe(false);
    expect(keys.nonceMatches(createSealedSignInKeys().nonce)).toBe(false);
    expect(keys.nonceMatches(`${keys.nonce}x`)).toBe(false);
  });
});

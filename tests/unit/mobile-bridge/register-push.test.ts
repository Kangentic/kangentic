/**
 * Unit tests for src/main/mobile-bridge/handlers/register-push.ts
 *
 * The load-bearing property: the registration is keyed by the
 * REQUESTING session's authenticated deviceId, never by anything in the
 * payload, so one device can never register or unregister another. Also
 * covered: the register/unregister round trip, the 32-byte push-key
 * validation, and the missing-field rejections (which surface as a
 * thrown protocol-parser error, matching how the capability router turns
 * handler throws into error responses).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CapabilityRequestMessage } from '@kangentic/protocol';
import { handleRegisterPush } from '../../../src/main/mobile-bridge/handlers/register-push';
import type { PushRegistrationStore } from '../../../src/main/mobile-bridge/push/push-registration-store';

function fakeRequest(payload: Record<string, unknown>): CapabilityRequestMessage {
  return { type: 'capability-request', requestId: 'req-1', verb: 'register-push', payload };
}

const VALID_KEY_BASE64 = Buffer.alloc(32, 7).toString('base64url');

describe('handleRegisterPush', () => {
  let upsert: ReturnType<typeof vi.fn>;
  let remove: ReturnType<typeof vi.fn>;
  let store: PushRegistrationStore;

  beforeEach(() => {
    upsert = vi.fn();
    remove = vi.fn();
    store = { upsert, remove } as unknown as PushRegistrationStore;
  });

  it('register upserts under the requesting session deviceId and responds registered true', () => {
    const response = handleRegisterPush(
      fakeRequest({ action: 'register', expoPushToken: 'ExponentPushToken[abc]', pushKeyBase64: VALID_KEY_BASE64, platform: 'ios' }),
      { deviceId: 'device-1' },
      store,
    );

    expect(response.ok).toBe(true);
    expect(response.payload).toEqual({ registered: true });
    expect(upsert).toHaveBeenCalledTimes(1);
    const [deviceId, registration] = upsert.mock.calls[0] as [string, { expoPushToken: string; pushKeyHex: string; platform: string; registeredAt: string }];
    expect(deviceId).toBe('device-1');
    expect(registration.expoPushToken).toBe('ExponentPushToken[abc]');
    expect(registration.pushKeyHex).toBe('07'.repeat(32));
    expect(registration.platform).toBe('ios');
    expect(typeof registration.registeredAt).toBe('string');
  });

  it('threads the requested categories through to the store, and omits it when absent', () => {
    handleRegisterPush(
      fakeRequest({ action: 'register', expoPushToken: 'tok', pushKeyBase64: VALID_KEY_BASE64, categories: ['turn-complete', 'session-failed'] }),
      { deviceId: 'device-1' },
      store,
    );
    expect((upsert.mock.calls[0][1] as { categories?: string[] }).categories).toEqual(['turn-complete', 'session-failed']);

    handleRegisterPush(fakeRequest({ action: 'register', expoPushToken: 'tok', pushKeyBase64: VALID_KEY_BASE64 }), { deviceId: 'device-1' }, store);
    expect((upsert.mock.calls[1][1] as { categories?: string[] }).categories).toBeUndefined();
  });

  it('platform defaults to android when omitted', () => {
    handleRegisterPush(
      fakeRequest({ action: 'register', expoPushToken: 'tok', pushKeyBase64: VALID_KEY_BASE64 }),
      { deviceId: 'device-1' },
      store,
    );
    expect((upsert.mock.calls[0][1] as { platform: string }).platform).toBe('android');
  });

  it('unregister removes the requesting device and responds registered false', () => {
    const response = handleRegisterPush(fakeRequest({ action: 'unregister' }), { deviceId: 'device-1' }, store);
    expect(response.ok).toBe(true);
    expect(response.payload).toEqual({ registered: false });
    expect(remove).toHaveBeenCalledWith('device-1');
    expect(upsert).not.toHaveBeenCalled();
  });

  it('rejects a register missing the token or the key (protocol parser throws)', () => {
    expect(() => handleRegisterPush(fakeRequest({ action: 'register', pushKeyBase64: VALID_KEY_BASE64 }), { deviceId: 'device-1' }, store)).toThrow(
      /expoPushToken/,
    );
    expect(() => handleRegisterPush(fakeRequest({ action: 'register', expoPushToken: 'tok' }), { deviceId: 'device-1' }, store)).toThrow(
      /pushKeyBase64/,
    );
    expect(upsert).not.toHaveBeenCalled();
  });

  it('rejects a push key of the wrong length', () => {
    const shortKey = Buffer.alloc(16, 7).toString('base64url');
    expect(() =>
      handleRegisterPush(fakeRequest({ action: 'register', expoPushToken: 'tok', pushKeyBase64: shortKey }), { deviceId: 'device-1' }, store),
    ).toThrow(/32 bytes/);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('rejects an unknown action', () => {
    expect(() => handleRegisterPush(fakeRequest({ action: 'renew' }), { deviceId: 'device-1' }, store)).toThrow(/action/);
  });
});

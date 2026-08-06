import { randomBytes } from '@kangentic/protocol';

/** ~10 minutes, per the research doc's pairing ceremony design. */
export const PAIRING_TOKEN_TTL_MS = 10 * 60 * 1000;

export interface PairingToken {
  /** 32 bytes, used directly as the Noise PSK - see crypto/pairing-handshake.ts. */
  token: Uint8Array;
  createdAt: number;
  expiresAt: number;
  /**
   * Single-use: set once a frame has AUTHENTICATED against this token, never on
   * a rejected one. The relay slot is reachable by anyone who can read the
   * request URI, so consuming on any arriving frame let a single unauthenticated
   * frame burn the ceremony. See PairingService.handleMessage1().
   */
  consumed: boolean;
}

export function mintPairingToken(now: number = Date.now()): PairingToken {
  return { token: randomBytes(32), createdAt: now, expiresAt: now + PAIRING_TOKEN_TTL_MS, consumed: false };
}

export function isPairingTokenValid(pairingToken: PairingToken, now: number = Date.now()): boolean {
  return !pairingToken.consumed && now < pairingToken.expiresAt;
}

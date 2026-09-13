import { describe, expect, it } from 'vitest';
import { signJwt, verifyJwt } from '../server/lib/jwt.ts';

describe('jwt', () => {
  it('round-trips the claims', () => {
    const token = signJwt({ sub: 'u_1001', role: 'admin' });
    expect(verifyJwt(token)).toMatchObject({ sub: 'u_1001', role: 'admin' });
  });

  it('rejects a tampered signature', () => {
    const token = signJwt({ sub: 'u_1001', role: 'admin' });
    expect(() => verifyJwt(`${token.slice(0, -2)}xx`)).toThrow('Invalid signature');
  });
});

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface JwtClaims {
  sub: string;
  role: 'admin' | 'member' | 'viewer';
  exp?: number;
}

const SECRET = process.env.CONTOSO_JWT_SECRET ?? 'development-only-secret';

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

export function signJwt(claims: JwtClaims, ttlSeconds = 3600): string {
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ ...claims, exp: Math.floor(Date.now() / 1000) + ttlSeconds }));
  const signature = createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

export function verifyJwt(token: string): JwtClaims {
  const [header, payload, signature] = token.split('.');
  if (!header || !payload || !signature) throw new Error('Malformed token');
  const expected = createHmac('sha256', SECRET).update(`${header}.${payload}`).digest('base64url');
  const expectedBuffer = Buffer.from(expected);
  const signatureBuffer = Buffer.from(signature);
  if (expectedBuffer.length !== signatureBuffer.length || !timingSafeEqual(expectedBuffer, signatureBuffer)) {
    throw new Error('Invalid signature');
  }
  const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as JwtClaims;
  if (claims.exp !== undefined && claims.exp < Math.floor(Date.now() / 1000)) throw new Error('Token expired');
  return claims;
}

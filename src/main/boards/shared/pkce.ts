import crypto from 'node:crypto';

/** A PKCE code verifier and the S256 challenge a provider checks it against. */
export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** A PKCE verifier (43 base64url characters from 32 random bytes) and its S256 challenge. */
export function createPkcePair(): PkcePair {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

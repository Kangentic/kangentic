import { GITLAB_REFRESH_MARGIN_MS } from './constants';
import type { GitLabCredential } from './credential-store';
import { GitLabHttpError } from './gitlab-error';
import { refreshGitLabAccessToken } from './oauth-tokens';
import { GITLAB_REFRESH_REDIRECT_URI } from './oauth';

export interface FreshCredentialDependencies {
  fetchImpl: typeof fetch;
  save: (credential: GitLabCredential) => Promise<void>;
  now?: () => number;
}

/** Renewals under way, per server, so two calls that find the same sign-in lapsing renew it once. */
const renewals = new Map<string, Promise<GitLabCredential>>();

/**
 * The last renewal per server, with the refresh token it replaced. A caller that
 * read the credentials before that renewal still holds the old pair, whose
 * refresh token GitLab has already revoked (the Import's image downloads run in
 * batches off one read), so it gets the renewed pair instead of renewing again.
 */
const lastRenewals = new Map<string, { replacedRefreshToken: string; renewed: GitLabCredential }>();

/** Forget every renewal. For tests. */
export function clearGitLabRenewals(): void {
  renewals.clear();
  lastRenewals.clear();
}

/**
 * A credential that is good to send now. A personal access token is returned as
 * it is: when it expires GitLab says so, and the Import dialog offers Connect. A
 * browser sign-in within `GITLAB_REFRESH_MARGIN_MS` of lapsing is renewed first,
 * and the new pair is saved before it is used, because GitLab revokes the old
 * refresh token on every renewal. A renewal GitLab refuses (a revoked sign-in)
 * throws as a 401, so every caller reads it as a refused sign-in and offers Connect.
 */
export async function freshCredential(
  credential: GitLabCredential,
  dependencies: FreshCredentialDependencies,
): Promise<GitLabCredential> {
  if (credential.method !== 'oauth' || !credential.refreshToken || !credential.expiresAt) return credential;
  const now = dependencies.now?.() ?? Date.now();
  if (Date.parse(credential.expiresAt) - now > GITLAB_REFRESH_MARGIN_MS) return credential;

  const last = lastRenewals.get(credential.site);
  if (last && last.replacedRefreshToken === credential.refreshToken) return last.renewed;

  const pending = renewals.get(credential.site);
  if (pending) return pending;
  const replacedRefreshToken = credential.refreshToken;
  const renewal = (async () => {
    let tokens: Awaited<ReturnType<typeof refreshGitLabAccessToken>>;
    try {
      tokens = await refreshGitLabAccessToken(
        { refreshToken: replacedRefreshToken, redirectUri: GITLAB_REFRESH_REDIRECT_URI },
        dependencies.fetchImpl,
      );
    } catch (error) {
      // GitLab answers a revoked or expired refresh token with 400 `invalid_grant`.
      if (error instanceof GitLabHttpError && (error.status === 400 || error.status === 401)) {
        throw new GitLabHttpError(401, error.providerMessage, undefined);
      }
      throw error;
    }
    const renewed: GitLabCredential = {
      ...credential,
      secret: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      savedAt: new Date().toISOString(),
    };
    // Kept before the save, so a save that fails still leaves this run the pair
    // GitLab now honors rather than the one it revoked.
    lastRenewals.set(credential.site, { replacedRefreshToken, renewed });
    await dependencies.save(renewed);
    return renewed;
  })();
  renewals.set(credential.site, renewal);
  try {
    return await renewal;
  } finally {
    renewals.delete(credential.site);
  }
}

import { ipcMain, shell } from 'electron';
import { IPC } from '../../../../shared/ipc-channels';
import type {
  GitLabAuthStatus,
  GitLabConnectResult,
  GitLabConnectTokenInput,
  GitLabDetectServerResult,
} from '../../../../shared/types';
import { GitLabAdapter } from './adapter';
import { GitLabClient } from './client';
import { GITLAB_COM_BASE } from './constants';
import { saveGitLabCredential, type GitLabCredential } from './credential-store';
import { GitLabHttpError } from './gitlab-error';
import { networkCode } from '../../shared/network-error';
import { probeGitLabBase } from './instance';
import { cancelGitLabSignIn, isGitLabSignInAvailable, reopenGitLabSignIn, signInWithGitLab } from './oauth';
import { isGitLabCom, originOf, serverLabel, toUrl } from './url-parser';

/**
 * Register every GitLab `ipcMain.handle` channel. Called once from
 * `registerBacklogHandlers`. All GitLab IPC lives in this file so the adapter
 * folder is self-contained, as Jira's and Linear's are.
 */
export function registerGitLabIpcHandlers(): void {
  // GitLab's sign-ins are per server, so the answer depends on the server
  // `target` names: a pasted link or a saved source's repository.
  ipcMain.handle(IPC.BOARDS_GITLAB_AUTH_STATUS, async (_, target?: string): Promise<GitLabAuthStatus> =>
    new GitLabAdapter().getAuthStatus(typeof target === 'string' ? target : undefined));

  ipcMain.handle(IPC.BOARDS_GITLAB_DETECT_SERVER, async (_, siteOrUrl: string): Promise<GitLabDetectServerResult> =>
    detectGitLabServer(typeof siteOrUrl === 'string' ? siteOrUrl : ''));

  ipcMain.handle(IPC.BOARDS_GITLAB_CONNECT_TOKEN, async (_, input: GitLabConnectTokenInput): Promise<GitLabConnectResult> =>
    connectGitLabToken(input));

  ipcMain.handle(IPC.BOARDS_GITLAB_SIGN_IN, async (_, site: string): Promise<GitLabConnectResult> =>
    signInToGitLab(typeof site === 'string' ? site : ''));

  ipcMain.handle(IPC.BOARDS_GITLAB_REOPEN_SIGN_IN, async (): Promise<void> => {
    await reopenGitLabSignIn();
  });

  ipcMain.handle(IPC.BOARDS_GITLAB_CANCEL_SIGN_IN, (): void => {
    cancelGitLabSignIn();
  });
}

/**
 * A server address as typed in the Connect dialog's Server field (a host, a
 * base URL, or a base with a path prefix) as a base URL: lowercased host, no
 * trailing slash. Null for text that is no address.
 */
export function normalizeServerBase(input: string): string | null {
  const url = toUrl(input);
  if (!url) return null;
  const path = url.pathname.replace(/\/+$/, '');
  return `${originOf(url)}${path}`;
}

/** Normalize a server address and ask it whether it runs GitLab. Exported for tests. */
export async function detectGitLabServer(siteOrUrl: string, fetchImpl: typeof fetch = fetch): Promise<GitLabDetectServerResult> {
  const base = normalizeServerBase(siteOrUrl);
  if (!base) return { ok: false, code: 'invalid' };
  const probe = await probeGitLabBase(base, fetchImpl);
  if (probe.kind === 'not-gitlab') return { ok: false, code: 'not-gitlab', site: serverLabel(base) };
  if (probe.kind === 'unreachable') return { ok: false, code: 'unreachable', site: serverLabel(base), detail: probe.detail };
  return { ok: true, site: probe.base, isGitLabCom: isGitLabCom(probe.base), signInAvailable: isGitLabSignInAvailable(probe.base) };
}

/**
 * Check a credential against the server by asking who it signs in as, and save
 * it when GitLab accepts it. GitLab's refusal is returned with its own text, so
 * the dialog shows it as sent and keeps what was typed.
 */
async function verifyAndSave(
  credential: Omit<GitLabCredential, 'account' | 'savedAt'>,
  fetchImpl: typeof fetch,
  save: (credential: GitLabCredential) => Promise<void>,
): Promise<GitLabConnectResult> {
  const label = serverLabel(credential.site);
  let account: string;
  try {
    const user = await new GitLabClient(credential, fetchImpl).currentUser();
    account = user.username;
  } catch (error) {
    const code = networkCode(error);
    if (code) return { ok: false, code: 'unreachable', site: label, detail: code };
    if (!(error instanceof GitLabHttpError)) throw error;
    if (error.status === 401 || error.status === 403) {
      return { ok: false, code: 'rejected', site: label, message: error.providerMessage };
    }
    return { ok: false, code: 'unreachable', site: label, detail: String(error.status) };
  }
  await save({ ...credential, account, savedAt: new Date().toISOString() });
  return { ok: true, site: label, account };
}

/** Check a personal access token against the server and save it when GitLab accepts it. Exported for tests. */
export async function connectGitLabToken(
  input: GitLabConnectTokenInput,
  fetchImpl: typeof fetch = fetch,
  save: (credential: GitLabCredential) => Promise<void> = saveGitLabCredential,
): Promise<GitLabConnectResult> {
  const token = typeof input?.token === 'string' ? input.token.trim() : '';
  if (!token) return { ok: false, code: 'invalid' };
  const detected = await detectGitLabServer(typeof input.site === 'string' ? input.site : '', fetchImpl);
  if (!detected.ok) return { ok: false, code: detected.code, site: detected.site, detail: detected.detail };
  return verifyAndSave({ site: detected.site, method: 'token', secret: token }, fetchImpl, save);
}

/** Sign in to gitlab.com through the browser and save the sign-in. Exported for tests. */
export async function signInToGitLab(
  site: string,
  dependencies: {
    signIn?: typeof signInWithGitLab;
    openExternal?: (url: string) => Promise<void>;
    fetchImpl?: typeof fetch;
    save?: (credential: GitLabCredential) => Promise<void>;
  } = {},
): Promise<GitLabConnectResult> {
  const base = normalizeServerBase(site) ?? '';
  if (!isGitLabSignInAvailable(base)) return { ok: false, code: 'invalid', site: serverLabel(base) };
  const signIn = dependencies.signIn ?? signInWithGitLab;
  const result = await signIn({ openExternal: dependencies.openExternal ?? ((url) => shell.openExternal(url)) });
  if (!result.ok) {
    return result.cancelled
      ? { ok: false, code: 'cancelled' }
      : { ok: false, code: 'sign-in-failed', message: result.error };
  }
  return verifyAndSave({
    site: GITLAB_COM_BASE,
    method: 'oauth',
    secret: result.tokens.accessToken,
    refreshToken: result.tokens.refreshToken,
    expiresAt: result.tokens.expiresAt,
  }, dependencies.fetchImpl ?? fetch, dependencies.save ?? saveGitLabCredential);
}

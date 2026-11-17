import { ipcMain, shell } from 'electron';
import { IPC } from '../../../../shared/ipc-channels';
import type {
  JiraAuthStatus,
  JiraConnectInput,
  JiraConnectResult,
  JiraDetectSiteResult,
  JiraSignInInput,
  JiraSignInResult,
} from '../../../../shared/types';
import { RefusalError } from '../../../../shared/refusal';
import { JiraAdapter } from './adapter';
import { JiraClient, JiraHttpError, fetchCloudId, type JiraMyself } from './client';
import { saveJiraCredential, type JiraSiteCredential } from './credential-store';
import { cancelJiraSignIn, reopenJiraSignIn, signInWithAtlassian } from './oauth';
import { detectDeployment, normalizeSiteBase, siteLabel } from './site';

/**
 * Register every Jira `ipcMain.handle` channel. Called once from
 * `registerBacklogHandlers`. All Jira IPC lives in this file so the adapter
 * folder is self-contained, as Asana's and Linear's are.
 */
export function registerJiraIpcHandlers(): void {
  // Jira's sign-ins are per site, so the answer depends on the site `target`
  // names: a pasted link, typed JQL, or a saved source's repository.
  ipcMain.handle(IPC.BOARDS_JIRA_AUTH_STATUS, async (_, target?: string): Promise<JiraAuthStatus> =>
    new JiraAdapter().getAuthStatus(typeof target === 'string' ? target : undefined));

  ipcMain.handle(IPC.BOARDS_JIRA_DETECT_SITE, async (_, siteOrUrl: string): Promise<JiraDetectSiteResult> => {
    const site = normalizeSiteBase(typeof siteOrUrl === 'string' ? siteOrUrl : '');
    return { site, deployment: await detectDeployment(site) };
  });

  ipcMain.handle(IPC.BOARDS_JIRA_CONNECT, async (_, input: JiraConnectInput): Promise<JiraConnectResult> =>
    connectJiraSite(input));

  ipcMain.handle(IPC.BOARDS_JIRA_SIGN_IN, async (_, input: JiraSignInInput): Promise<JiraSignInResult> =>
    signInJiraSite(input, (url) => shell.openExternal(url)));

  ipcMain.handle(IPC.BOARDS_JIRA_REOPEN_SIGN_IN, async (): Promise<void> => {
    await reopenJiraSignIn();
  });

  ipcMain.handle(IPC.BOARDS_JIRA_CANCEL_SIGN_IN, async (): Promise<void> => {
    cancelJiraSignIn();
  });
}

/**
 * Sign in with Atlassian for the site the dialog names, and save the sign-in
 * for that site once it proves it can open it. Exported for tests.
 */
export async function signInJiraSite(
  input: JiraSignInInput,
  openExternal: (url: string) => Promise<void>,
  dependencies: {
    signIn?: typeof signInWithAtlassian;
    save?: (credential: JiraSiteCredential) => Promise<void>;
  } = {},
): Promise<JiraSignInResult> {
  const site = normalizeSiteBase(typeof input?.site === 'string' ? input.site : '');
  const result = await (dependencies.signIn ?? signInWithAtlassian)({ site, openExternal });
  if (!result.ok) return result;
  await (dependencies.save ?? saveJiraCredential)(result.value);
  return { ok: true, site: siteLabel(site), account: result.value.account };
}

/** The errno a failed fetch carries (`ENOTFOUND`, `ECONNREFUSED`), when it has one. */
function networkCode(error: unknown): string | undefined {
  const cause = error instanceof Error ? (error as Error & { cause?: unknown }).cause : undefined;
  const code = (cause as { code?: unknown } | undefined)?.code;
  if (typeof code === 'string') return code;
  if (error instanceof Error && error.name === 'TimeoutError') return 'ETIMEDOUT';
  return undefined;
}

/**
 * Check a credential against the site and save it when Jira accepts it. Every
 * failure Jira or the network explains is a code the renderer turns into its
 * line, so the dialog keeps what was typed. A page that is not Jira's JSON (a
 * proxy's sign-in page) reads as unreachable. Anything else is thrown for the IPC
 * wrap to report. Exported for tests.
 */
export async function connectJiraSite(
  input: JiraConnectInput,
  fetchImpl: typeof fetch = fetch,
  save: (credential: JiraSiteCredential) => Promise<void> = saveJiraCredential,
): Promise<JiraConnectResult> {
  const secret = typeof input?.secret === 'string' ? input.secret.trim() : '';
  const email = typeof input?.email === 'string' ? input.email.trim() : '';
  const username = typeof input?.username === 'string' ? input.username.trim() : '';
  const method = input?.method;
  if (!secret || (method === 'api-token' && !email) || (method === 'password' && !username)) {
    return { ok: false, code: 'invalid' };
  }
  if (method !== 'api-token' && method !== 'pat' && method !== 'password') {
    return { ok: false, code: 'invalid' };
  }

  let site: string;
  try {
    site = normalizeSiteBase(typeof input.site === 'string' ? input.site : '');
  } catch (error) {
    if (error instanceof RefusalError) return { ok: false, code: 'invalid' };
    throw error;
  }
  const label = siteLabel(site);
  const deployment = await detectDeployment(site, fetchImpl);

  const credential: JiraSiteCredential = {
    site,
    deployment,
    method,
    email: method === 'api-token' ? email : undefined,
    username: method === 'password' ? username : undefined,
    secret,
    account: method === 'api-token' ? email : username,
    savedAt: new Date().toISOString(),
  };

  let myself: JiraMyself;
  try {
    myself = await new JiraClient(credential, fetchImpl).myself();
  } catch (error) {
    const code = networkCode(error);
    if (code) return { ok: false, code: 'unreachable', site: label, detail: code };
    if (!(error instanceof JiraHttpError)) throw error;

    // A Data Center site that wants a CAPTCHA says so in a header, before any password is checked.
    if (method === 'password' && error.loginReason === 'AUTHENTICATION_DENIED') {
      return { ok: false, code: 'captcha', site: label };
    }
    if (method === 'password' && (error.status === 401 || error.status === 403) && /basic auth/i.test(error.body)) {
      return { ok: false, code: 'password-off', site: label };
    }

    // A scoped Cloud token is refused at the site's own address and only works
    // through Atlassian's gateway, so try there before calling it rejected.
    if (deployment === 'cloud' && method === 'api-token' && (error.status === 401 || error.status === 404)) {
      const viaGateway = await tryGateway(credential, fetchImpl);
      if (viaGateway) {
        const gatewayAccount = viaGateway.myself.emailAddress || email;
        await save({ ...viaGateway.credential, account: gatewayAccount });
        return { ok: true, site: label, account: gatewayAccount };
      }
    }
    if (error.status === 401 || error.status === 403) return { ok: false, code: 'rejected', site: label };
    // A 2xx here is a page that is not Jira's JSON, and its status explains nothing.
    if (error.status < 300) return { ok: false, code: 'unreachable', site: label };
    return { ok: false, code: 'unreachable', site: label, detail: String(error.status) };
  }

  const account = myself.emailAddress || myself.name || myself.displayName || credential.account;
  await save({ ...credential, account });
  return { ok: true, site: label, account };
}

/** Retry a Cloud token through the gateway; the credential and user when it works there. */
async function tryGateway(
  credential: JiraSiteCredential,
  fetchImpl: typeof fetch,
): Promise<{ credential: JiraSiteCredential; myself: JiraMyself } | null> {
  try {
    const cloudId = await fetchCloudId(credential.site, fetchImpl);
    if (!cloudId) return null;
    const gatewayCredential: JiraSiteCredential = { ...credential, cloudId, viaGateway: true };
    const myself = await new JiraClient(gatewayCredential, fetchImpl).myself();
    return { credential: gatewayCredential, myself };
  } catch { // report-ok: a token the gateway refuses too is simply rejected, which the caller reports
    return null;
  }
}

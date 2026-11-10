import { useEffect } from 'react';
import { UserPlus } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { useAccountsStore } from '../../../stores/accounts-store';
import { agentDisplayName } from '../../../utils/agent-display-name';
import { BaseDialog } from '../../dialogs/BaseDialog';
import { LoginTerminal } from './LoginTerminal';

/**
 * The window an account's sign-in runs in. The agent's CLI does the whole sign-in, in the
 * browser or on its own screen; this shows its terminal, and when it ends, who signed in. A
 * sign-in that worked closes the window: the new row in the list is the confirmation.
 */
export function AccountLoginDialog() {
  const { t } = useLingui();
  const login = useAccountsStore((state) => state.login);
  const ended = useAccountsStore((state) => state.loginEnded);
  const closeLogin = useAccountsStore((state) => state.closeLogin);
  const signInIsInteractive = useAccountsStore((state) =>
    state.cards.find((card) => card.agent === state.login?.agent)?.signInIsInteractive === true);

  const signedIn = ended?.account != null && ended.account.status !== 'signed-out';
  useEffect(() => {
    if (signedIn) closeLogin();
  }, [signedIn, closeLogin]);

  if (!login || signedIn) return null;
  const agentName = agentDisplayName(login.agent);
  const duplicateEmail = ended?.duplicateOf?.email ?? null;

  return (
    <BaseDialog
      onClose={closeLogin}
      title={t`Sign in to ${agentName}`}
      icon={<UserPlus size={16} className="text-accent-fg" />}
      className="w-[720px] max-w-[92vw]"
      testId="account-login-dialog"
      // A click outside must not end a sign-in the user is finishing in the browser.
      preventBackdropClose
      footer={(
        <div className="flex justify-end">
          <button
            type="button"
            onClick={closeLogin}
            className="rounded-md border border-edge-input px-3 py-1.5 text-sm text-fg-secondary hover:bg-surface-hover"
            data-testid="account-login-close"
          >
            {ended ? t`Close` : t`Cancel`}
          </button>
        </div>
      )}
    >
      <div className="flex flex-col gap-3">
        {ended ? (
          <p className="text-sm text-fg-secondary" data-testid="account-login-result">
            {duplicateEmail
              ? <Trans>{duplicateEmail} is already in the list.</Trans>
              : <Trans>The sign-in did not finish.</Trans>}
          </p>
        ) : (
          <>
            <LoginTerminal loginId={login.loginId} label={t`${agentName} sign-in`} />
            {/* Under the terminal, as on the canvas. The sign-in itself happens in the browser;
                the terminal takes a pasted code only when the browser cannot hand it back. */}
            <p className="text-xs text-fg-muted" data-testid="account-login-hint">
              {signInIsInteractive
                ? <Trans>Sign in here, then exit {agentName} to finish.</Trans>
                : <Trans>Your browser signs in the account it already has open, so use its Switch account to add a different one.</Trans>}
            </p>
          </>
        )}
      </div>
    </BaseDialog>
  );
}

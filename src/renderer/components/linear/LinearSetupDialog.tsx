import { useState, useRef, useEffect, type ReactNode } from 'react';
import { Trans, useLingui } from '@lingui/react/macro';
import { ArrowLeft, ChevronRight, ExternalLink, Eye, EyeOff, KeyRound, LoaderCircle } from 'lucide-react';
import { BaseDialog } from '../dialogs/BaseDialog';
import { ArtifactPlatformLogo } from '../VendorMark';
import { reportRendererFailure } from '../../utils/renderer-failure';
import type { ProviderSetupDialogProps } from '../backlog/import-providers';
import { ConnectWaiting } from '../backlog/connect/ConnectParts';
import { useBrowserSignIn } from '../backlog/connect/useBrowserSignIn';

const LINEAR_SECURITY_SETTINGS_URL = 'https://linear.app/settings/account/security';

type View = 'loading' | 'choice' | 'waiting' | 'key';

function BackButton({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="flex items-center gap-1 px-3 py-1.5 text-sm text-fg-muted hover:text-fg border border-edge/50 rounded transition-colors"
      data-testid="linear-setup-back-btn"
    >
      <ArrowLeft size={12} />
      <Trans context="button">Back</Trans>
    </button>
  );
}

/**
 * Connect Linear: two ways in, chosen on the first screen. "Sign in with Linear"
 * opens Linear's approval page in the system browser and waits for it to hand
 * back; "Use a personal API key" shows the three paste steps. A build with no
 * OAuth client id offers only the key, so the dialog opens on its steps.
 */
export function LinearSetupDialog({ onClose, onSaved, initialError }: ProviderSetupDialogProps) {
  const { t } = useLingui();
  const [view, setView] = useState<View>('loading');
  const [signInAvailable, setSignInAvailable] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const keyInputRef = useRef<HTMLInputElement>(null);
  const browserSignIn = useBrowserSignIn('linear');

  useEffect(() => {
    let cancelled = false;
    window.electronAPI.backlog.linear.authStatus().then((status) => {
      if (cancelled) return;
      setSignInAvailable(status.signInAvailable);
      setView(status.signInAvailable ? 'choice' : 'key');
    }).catch((statusError: unknown) => {
      reportRendererFailure('linear', 'auth-status', statusError);
      if (!cancelled) setView('key');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (view === 'key') keyInputRef.current?.focus();
  }, [view]);

  const handleClose = () => {
    browserSignIn.cancel();
    onClose();
  };

  const handleSignIn = async () => {
    setError(null);
    setView('waiting');
    const outcome = await browserSignIn.run(() => window.electronAPI.backlog.linear.signIn());
    if (outcome.kind === 'saved') {
      onSaved();
      return;
    }
    if (outcome.kind === 'stale') return;
    setView('choice');
    if (outcome.kind === 'failed') setError(outcome.error ?? t`Linear sign-in did not finish.`);
  };

  const handleBackFromWaiting = () => {
    browserSignIn.cancel();
    setView('choice');
  };

  const handleSaveKey = async () => {
    const trimmedKey = apiKey.trim();
    if (trimmedKey.length === 0 || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await window.electronAPI.backlog.linear.setApiKey({ apiKey: trimmedKey });
      if (!result.ok) {
        setError(result.error ?? t`Couldn't save the key.`);
        return;
      }
      onSaved();
    } catch (saveError: unknown) {
      reportRendererFailure('linear', 'set-api-key', saveError);
      setError(saveError instanceof Error ? saveError.message : t`Couldn't save the key.`);
    } finally {
      setSubmitting(false);
    }
  };

  const openSecuritySettings = () => {
    window.electronAPI.shell.openExternal(LINEAR_SECURITY_SETTINGS_URL).catch((openError: unknown) => {
      reportRendererFailure('linear', 'open-settings', openError);
    });
  };

  const stepBadge = (step: number) => (
    <span className="flex items-center justify-center w-5 h-5 rounded-full bg-accent-bg/30 text-accent text-xs font-bold shrink-0">
      {step}
    </span>
  );

  const cancelButton = (
    <button
      type="button"
      onClick={handleClose}
      className="px-3 py-1.5 text-sm text-fg-muted hover:text-fg border border-edge/50 rounded transition-colors"
      data-testid="linear-setup-cancel-btn"
    >
      <Trans context="button">Cancel</Trans>
    </button>
  );

  const keyCanSave = apiKey.trim().length > 0 && !submitting;

  let footer: ReactNode;
  if (view === 'key') {
    footer = (
      <div className="flex items-center justify-between gap-2">
        <div>{signInAvailable ? <BackButton onBack={() => { setError(null); setView('choice'); }} /> : null}</div>
        <div className="flex gap-2">
          {cancelButton}
          <button
            type="button"
            onClick={() => void handleSaveKey()}
            disabled={!keyCanSave}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-accent-emphasis hover:bg-accent text-accent-on rounded transition-colors disabled:opacity-50"
            data-testid="linear-setup-save-btn"
          >
            {submitting ? <LoaderCircle size={14} className="animate-spin" /> : null}
            <Trans>Connect</Trans>
          </button>
        </div>
      </div>
    );
  } else if (view === 'waiting') {
    footer = (
      <div className="flex items-center justify-between gap-2">
        <BackButton onBack={handleBackFromWaiting} />
        {cancelButton}
      </div>
    );
  } else {
    footer = <div className="flex justify-end">{cancelButton}</div>;
  }

  return (
    <BaseDialog
      onClose={handleClose}
      title={t`Connect Linear`}
      icon={<span className="text-accent flex"><ArtifactPlatformLogo platformId="linear" size={18} /></span>}
      testId="linear-setup-dialog"
      className={view === 'key' ? 'w-[480px]' : 'w-[400px]'}
      save={view === 'key' ? { onSave: () => void handleSaveKey(), disabled: !keyCanSave } : undefined}
      footer={footer}
    >
      {view === 'loading' && (
        <div className="flex justify-center py-6" data-testid="linear-setup-loading">
          <LoaderCircle size={20} className="animate-spin text-fg-faint" />
        </div>
      )}

      {view === 'choice' && (
        <div className="flex flex-col gap-2.5">
          {error && <p className="text-xs text-danger" data-testid="linear-setup-error">{error}</p>}
          <button
            type="button"
            onClick={() => void handleSignIn()}
            className="flex items-center gap-3 w-full p-3 text-left bg-surface border border-edge rounded-md hover:bg-surface-hover/40 transition-colors"
            data-testid="linear-setup-sign-in-btn"
          >
            <span className="flex items-center justify-center w-8 h-8 shrink-0 rounded-md bg-accent-bg/20 text-accent-fg">
              <ArtifactPlatformLogo platformId="linear" size={16} />
            </span>
            <span className="flex-1 min-w-0 flex flex-col gap-0.5">
              <span className="text-sm font-semibold text-fg"><Trans>Sign in with Linear</Trans></span>
              <span className="text-xs text-fg-muted truncate"><Trans>Approve Kangentic in your browser</Trans></span>
            </span>
            <ChevronRight size={14} className="text-fg-faint shrink-0" />
          </button>
          <button
            type="button"
            onClick={() => { setError(null); setView('key'); }}
            className="flex items-center gap-3 w-full p-3 text-left bg-surface border border-edge rounded-md hover:bg-surface-hover/40 transition-colors"
            data-testid="linear-setup-api-key-btn"
          >
            <span className="flex items-center justify-center w-8 h-8 shrink-0 rounded-md bg-surface-hover/60 text-fg-muted">
              <KeyRound size={16} />
            </span>
            <span className="flex-1 min-w-0 flex flex-col gap-0.5">
              <span className="text-sm font-semibold text-fg"><Trans>Use a personal API key</Trans></span>
              <span className="text-xs text-fg-muted truncate"><Trans>Paste a key from Linear's settings</Trans></span>
            </span>
            <ChevronRight size={14} className="text-fg-faint shrink-0" />
          </button>
        </div>
      )}

      {view === 'waiting' && (
        <ConnectWaiting
          message={<Trans>Waiting for Linear in your browser</Trans>}
          onReopen={browserSignIn.reopen}
          testIdPrefix="linear-setup"
        />
      )}

      {view === 'key' && (
        <div className="flex flex-col gap-5 text-sm">
          <section className="flex flex-col gap-2">
            <h4 className="flex items-center gap-2 text-sm font-semibold text-fg">
              {stepBadge(1)}
              <Trans>Open Linear's security settings</Trans>
            </h4>
            <div className="ml-7">
              <button
                type="button"
                onClick={openSecuritySettings}
                className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-surface hover:bg-surface-hover border border-edge rounded transition-colors"
                data-testid="linear-setup-open-settings-btn"
              >
                <ExternalLink size={12} />
                <Trans>Open linear.app/settings/account/security</Trans>
              </button>
            </div>
          </section>

          <section className="flex flex-col gap-2">
            <h4 className="flex items-center gap-2 text-sm font-semibold text-fg">
              {stepBadge(2)}
              <Trans>Create a personal API key</Trans>
            </h4>
            <p className="ml-7 text-xs text-fg-muted">
              <Trans comment="Read is the name of an access level in Linear's own English interface. Keep it as written.">
                Name it &quot;Kangentic&quot;, give it <span className="text-fg">Read</span> access, and copy it.
              </Trans>
            </p>
          </section>

          <section className="flex flex-col gap-2">
            <h4 className="flex items-center gap-2 text-sm font-semibold text-fg">
              {stepBadge(3)}
              <Trans>Paste it here</Trans>
            </h4>
            <div className="ml-7 flex flex-col gap-2">
              <label className="text-xs text-fg-muted" htmlFor="linear-setup-api-key">
                <Trans>Personal API key</Trans>
              </label>
              <div className="relative">
                <input
                  ref={keyInputRef}
                  id="linear-setup-api-key"
                  type={showKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(event) => { setApiKey(event.target.value); setError(null); }}
                  onKeyDown={(event) => { if (event.key === 'Enter') void handleSaveKey(); }}
                  placeholder={t`Paste your key`}
                  autoComplete="off"
                  spellCheck={false}
                  className="w-full bg-surface/50 border border-edge/50 rounded text-sm text-fg placeholder-fg-muted px-2.5 py-1.5 pr-9 outline-none focus:border-edge-input font-mono"
                  data-testid="linear-setup-key-input"
                />
                <button
                  type="button"
                  onClick={() => setShowKey((previous) => !previous)}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-fg-faint hover:text-fg rounded"
                  aria-label={showKey ? t`Hide key` : t`Show key`}
                  data-testid="linear-setup-toggle-key-btn"
                >
                  {showKey ? <EyeOff size={14} /> : <Eye size={14} />}
                </button>
              </div>
              <p className="text-[11px] text-fg-faint"><Trans>Stored encrypted in your OS keychain.</Trans></p>
              {error && <p className="text-xs text-danger" data-testid="linear-setup-error">{error}</p>}
            </div>
          </section>
        </div>
      )}
    </BaseDialog>
  );
}

import React, { useState, useRef, useEffect } from 'react';
import { KanbanSquare, ExternalLink, Loader2, Eye, EyeOff } from 'lucide-react';
import { BaseDialog } from '../dialogs/BaseDialog';

interface AsanaSetupDialogProps {
  onClose: () => void;
  /** Called after the PAT is validated and persisted. Dialog closes on success. */
  onSaved: () => void;
}

const ASANA_APPS_URL = 'https://app.asana.com/0/my-apps';

export function AsanaSetupDialog({ onClose, onSaved }: AsanaSetupDialogProps) {
  const [token, setToken] = useState('');
  const [showToken, setShowToken] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (inputRef.current) inputRef.current.focus();
  }, []);

  const openAsanaDeveloperConsole = async () => {
    try {
      await window.electronAPI.shell.openExternal(ASANA_APPS_URL);
    } catch (openError) {
      console.warn('[AsanaSetupDialog] openExternal failed', openError);
    }
  };

  const handleSave = async () => {
    const trimmedToken = token.trim();
    if (trimmedToken.length === 0) {
      setError('Paste your Personal Access Token to continue.');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const result = await window.electronAPI.backlog.asana.setPat({ token: trimmedToken });
      if (!result.ok) {
        setError(result.error ?? 'Could not save the token.');
        return;
      }
      onSaved();
    } catch (saveError: unknown) {
      setError(saveError instanceof Error ? saveError.message : 'Could not save the token.');
    } finally {
      setSubmitting(false);
    }
  };

  const numberBadge = (n: number) => (
    <span className="flex items-center justify-center w-5 h-5 rounded-full bg-accent-bg/30 text-accent text-xs font-bold shrink-0">
      {n}
    </span>
  );

  return (
    <BaseDialog
      onClose={onClose}
      title="Connect Asana"
      icon={<KanbanSquare size={18} className="text-accent" />}
      testId="asana-setup-dialog"
      className="w-[480px]"
      footer={
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 text-sm text-fg-muted hover:text-fg border border-edge/50 rounded transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSave}
            disabled={submitting || token.trim().length === 0}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-accent-emphasis hover:bg-accent text-accent-on rounded transition-colors disabled:opacity-50"
            data-testid="asana-setup-save-btn"
          >
            {submitting ? <Loader2 size={14} className="animate-spin" /> : null}
            Connect
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-5 text-sm">
        <p className="text-fg-muted">
          Kangentic connects to Asana with a Personal Access Token. The whole setup takes about 30 seconds.
        </p>

        {/* Step 1 */}
        <section className="flex flex-col gap-2">
          <h4 className="flex items-center gap-2 text-sm font-semibold text-fg">
            {numberBadge(1)}
            Open Asana developer settings
          </h4>
          <div className="ml-7">
            <button
              type="button"
              onClick={openAsanaDeveloperConsole}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-surface hover:bg-surface-hover border border-edge rounded transition-colors"
              data-testid="asana-setup-open-console-btn"
            >
              <ExternalLink size={12} />
              Open app.asana.com/0/my-apps
            </button>
          </div>
        </section>

        {/* Step 2 */}
        <section className="flex flex-col gap-2">
          <h4 className="flex items-center gap-2 text-sm font-semibold text-fg">
            {numberBadge(2)}
            Create a Personal Access Token
          </h4>
          <p className="ml-7 text-xs text-fg-muted">
            Open the <span className="text-fg">Personal access tokens</span> tab and click <span className="text-fg">Create new token</span>.
            Name it &ldquo;Kangentic&rdquo;, accept the API terms, then copy the token Asana shows you (it is only displayed once).
          </p>
        </section>

        {/* Step 3 */}
        <section className="flex flex-col gap-2">
          <h4 className="flex items-center gap-2 text-sm font-semibold text-fg">
            {numberBadge(3)}
            Paste it here
          </h4>
          <div className="ml-7 flex flex-col gap-2">
            <label className="text-xs text-fg-muted" htmlFor="asana-setup-pat">
              Personal Access Token
            </label>
            <div className="relative">
              <input
                ref={inputRef}
                id="asana-setup-pat"
                type={showToken ? 'text' : 'password'}
                value={token}
                onChange={(event) => { setToken(event.target.value); setError(null); }}
                onKeyDown={(event) => { if (event.key === 'Enter') handleSave(); }}
                placeholder="Paste your token"
                className="w-full bg-surface/50 border border-edge/50 rounded text-sm text-fg placeholder-fg-disabled px-2.5 py-1.5 pr-9 outline-none focus:border-edge-input font-mono"
                data-testid="asana-setup-pat-input"
              />
              <button
                type="button"
                onClick={() => setShowToken((previous) => !previous)}
                className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-fg-faint hover:text-fg rounded"
                aria-label={showToken ? 'Hide token' : 'Show token'}
                data-testid="asana-setup-toggle-token-btn"
              >
                {showToken ? <EyeOff size={14} /> : <Eye size={14} />}
              </button>
            </div>
            <p className="text-[11px] text-fg-faint">
              Your token is stored locally and encrypted with your operating system&rsquo;s keychain.
              Kangentic never sends it anywhere except Asana.
            </p>

            {error && (
              <p className="text-xs text-danger" data-testid="asana-setup-error">{error}</p>
            )}
          </div>
        </section>
      </div>
    </BaseDialog>
  );
}

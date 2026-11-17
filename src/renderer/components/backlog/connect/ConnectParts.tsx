import React, { useState } from 'react';
import { ArrowLeft, ChevronRight, ExternalLink, Eye, EyeOff, LoaderCircle } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import { reportRendererFailure } from '../../../utils/renderer-failure';

/**
 * The pieces a board provider's Connect dialog is built from, so each provider's
 * reads the same: two equal choice tiles, numbered one-line steps, fields, and the
 * footer. The Jira dialog composes them inside a `BaseDialog`.
 */

export interface ConnectChoice {
  id: string;
  icon: React.ReactNode;
  label: string;
  sublabel: string;
  /** The first, recommended way in gets the accent tile. */
  accent?: boolean;
  testId: string;
}

/** Two (or more) equal ways in, each a real button. */
export function ConnectChoices({ choices, onChoose }: { choices: ConnectChoice[]; onChoose: (id: string) => void }) {
  return (
    <div className="flex flex-col gap-2.5">
      {choices.map((choice) => (
        <button
          key={choice.id}
          type="button"
          onClick={() => onChoose(choice.id)}
          className="flex items-center gap-3 w-full p-3 text-left bg-surface border border-edge rounded-md hover:bg-surface-hover/40 transition-colors"
          data-testid={choice.testId}
        >
          <span
            className={`flex items-center justify-center w-8 h-8 shrink-0 rounded-md ${
              choice.accent ? 'bg-accent-bg/15 text-accent-fg' : 'bg-surface-hover/60 text-fg-muted'
            }`}
          >
            {choice.icon}
          </span>
          <span className="flex flex-col gap-0.5 flex-1 min-w-0">
            <span className="text-sm font-semibold text-fg">{choice.label}</span>
            <span className="text-xs text-fg-muted whitespace-nowrap">{choice.sublabel}</span>
          </span>
          <ChevronRight size={14} className="text-fg-faint shrink-0" />
        </button>
      ))}
    </div>
  );
}

export interface ConnectStep {
  title: React.ReactNode;
  content: React.ReactNode;
}

/** Numbered steps: a heading per step and its content under it. */
export function ConnectSteps({ steps }: { steps: ConnectStep[] }) {
  return (
    <div className="flex flex-col gap-5 text-sm">
      {steps.map((step, index) => (
        // The steps of one method are fixed and never reorder, so their position is their identity.
        <section key={index} className="flex flex-col gap-2">
          <h4 className="flex items-center gap-2 text-sm font-semibold text-fg">
            <span className="flex items-center justify-center w-5 h-5 rounded-full bg-accent-bg/30 text-accent text-xs font-bold shrink-0">
              {index + 1}
            </span>
            {step.title}
          </h4>
          <div className="ml-7 flex flex-col gap-2">{step.content}</div>
        </section>
      ))}
    </div>
  );
}

/** The button that opens the provider's settings page in the browser. */
export function ConnectOpenLink({ href, label, testId }: { href: string; label: string; testId: string }) {
  const open = async () => {
    try {
      await window.electronAPI.shell.openExternal(href);
    } catch (error) {
      reportRendererFailure('board-connect', 'open-settings-link', error);
    }
  };
  return (
    <button
      type="button"
      onClick={() => void open()}
      className="self-start flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-surface hover:bg-surface-hover border border-edge rounded transition-colors"
      data-testid={testId}
    >
      <ExternalLink size={12} />
      {label}
    </button>
  );
}

/** One line of step text, kept to one line. */
export function ConnectStepText({ children }: { children: React.ReactNode }) {
  return <p className="text-xs text-fg-muted whitespace-nowrap">{children}</p>;
}

interface ConnectFieldProps {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  /** A token or password: hidden, monospace, with a show/hide toggle. */
  secret?: boolean;
  autoFocus?: boolean;
  onBlur?: () => void;
  onEnter?: () => void;
  testId: string;
}

export function ConnectField({ id, label, value, onChange, placeholder, secret, autoFocus, onBlur, onEnter, testId }: ConnectFieldProps) {
  const { t } = useLingui();
  const [shown, setShown] = useState(false);
  return (
    <>
      <label className="text-xs text-fg-muted" htmlFor={id}>{label}</label>
      <div className="relative">
        <input
          id={id}
          type={secret && !shown ? 'password' : 'text'}
          value={value}
          autoFocus={autoFocus}
          onChange={(event) => onChange(event.target.value)}
          onBlur={onBlur}
          onKeyDown={(event) => { if (event.key === 'Enter') onEnter?.(); }}
          placeholder={placeholder}
          spellCheck={false}
          autoComplete="off"
          className={`w-full bg-surface/50 border border-edge/50 rounded text-sm text-fg placeholder-fg-muted px-2.5 py-1.5 outline-none focus:border-edge-input ${
            secret ? 'pr-9 font-mono' : ''
          }`}
          data-testid={testId}
        />
        {secret && (
          <button
            type="button"
            onClick={() => setShown((previous) => !previous)}
            className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 text-fg-faint hover:text-fg rounded"
            aria-label={shown ? t`Hide` : t`Show`}
            data-testid={`${testId}-toggle`}
          >
            {shown ? <EyeOff size={14} /> : <Eye size={14} />}
          </button>
        )}
      </div>
    </>
  );
}

/** Where a saved secret goes, said once under the fields. */
export function ConnectFootnote() {
  return (
    <p className="text-[11px] text-fg-faint whitespace-nowrap">
      <Trans>Stored encrypted in your OS keychain.</Trans>
    </p>
  );
}

/**
 * A browser sign-in waiting on the provider's approval page: a spinner, the
 * provider's own line, and a link that opens the page again for a tab the user
 * closed. The dialog's footer carries Back and Cancel.
 */
export function ConnectWaiting({ message, onReopen, testIdPrefix }: { message: React.ReactNode; onReopen: () => void; testIdPrefix: string }) {
  return (
    <div className="flex flex-col items-center gap-2.5 py-2 text-sm" data-testid={`${testIdPrefix}-waiting`}>
      <LoaderCircle size={24} className="animate-spin text-fg-faint" />
      <span className="text-fg">{message}</span>
      <button
        type="button"
        onClick={onReopen}
        className="text-xs text-accent-fg hover:underline"
        data-testid={`${testIdPrefix}-reopen-btn`}
      >
        <Trans>Open the page again</Trans>
      </button>
    </div>
  );
}

/** The one red line a failed connect shows, selectable so it can be searched. */
export function ConnectError({ message, testId }: { message: string | null; testId: string }) {
  if (!message) return null;
  return <p className="text-xs text-danger select-text" data-testid={testId}>{message}</p>;
}

interface ConnectFooterProps {
  /** Absent hides Back: the dialog opened straight on these steps. */
  onBack?: () => void;
  onCancel: () => void;
  /** Absent shows Cancel alone (the choice tiles). */
  onConnect?: () => void;
  connectDisabled?: boolean;
  submitting?: boolean;
  testIdPrefix: string;
}

export function ConnectFooter({ onBack, onCancel, onConnect, connectDisabled, submitting, testIdPrefix }: ConnectFooterProps) {
  return (
    <div className={`flex items-center ${onBack ? 'justify-between' : 'justify-end'}`}>
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1 px-3 py-1.5 text-sm text-fg-muted hover:text-fg border border-edge/50 rounded transition-colors"
          data-testid={`${testIdPrefix}-back-btn`}
        >
          <ArrowLeft size={12} />
          <Trans context="button">Back</Trans>
        </button>
      )}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-3 py-1.5 text-sm text-fg-muted hover:text-fg border border-edge/50 rounded transition-colors"
          data-testid={`${testIdPrefix}-cancel-btn`}
        >
          <Trans context="button">Cancel</Trans>
        </button>
        {onConnect && (
          <button
            type="button"
            onClick={onConnect}
            disabled={connectDisabled || submitting}
            className="flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-accent-emphasis hover:bg-accent text-accent-on rounded transition-colors disabled:opacity-50"
            data-testid={`${testIdPrefix}-connect-btn`}
          >
            {submitting ? <LoaderCircle size={14} className="animate-spin" /> : null}
            <Trans>Connect</Trans>
          </button>
        )}
      </div>
    </div>
  );
}

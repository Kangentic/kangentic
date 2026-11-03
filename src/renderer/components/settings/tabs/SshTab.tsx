import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, CircleAlert, Loader2, Pencil, Plus, RefreshCw, Server, Trash2, X } from 'lucide-react';
import type { I18n } from '@lingui/core';
import { msg, plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type { SshHostConnectionState, SshHostKeyProbe, SshHostStatus, SshSignIn } from '../../../../shared/types';
import { formatDateTime, formatShortDateTime } from '../../../lib/datetime';
import { describeIpcError } from '../../../lib/ipc-error';
import { useSshStore } from '../../../stores/ssh-store';
import { INPUT_CLASS, ReportedError } from '../shared';
import { SettingsCard, CardTile, CardStatusRow } from '../settings-card';
import { SegmentedControl } from '../../SegmentedControl';
import type { SegmentedControlOption } from '../../SegmentedControl';
import { Pill } from '../../Pill';
import { Tooltip } from '../../Tooltip';
import { settingProps } from '../settings-registry';
import { ConfirmDialog } from '../../dialogs/ConfirmDialog';

/**
 * The SSH tab (#913): Linux machines Kangentic runs agents on, and the `ssh` program it connects with.
 * Built like Mobile Devices: a device-style row per host, and Add host runs inline in the card with no
 * dialog. Setup happens entirely here. The host's key fingerprint is shown once and pinned, a password is
 * asked once to make Kangentic's own key, and a passphrase is never asked.
 */

type SignInMethod = SshSignIn['method'];

type AddStep = 'closed' | 'details' | 'trust' | 'signin';

/** An example address, not a sentence: it reads the same in every language. */
const DESTINATION_EXAMPLE = 'dev@build.example.com';

/** A changed host key is the one failure with its own fix: forget the old line, then connect and trust again. */
const CHANGED_KEY_PATTERN = /REMOTE HOST IDENTIFICATION HAS CHANGED/i;

function connectionDisplay(state: SshHostConnectionState, i18n: I18n): { label: string; className: string; icon: ReactNode } {
  switch (state) {
    case 'connected':
      return { label: i18n._(msg`Connected`), className: 'text-green-400', icon: <Check size={12} /> };
    case 'connecting':
      return { label: i18n._(msg`Connecting…`), className: 'text-fg-muted', icon: <Loader2 size={12} className="animate-spin" /> };
    case 'reconnecting':
      return { label: i18n._(msg`Reconnecting…`), className: 'text-fg-muted', icon: <Loader2 size={12} className="animate-spin" /> };
    case 'unreachable':
      return { label: i18n._(msg`Unreachable`), className: 'text-danger', icon: <CircleAlert size={12} /> };
    case 'stopped':
      return { label: i18n._(msg`Stopped`), className: 'text-fg-faint', icon: <X size={12} /> };
  }
}

export function SshTab() {
  const { t, i18n } = useLingui();
  const hosts = useSshStore((state) => state.hosts);
  const hostsLoaded = useSshStore((state) => state.hostsLoaded);
  const hostsError = useSshStore((state) => state.hostsError);
  const client = useSshStore((state) => state.client);
  const loadHosts = useSshStore((state) => state.loadHosts);
  const loadClient = useSshStore((state) => state.loadClient);
  const probeHostKey = useSshStore((state) => state.probeHostKey);
  const addHost = useSshStore((state) => state.addHost);
  const removeHost = useSshStore((state) => state.removeHost);
  const renameHost = useSshStore((state) => state.renameHost);
  const reconnectHost = useSshStore((state) => state.reconnectHost);
  const forgetHostKey = useSshStore((state) => state.forgetHostKey);

  const hostsHeading = settingProps('ssh.hosts');
  const clientHeading = settingProps('ssh.client');

  const [step, setStep] = useState<AddStep>('closed');
  const [name, setName] = useState('');
  const [destination, setDestination] = useState('');
  const [probe, setProbe] = useState<SshHostKeyProbe | null>(null);
  const [signInMethod, setSignInMethod] = useState<SignInMethod>('config');
  const [keyFilePath, setKeyFilePath] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  const [renamingHostId, setRenamingHostId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState('');
  const [rowError, setRowError] = useState<{ hostId: string; message: string } | null>(null);
  const [removeTarget, setRemoveTarget] = useState<SshHostStatus | null>(null);
  /**
   * Counts Add host sessions. Cancel can run while a probe or an add is in flight, and the answer must
   * then land nowhere: not reopen the form on the trust step, not write an error into a closed one.
   */
  const addSessionRef = useRef(0);

  useEffect(() => {
    // Neither load rejects: a failure is store state shown below.
    void loadHosts();
    void loadClient();
  }, [loadHosts, loadClient]);

  const signInOptions = useMemo<SegmentedControlOption<SignInMethod>[]>(() => [
    { value: 'config', label: t`My SSH config`, tip: t`Use your own ssh setup: its config, agent and keys, as a terminal does`, testId: 'ssh-signin-config' },
    { value: 'key-file', label: t`Key file`, tip: t`A private key file; Kangentic keeps a copy in its own folder`, testId: 'ssh-signin-key-file' },
    { value: 'create-key', label: t`Password`, tip: t`Use the password once to add a key Kangentic makes. It is never stored`, testId: 'ssh-signin-password' },
  ], [t]);

  function resetAdd(): void {
    addSessionRef.current += 1;
    setStep('closed');
    setName('');
    setDestination('');
    setProbe(null);
    setSignInMethod('config');
    setKeyFilePath('');
    setPassword('');
    setBusy(false);
    setAddError(null);
  }

  async function handleContinue(): Promise<void> {
    const session = addSessionRef.current;
    setBusy(true);
    setAddError(null);
    try {
      const learned = await probeHostKey(destination.trim());
      if (session !== addSessionRef.current) return;
      setProbe(learned);
      setStep('trust');
    } catch (error) {
      if (session !== addSessionRef.current) return;
      setAddError(describeIpcError(error));
    } finally {
      if (session === addSessionRef.current) setBusy(false);
    }
  }

  async function handleAdd(): Promise<void> {
    if (!probe) return;
    const session = addSessionRef.current;
    setBusy(true);
    setAddError(null);
    const signIn: SshSignIn = signInMethod === 'key-file'
      ? { method: 'key-file', keyFilePath: keyFilePath.trim() }
      : signInMethod === 'create-key'
        ? { method: 'create-key', password }
        : { method: 'config' };
    try {
      await addHost({ name: name.trim(), destination: destination.trim(), signIn, expectedFingerprint: probe.fingerprint });
      if (session === addSessionRef.current) resetAdd();
    } catch (error) {
      if (session !== addSessionRef.current) return;
      // The password is not kept past a failed attempt.
      setPassword('');
      setAddError(describeIpcError(error));
      setBusy(false);
    }
  }

  async function runRowAction(hostId: string, action: () => Promise<void>): Promise<void> {
    setRowError(null);
    try {
      await action();
    } catch (error) {
      setRowError({ hostId, message: describeIpcError(error) });
    }
  }

  async function commitRename(hostId: string): Promise<void> {
    const trimmed = renameDraft.trim();
    setRenamingHostId(null);
    if (trimmed.length === 0) return;
    await runRowAction(hostId, () => renameHost(hostId, trimmed));
  }

  const canContinue = name.trim().length > 0 && destination.trim().length > 0 && !busy;
  const canAdd = !busy
    && (signInMethod === 'config'
      || (signInMethod === 'key-file' && keyFilePath.trim().length > 0)
      || (signInMethod === 'create-key' && password.length > 0));

  const removeName = removeTarget?.host.name ?? '';
  const removeProjectCount = removeTarget?.projectCount ?? 0;
  const removeMessage = removeProjectCount === 0
    ? t`Remove "${removeName}"? Kangentic stops connecting to it. Nothing on the host is deleted.`
    : plural(removeProjectCount, {
      one: `Remove "${removeName}"? Its # project leaves Kangentic and its agents are suspended. Nothing on the host is deleted.`,
      other: `Remove "${removeName}"? Its # projects leave Kangentic and their agents are suspended. Nothing on the host is deleted.`,
    });

  return (
    <div className="space-y-4">
      <SettingsCard
        icon={<Server size={16} />}
        label={hostsHeading.label}
        description={hostsHeading.description}
        searchId={hostsHeading.searchId}
        // Beta until it has run on a real host for Claude Code and Cursor (the decided bound on "production ready").
        tag={t`Beta`}
        testId="ssh-hosts-card"
      >
        <CardTile className="flex flex-col gap-2.5" testId="ssh-hosts-tile">
          {hostsError ? <ReportedError error={hostsError} testId="ssh-hosts-load-error" /> : null}
          {hostsLoaded && hosts.length === 0 && step === 'closed' ? (
            <p className="text-sm text-fg-faint" data-testid="ssh-no-hosts"><Trans>No hosts yet.</Trans></p>
          ) : null}

          {hosts.length > 0 ? (
            <ul className="space-y-2">
              {hosts.map((status) => {
                const { host } = status;
                const connection = connectionDisplay(status.state, i18n);
                const since = status.since ? formatShortDateTime(status.since) : '';
                const projectCount = status.projectCount;
                const detail = status.state === 'unreachable' ? status.detail : null;
                const changedKey = detail !== null && CHANGED_KEY_PATTERN.test(detail);
                return (
                  <li
                    key={host.id}
                    className="rounded-md border border-edge bg-surface-hover/30 px-3 py-2 space-y-1.5"
                    data-testid="ssh-host-row"
                  >
                    <div className="flex items-center justify-between gap-3">
                      {renamingHostId === host.id ? (
                        <div className="flex-1 flex items-center gap-1">
                          <input
                            type="text"
                            autoFocus
                            maxLength={60}
                            className={`${INPUT_CLASS} flex-1`}
                            value={renameDraft}
                            aria-label={t`Host name`}
                            onChange={(event) => setRenameDraft(event.target.value)}
                            onKeyDown={(event) => {
                              // The panel dismisses on a bubble-phase document Escape, so cancelling the rename must not reach it.
                              event.stopPropagation();
                              if (event.key === 'Enter') void commitRename(host.id);
                              if (event.key === 'Escape') setRenamingHostId(null);
                            }}
                          />
                          <Tooltip label={t`Save name`}>
                            <button
                              type="button"
                              className="shrink-0 rounded p-1.5 text-fg-faint hover:text-fg hover:bg-surface-hover transition-colors"
                              aria-label={t`Save name`}
                              onClick={() => void commitRename(host.id)}
                            >
                              <Check size={14} />
                            </button>
                          </Tooltip>
                          <Tooltip label={t`Cancel`}>
                            <button
                              type="button"
                              className="shrink-0 rounded p-1.5 text-fg-faint hover:text-fg hover:bg-surface-hover transition-colors"
                              aria-label={t`Cancel`}
                              onClick={() => setRenamingHostId(null)}
                            >
                              <X size={14} />
                            </button>
                          </Tooltip>
                        </div>
                      ) : (
                        <>
                          <div className="min-w-0 flex items-center gap-2">
                            <span className="text-sm text-fg-secondary truncate" data-testid="ssh-host-name">{host.name}</span>
                            <Tooltip label={host.destination}>
                              <span className="min-w-0">
                                <Pill size="sm" className="shrink-0 max-w-[16rem] truncate bg-surface-hover/60 text-fg-faint font-mono" data-testid="ssh-host-destination">
                                  {host.destination}
                                </Pill>
                              </span>
                            </Tooltip>
                          </div>
                          <div className="shrink-0 flex items-center gap-1">
                            {status.state !== 'connected' ? (
                              <Tooltip label={t`Reconnect`}>
                                <button
                                  type="button"
                                  className="rounded p-1.5 text-fg-faint hover:text-fg hover:bg-surface-hover transition-colors"
                                  aria-label={t`Reconnect`}
                                  data-testid="ssh-host-reconnect"
                                  onClick={() => void runRowAction(host.id, () => reconnectHost(host.id))}
                                >
                                  <RefreshCw size={14} />
                                </button>
                              </Tooltip>
                            ) : null}
                            <Tooltip label={t`Rename`}>
                              <button
                                type="button"
                                className="rounded p-1.5 text-fg-faint hover:text-fg hover:bg-surface-hover transition-colors"
                                aria-label={t`Rename`}
                                data-testid="ssh-host-rename"
                                onClick={() => {
                                  setRenamingHostId(host.id);
                                  setRenameDraft(host.name);
                                }}
                              >
                                <Pencil size={14} />
                              </button>
                            </Tooltip>
                            <Tooltip label={t`Remove`}>
                              <button
                                type="button"
                                className="rounded p-1.5 text-fg-faint hover:text-danger hover:bg-danger/10 transition-colors"
                                aria-label={t`Remove`}
                                data-testid="ssh-host-remove"
                                onClick={() => setRemoveTarget(status)}
                              >
                                <Trash2 size={14} />
                              </button>
                            </Tooltip>
                          </div>
                        </>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-fg-faint">
                      <span className={`flex items-center gap-1 ${connection.className}`} data-testid="ssh-host-connection">
                        {connection.icon}
                        {connection.label}
                      </span>
                      {status.since ? (
                        <Tooltip label={formatDateTime(status.since)}>
                          <span data-testid="ssh-host-connection-since"><Trans>since {since}</Trans></span>
                        </Tooltip>
                      ) : null}
                      <span aria-hidden="true">|</span>
                      <span data-testid="ssh-host-project-count">
                        {plural(projectCount, { one: '# project', other: '# projects' })}
                      </span>
                    </div>
                    {detail ? (
                      <div>
                        <ReportedError error={detail} testId="ssh-host-error" />
                        {changedKey ? (
                          <button
                            type="button"
                            className="mt-2 rounded-md border border-edge px-3 py-1 text-xs text-fg-secondary hover:bg-surface-hover transition-colors"
                            data-testid="ssh-host-forget-key"
                            onClick={() => void runRowAction(host.id, () => forgetHostKey(host.id))}
                          >
                            <Trans>Forget old key</Trans>
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                    {rowError?.hostId === host.id ? <ReportedError error={rowError.message} testId="ssh-host-row-error" /> : null}
                  </li>
                );
              })}
            </ul>
          ) : null}

          {step === 'closed' ? (
            <div>
              <button
                type="button"
                className="inline-flex items-center gap-1.5 rounded-md border border-edge bg-surface-hover px-3 py-1.5 text-sm text-fg hover:bg-surface-hover/70 transition-colors"
                data-testid="ssh-add-host"
                onClick={() => setStep('details')}
              >
                <Plus size={16} />
                <Trans>Add host</Trans>
              </button>
            </div>
          ) : (
            <div className="space-y-3 rounded-md border border-edge bg-surface-hover/40 p-4" data-testid="ssh-add-panel">
              {step === 'details' ? (
                <>
                  <label className="block space-y-1">
                    <span className="text-xs text-fg-muted"><Trans>Name</Trans></span>
                    <input
                      type="text"
                      autoFocus
                      maxLength={60}
                      className={INPUT_CLASS}
                      value={name}
                      placeholder={t`Build server`}
                      data-testid="ssh-add-name"
                      onChange={(event) => setName(event.target.value)}
                    />
                  </label>
                  <label className="block space-y-1">
                    <span className="text-xs text-fg-muted"><Trans>Address</Trans></span>
                    <input
                      type="text"
                      className={`${INPUT_CLASS} font-mono`}
                      value={destination}
                      placeholder={DESTINATION_EXAMPLE}
                      spellCheck={false}
                      autoCapitalize="off"
                      data-testid="ssh-add-destination"
                      onChange={(event) => setDestination(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && canContinue) void handleContinue();
                      }}
                    />
                  </label>
                  <p className="text-xs text-fg-faint">
                    <Trans>A name from your SSH config works too, which is how a jump host or a port is set.</Trans>
                  </p>
                </>
              ) : null}

              {step === 'trust' && probe ? (
                <div className="space-y-2" data-testid="ssh-add-trust">
                  <p className="text-sm text-fg-secondary">
                    <Trans>This is the key {probe.hostname} presents. Trust it only if it matches the host.</Trans>
                  </p>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-xs">
                    <dt className="text-fg-faint"><Trans>Type</Trans></dt>
                    <dd className="font-mono text-fg-secondary">{probe.keyType}</dd>
                    <dt className="text-fg-faint"><Trans>Fingerprint</Trans></dt>
                    <dd className="font-mono text-fg-secondary select-text [overflow-wrap:anywhere]" data-testid="ssh-add-fingerprint">{probe.fingerprint}</dd>
                  </dl>
                  <p className="text-xs text-fg-faint">
                    <Trans>Kangentic records it once. If the host's key ever changes, it refuses to connect.</Trans>
                  </p>
                </div>
              ) : null}

              {step === 'signin' ? (
                <div className="space-y-3" data-testid="ssh-add-signin">
                  <SegmentedControl
                    options={signInOptions}
                    value={signInMethod}
                    onChange={setSignInMethod}
                    quiet
                    ariaLabel={t`How Kangentic signs in`}
                    testId="ssh-signin-method"
                  />
                  {signInMethod === 'config' ? (
                    <p className="text-xs text-fg-faint"><Trans>Kangentic uses your SSH config, agent and keys, the way a terminal does.</Trans></p>
                  ) : null}
                  {signInMethod === 'key-file' ? (
                    <label className="block space-y-1">
                      <span className="text-xs text-fg-muted"><Trans>Path to the private key</Trans></span>
                      <input
                        type="text"
                        className={`${INPUT_CLASS} font-mono`}
                        value={keyFilePath}
                        spellCheck={false}
                        data-testid="ssh-add-key-path"
                        onChange={(event) => setKeyFilePath(event.target.value)}
                      />
                      <span className="block text-xs text-fg-faint"><Trans>Kangentic keeps a copy. A key with a passphrase must be in your SSH agent.</Trans></span>
                    </label>
                  ) : null}
                  {signInMethod === 'create-key' ? (
                    <label className="block space-y-1">
                      <span className="text-xs text-fg-muted"><Trans>Password for the host</Trans></span>
                      <input
                        type="password"
                        className={INPUT_CLASS}
                        value={password}
                        autoComplete="off"
                        data-testid="ssh-add-password"
                        onChange={(event) => setPassword(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && canAdd) void handleAdd();
                        }}
                      />
                      <span className="block text-xs text-fg-faint"><Trans>Used once to add a key Kangentic makes for this host. It is never stored.</Trans></span>
                    </label>
                  ) : null}
                </div>
              ) : null}

              {addError ? <ReportedError error={addError} testId="ssh-add-error" /> : null}

              <div className="flex gap-2">
                {step === 'details' ? (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded-md border border-edge bg-surface-hover px-3 py-1.5 text-sm text-fg hover:bg-surface-hover/70 transition-colors disabled:opacity-50"
                    disabled={!canContinue}
                    data-testid="ssh-add-continue"
                    onClick={() => void handleContinue()}
                  >
                    {busy ? <Loader2 size={14} className="animate-spin" /> : null}
                    <Trans>Continue</Trans>
                  </button>
                ) : null}
                {step === 'trust' ? (
                  <button
                    type="button"
                    className="rounded-md border border-edge bg-surface-hover px-3 py-1.5 text-sm text-fg hover:bg-surface-hover/70 transition-colors"
                    data-testid="ssh-add-trust-accept"
                    onClick={() => {
                      setAddError(null);
                      setStep('signin');
                    }}
                  >
                    <Trans>Trust this key</Trans>
                  </button>
                ) : null}
                {step === 'signin' ? (
                  <button
                    type="button"
                    className="inline-flex items-center gap-1.5 rounded-md border border-edge bg-surface-hover px-3 py-1.5 text-sm text-fg hover:bg-surface-hover/70 transition-colors disabled:opacity-50"
                    disabled={!canAdd}
                    data-testid="ssh-add-submit"
                    onClick={() => void handleAdd()}
                  >
                    {busy ? <Loader2 size={14} className="animate-spin" /> : null}
                    <Trans>Add host</Trans>
                  </button>
                ) : null}
                <button
                  type="button"
                  className="rounded-md border border-edge px-3 py-1.5 text-sm text-fg-secondary hover:bg-surface-hover transition-colors"
                  data-testid="ssh-add-cancel"
                  onClick={resetAdd}
                >
                  <Trans>Cancel</Trans>
                </button>
              </div>
            </div>
          )}
        </CardTile>
      </SettingsCard>

      <SettingsCard
        icon={<Server size={16} />}
        label={clientHeading.label}
        description={clientHeading.description}
        searchId={clientHeading.searchId}
        testId="ssh-client-card"
      >
        {client === null ? (
          <CardStatusRow label={t`Checking`} value={t`Looking for ssh…`} testId="ssh-client-status" />
        ) : client.found ? (
          <CardStatusRow label={t`ssh found`} value={client.version ?? ''} tone="ready" testId="ssh-client-status" />
        ) : (
          <CardStatusRow label={t`ssh not found`} value={client.error ?? ''} tone="failure" testId="ssh-client-status" />
        )}
      </SettingsCard>

      {removeTarget ? (
        <ConfirmDialog
          title={t`Remove host`}
          message={removeMessage}
          confirmLabel={t`Remove`}
          variant="danger"
          onConfirm={() => {
            const target = removeTarget;
            setRemoveTarget(null);
            void runRowAction(target.host.id, () => removeHost(target.host.id));
          }}
          onCancel={() => setRemoveTarget(null)}
        />
      ) : null}
    </div>
  );
}

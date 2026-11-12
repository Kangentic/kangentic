import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Check, CircleExclamationPoint, KeyRound, Loader2, Pencil, Plus, RefreshCw, Server, Trash2, X } from 'lucide-react';
import type { I18n } from '@lingui/core';
import { msg, plural } from '@lingui/core/macro';
import { Trans, useLingui } from '@lingui/react/macro';
import type { SshConfigHost, SshHostConnectionState, SshHostKeyProbe, SshHostProgram, SshHostStatus, SshSignIn } from '../../../../shared/types';
import { formatDateTime, formatShortDateTime } from '../../../lib/datetime';
import { describeIpcError } from '../../../lib/ipc-error';
import { useProjectStore } from '../../../stores/project-store';
import { useSshStore } from '../../../stores/ssh-store';
import { INPUT_CLASS, ReportedError } from '../shared';
import { SettingsCard, CardTile, CardStatusRow } from '../settings-card';
import { SegmentedControl } from '../../SegmentedControl';
import type { SegmentedControlOption } from '../../SegmentedControl';
import { HostAddressInput } from '../../HostAddressInput';
import { Pill } from '../../Pill';
import { Tooltip } from '../../Tooltip';
import { settingProps } from '../settings-registry';
import { ConfirmDialog } from '../../dialogs/ConfirmDialog';
import { BaseDialog } from '../../dialogs/BaseDialog';

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

/** A changed host key is the one failure with its own fix: the row's key icon shows the new key to trust. */
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
      return { label: i18n._(msg`Unreachable`), className: 'text-danger', icon: <CircleExclamationPoint size={12} /> };
    case 'stopped':
      return { label: i18n._(msg`Stopped`), className: 'text-fg-faint', icon: <X size={12} /> };
  }
}

/** How often a connected host's program is asked how many terminals it holds. */
const PROGRAM_REFRESH_MS = 15_000;

/** The key a host whose key changed presents now, shown beside the one trusted before, for the user to trust or not. */
function NewHostKeyDialog({ probe, busy, onConfirm, onClose }: {
  probe: SshHostKeyProbe;
  busy: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const { t } = useLingui();
  const hostname = probe.hostname;
  return (
    <BaseDialog
      onClose={onClose}
      title={t`New host key`}
      testId="ssh-trust-new-key"
      footer={
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-1.5 text-xs text-fg-muted hover:text-fg-secondary border border-edge-input hover:border-fg-faint rounded transition-colors"
            data-testid="ssh-trust-new-key-cancel"
          >
            <Trans>Cancel</Trans>
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={onConfirm}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs rounded transition-colors bg-accent-emphasis hover:bg-accent text-accent-on disabled:opacity-50"
            data-testid="ssh-trust-new-key-confirm"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : null}
            <Trans>Trust new key</Trans>
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        <p className="text-sm font-medium text-fg">
          <Trans>{hostname} now presents a different key.</Trans>
        </p>
        <div className="rounded-md border border-edge bg-surface-hover/40 px-3 py-2.5">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
            <dt className="text-fg-faint"><Trans>Type</Trans></dt>
            <dd className="font-mono text-fg-secondary">{probe.keyType}</dd>
            {probe.previousFingerprint ? (
              <>
                <dt className="text-fg-faint"><Trans>Before</Trans></dt>
                <dd className="font-mono text-fg-secondary select-text [overflow-wrap:anywhere]" data-testid="ssh-trust-previous-fingerprint">{probe.previousFingerprint}</dd>
              </>
            ) : null}
            <dt className="text-fg-faint"><Trans>Now</Trans></dt>
            <dd className="font-mono text-fg select-text [overflow-wrap:anywhere]" data-testid="ssh-trust-new-fingerprint">{probe.fingerprint}</dd>
          </dl>
        </div>
        <p className="text-xs text-fg-faint">
          <Trans>Trust it only if you know the host was rebuilt or reinstalled. Kangentic records it once and connects.</Trans>
        </p>
      </div>
    </BaseDialog>
  );
}

/** One fact on a host row's facts line: a hairline separates it from the one before. */
const FACT_CELL_CLASS = 'border-l border-edge pl-3';

/** Whether two answers draw the same line, so a poll that changed nothing renders nothing. */
function drawsSameLine(current: SshHostProgram | null, next: SshHostProgram): boolean {
  return current !== null
    && current.version === next.version
    && current.appVersion === next.appVersion
    && current.liveSessions === next.liveSessions;
}

/**
 * The Kangentic program on a connected host: its version and how many terminals it is holding. Quiet when the
 * host cannot answer: the row above already says whether the host is connected, and this line is extra.
 */
function HostProgramLine({ hostId }: { hostId: string }) {
  const hostProgram = useSshStore((state) => state.hostProgram);
  const [program, setProgram] = useState<SshHostProgram | null>(null);

  useEffect(() => {
    let cancelled = false;
    const refresh = (): void => {
      hostProgram(hostId).then(
        (answer) => { if (!cancelled) setProgram((current) => (drawsSameLine(current, answer) ? current : answer)); },
        () => { if (!cancelled) setProgram(null); },
      );
    };
    refresh();
    const timer = setInterval(refresh, PROGRAM_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [hostId, hostProgram]);

  if (!program) return null;
  const version = program.version;
  const appVersion = program.appVersion;
  const liveSessions = program.liveSessions;
  const older = version !== null && appVersion !== null && version !== appVersion;
  return (
    <span className="flex basis-full flex-wrap items-center gap-x-3" data-testid="ssh-host-program">
      <span data-testid="ssh-host-program-version">
        {version === null
          ? <Trans>Program version unknown</Trans>
          : older
            ? <Trans>Program {version} (this app is {appVersion})</Trans>
            : <Trans>Program {version}</Trans>}
      </span>
      <span className={FACT_CELL_CLASS} data-testid="ssh-host-program-sessions">
        {plural(liveSessions, { one: '# terminal running', other: '# terminals running' })}
      </span>
    </span>
  );
}

/**
 * The fields behind each way of signing in: a note for the user's own config, a key file path with a picker, or
 * the password asked once. Add host and the row's edit form both show it, so they read the same.
 */
function SignInFields({ prefix, method, keyFilePath, onKeyFilePathChange, onChooseKeyFile, password, onPasswordChange, onSubmit }: {
  prefix: 'ssh-add' | 'ssh-edit';
  method: SignInMethod;
  keyFilePath: string;
  onKeyFilePathChange: (value: string) => void;
  onChooseKeyFile: () => void;
  password: string;
  onPasswordChange: (value: string) => void;
  onSubmit: () => void;
}) {
  if (method === 'config') {
    return <p className="text-xs text-fg-faint"><Trans>Kangentic uses your SSH config, agent and keys, the way a terminal does.</Trans></p>;
  }
  if (method === 'key-file') {
    return (
      <label className="block space-y-1">
        <span className="text-xs text-fg-muted"><Trans>Path to the private key</Trans></span>
        <div className="flex gap-2">
          <input
            type="text"
            className={`${INPUT_CLASS} min-w-0 flex-1 font-mono`}
            value={keyFilePath}
            spellCheck={false}
            data-testid={`${prefix}-key-path`}
            onChange={(event) => onKeyFilePathChange(event.target.value)}
          />
          <button
            type="button"
            className="shrink-0 rounded-md border border-edge bg-surface-hover px-3 py-1.5 text-sm text-fg hover:bg-surface-hover/70 transition-colors"
            data-testid={`${prefix}-key-choose`}
            onClick={onChooseKeyFile}
          >
            <Trans>Choose…</Trans>
          </button>
        </div>
        <span className="block text-xs text-fg-faint"><Trans>A key with a passphrase must be in your SSH agent.</Trans></span>
      </label>
    );
  }
  return (
    <label className="block space-y-1">
      <span className="text-xs text-fg-muted"><Trans>Password for the host</Trans></span>
      <input
        type="password"
        className={INPUT_CLASS}
        value={password}
        autoComplete="off"
        data-testid={`${prefix}-password`}
        onChange={(event) => onPasswordChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onSubmit();
        }}
      />
      <span className="block text-xs text-fg-faint"><Trans>Used once to add a key Kangentic makes for this host. It is never stored.</Trans></span>
    </label>
  );
}

/** The sign-in choice in a host's edit form: the three ways, or leave it as it is. */
type EditSignInMethod = SignInMethod | 'keep';

export function SshTab() {
  const { t, i18n } = useLingui();
  const hosts = useSshStore((state) => state.hosts);
  const hostsLoaded = useSshStore((state) => state.hostsLoaded);
  const hostsError = useSshStore((state) => state.hostsError);
  const client = useSshStore((state) => state.client);
  const loadHosts = useSshStore((state) => state.loadHosts);
  const loadClient = useSshStore((state) => state.loadClient);
  const probeHostKey = useSshStore((state) => state.probeHostKey);
  const listConfigHosts = useSshStore((state) => state.listConfigHosts);
  const addHost = useSshStore((state) => state.addHost);
  const removeHost = useSshStore((state) => state.removeHost);
  const clearHostData = useSshStore((state) => state.clearHostData);
  const updateHost = useSshStore((state) => state.updateHost);
  const reconnectHost = useSshStore((state) => state.reconnectHost);
  const checkKeyFile = useSshStore((state) => state.checkKeyFile);
  const probeChangedKey = useSshStore((state) => state.probeChangedKey);
  const trustNewKey = useSshStore((state) => state.trustNewKey);

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

  /** The host whose row is open for editing, and the form's fields. One host is edited at a time. */
  const [editTarget, setEditTarget] = useState<SshHostStatus | null>(null);
  const [editName, setEditName] = useState('');
  const [editDestination, setEditDestination] = useState('');
  const [editSignInMethod, setEditSignInMethod] = useState<EditSignInMethod>('keep');
  const [editKeyFilePath, setEditKeyFilePath] = useState('');
  const [editPassword, setEditPassword] = useState('');
  /** The key a new address presents, shown for the user to trust before the address is saved. */
  const [editProbe, setEditProbe] = useState<SshHostKeyProbe | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ hostId: string; message: string } | null>(null);
  const [removeTarget, setRemoveTarget] = useState<SshHostStatus | null>(null);
  const [clearTarget, setClearTarget] = useState<SshHostStatus | null>(null);
  /** A host whose key changed, with the key it presents now, while the user decides whether to trust it. */
  const [trustTarget, setTrustTarget] = useState<{ status: SshHostStatus; probe: SshHostKeyProbe } | null>(null);
  const [trustBusy, setTrustBusy] = useState(false);

  async function openTrustNewKey(status: SshHostStatus): Promise<void> {
    setRowError(null);
    try {
      setTrustTarget({ status, probe: await probeChangedKey(status.host.id) });
    } catch (error) {
      setRowError({ hostId: status.host.id, message: describeIpcError(error) });
    }
  }

  async function confirmTrustNewKey(): Promise<void> {
    if (!trustTarget) return;
    const { status, probe: shownKey } = trustTarget;
    setTrustBusy(true);
    await runRowAction(status.host.id, () => trustNewKey(status.host.id, shownKey.fingerprint));
    setTrustBusy(false);
    setTrustTarget(null);
  }
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

  // The names in the user's SSH config, for the address fields. Only a convenience: a config that cannot be read is no suggestions.
  const [configHosts, setConfigHosts] = useState<SshConfigHost[]>([]);
  useEffect(() => {
    let current = true;
    listConfigHosts().then((found) => {
      if (current) setConfigHosts(found);
    }, () => undefined);
    return () => {
      current = false;
    };
  }, [listConfigHosts]);

  const signInOptions = useMemo<SegmentedControlOption<SignInMethod>[]>(() => [
    { value: 'config', label: t`My SSH config`, tip: t`Use your own ssh setup: its config, agent and keys, as a terminal does`, testId: 'ssh-signin-config' },
    { value: 'key-file', label: t`Key file`, tip: t`A private key file; Kangentic keeps a copy in its own folder`, testId: 'ssh-signin-key-file' },
    { value: 'create-key', label: t`Password`, tip: t`Use the password once to add a key Kangentic makes. It is never stored`, testId: 'ssh-signin-password' },
  ], [t]);

  const editSignInOptions = useMemo<SegmentedControlOption<EditSignInMethod>[]>(() => [
    { value: 'keep', label: t`Keep`, tip: t`Keep signing in the way the host does now`, testId: 'ssh-edit-signin-keep' },
    ...signInOptions.map((option) => ({ ...option, testId: option.testId?.replace('ssh-signin-', 'ssh-edit-signin-') })),
  ], [t, signInOptions]);

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

  /**
   * Pick the private key in the OS dialog, which opens in the user's ~/.ssh. A key that cannot be used (it has a
   * passphrase, or is no key) is refused now, with the reason, instead of when Add host is pressed.
   */
  async function chooseKeyFile(): Promise<void> {
    const session = addSessionRef.current;
    const chosen = await window.electronAPI.dialog.selectFile({ title: t`Private key`, defaultPath: '~/.ssh' });
    if (!chosen || session !== addSessionRef.current) return;
    setAddError(null);
    try {
      await checkKeyFile(chosen);
      if (session === addSessionRef.current) setKeyFilePath(chosen);
    } catch (error) {
      if (session !== addSessionRef.current) return;
      setKeyFilePath('');
      setAddError(describeIpcError(error));
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

  function openEdit(status: SshHostStatus): void {
    setRowError(null);
    setEditTarget(status);
    setEditName(status.host.name);
    setEditDestination(status.host.destination);
    setEditSignInMethod('keep');
    setEditKeyFilePath('');
    setEditPassword('');
    setEditProbe(null);
    setEditBusy(false);
    setEditError(null);
  }

  function closeEdit(): void {
    setEditTarget(null);
    setEditPassword('');
    setEditProbe(null);
    setEditBusy(false);
    setEditError(null);
  }

  async function chooseEditKeyFile(): Promise<void> {
    const chosen = await window.electronAPI.dialog.selectFile({ title: t`Private key`, defaultPath: '~/.ssh' });
    if (!chosen) return;
    setEditError(null);
    try {
      await checkKeyFile(chosen);
      setEditKeyFilePath(chosen);
    } catch (error) {
      setEditKeyFilePath('');
      setEditError(describeIpcError(error));
    }
  }

  /**
   * Save the form. A new address is first shown its key to trust, in the same form, and saved only on the second
   * press, so the host that answers at it is the one the user agreed to.
   */
  async function saveEdit(): Promise<void> {
    if (!editTarget) return;
    const target = editTarget;
    const destination = editDestination.trim();
    setEditBusy(true);
    setEditError(null);
    try {
      if (destination !== target.host.destination && !editProbe) {
        setEditProbe(await probeHostKey(destination));
        return;
      }
      const signIn: SshSignIn | undefined = editSignInMethod === 'key-file'
        ? { method: 'key-file', keyFilePath: editKeyFilePath.trim() }
        : editSignInMethod === 'create-key'
          ? { method: 'create-key', password: editPassword }
          : editSignInMethod === 'config'
            ? { method: 'config' }
            : undefined;
      await updateHost(target.host.id, { name: editName.trim(), destination, expectedFingerprint: editProbe?.fingerprint, signIn });
      closeEdit();
    } catch (error) {
      // The password is not kept past a failed attempt.
      setEditPassword('');
      setEditError(describeIpcError(error));
    } finally {
      setEditBusy(false);
    }
  }

  const editAddressChanged = editTarget !== null && editDestination.trim() !== editTarget.host.destination;
  // A key Kangentic made was added to the old machine only, so a new address needs a new sign-in.
  const editNeedsSignIn = editAddressChanged && editTarget?.host.key_created === true && editSignInMethod === 'keep';
  const canSaveEdit = !editBusy
    && editName.trim().length > 0
    && editDestination.trim().length > 0
    && !editNeedsSignIn
    && (editSignInMethod !== 'key-file' || editKeyFilePath.trim().length > 0)
    && (editSignInMethod !== 'create-key' || editPassword.length > 0);

  const canContinue = name.trim().length > 0 && destination.trim().length > 0 && !busy;
  const canAdd = !busy
    && (signInMethod === 'config'
      || (signInMethod === 'key-file' && keyFilePath.trim().length > 0)
      || (signInMethod === 'create-key' && password.length > 0));

  const removeName = removeTarget?.host.name ?? '';
  const removeProjectCount = removeTarget?.projectCount ?? 0;
  // One sentence, and nothing in it is deleted: Remove hides the projects and Clear data is its own action.
  const removeMessage = removeProjectCount === 0
    ? t`Removing "${removeName}" forgets the connection, and nothing is deleted.`
    : t`Removing "${removeName}" hides its projects and suspends their agents until it is added again, and nothing is deleted.`;
  // Read when the dialog opens, so a change to the project list does not redraw every host row.
  const clearProjects = useMemo(
    () => (clearTarget ? useProjectStore.getState().projects.filter((project) => project.remote?.hostId === clearTarget.host.id) : []),
    [clearTarget],
  );
  const clearCount = clearProjects.length;
  const clearMessage = (
    <>
      <p>
        {plural(clearCount, {
          one: 'Stop the running agents of this project and delete its boards, tasks and history for good? Its files on the host stay.',
          other: 'Stop the running agents of these # projects and delete their boards, tasks and history for good? Their files on the host stay.',
        })}
      </p>
      <ul className="mt-3 divide-y divide-edge rounded-md border border-edge text-sm" data-testid="ssh-clear-data-projects">
        {clearProjects.map((project) => (
          <li key={project.id} className="flex items-center justify-between gap-3 px-3 py-1.5">
            <span className="min-w-0 truncate text-fg">{project.name}</span>
            <span className="min-w-0 truncate font-mono text-xs text-fg-faint">{project.remote?.path}</span>
          </li>
        ))}
      </ul>
    </>
  );

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
          {hostsLoaded && !hostsError && hosts.length === 0 && step === 'closed' ? (
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
                    className="rounded-md border border-edge bg-surface-hover/40 px-3 py-2.5 space-y-2.5"
                    data-testid="ssh-host-row"
                  >
                    <div className="flex items-center justify-between gap-3">
                      {editTarget?.host.id === host.id ? null : (
                        <>
                          <div className="min-w-0 flex items-center gap-2">
                            <span className="text-sm font-medium text-fg truncate" data-testid="ssh-host-name">{host.name}</span>
                          </div>
                          <div className="shrink-0 flex items-center gap-1">
                            {changedKey ? (
                              <Tooltip label={t`Trust new key`}>
                                <button
                                  type="button"
                                  className="rounded p-1.5 text-fg-faint hover:text-fg hover:bg-surface-hover transition-colors"
                                  aria-label={t`Trust new key`}
                                  data-testid="ssh-host-trust-new-key"
                                  onClick={() => void openTrustNewKey(status)}
                                >
                                  <KeyRound size={14} />
                                </button>
                              </Tooltip>
                            ) : null}
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
                            <Tooltip label={t({ message: 'Edit', context: 'host row action' })}>
                              <button
                                type="button"
                                className="rounded p-1.5 text-fg-faint hover:text-fg hover:bg-surface-hover transition-colors"
                                aria-label={t({ message: 'Edit', context: 'host row action' })}
                                data-testid="ssh-host-edit"
                                onClick={() => openEdit(status)}
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
                    {editTarget?.host.id === host.id ? (
                      <div className="space-y-3" data-testid="ssh-edit-form">
                        <label className="block space-y-1">
                          <span className="text-xs text-fg-muted"><Trans>Name</Trans></span>
                          <input
                            type="text"
                            autoFocus
                            maxLength={60}
                            className={INPUT_CLASS}
                            value={editName}
                            data-testid="ssh-edit-name"
                            onChange={(event) => setEditName(event.target.value)}
                            onKeyDown={(event) => {
                              // The panel dismisses on a bubble-phase document Escape, so cancelling the edit must not reach it.
                              if (event.key === 'Escape') {
                                event.stopPropagation();
                                closeEdit();
                              }
                              if (event.key === 'Enter' && canSaveEdit) void saveEdit();
                            }}
                          />
                        </label>
                        <label className="block space-y-1">
                          <span className="text-xs text-fg-muted"><Trans>Address</Trans></span>
                          <HostAddressInput
                            value={editDestination}
                            onChange={(next) => {
                              setEditDestination(next);
                              // A different address is a different machine: the key shown before no longer applies.
                              setEditProbe(null);
                            }}
                            onEnter={() => {
                              if (canSaveEdit) void saveEdit();
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Escape') {
                                event.stopPropagation();
                                closeEdit();
                              }
                            }}
                            suggestions={configHosts}
                            testId="ssh-edit-destination"
                            readOnly={editBusy}
                          />
                        </label>

                        <SegmentedControl
                          options={editSignInOptions}
                          value={editSignInMethod}
                          onChange={setEditSignInMethod}
                          quiet
                          ariaLabel={t`How Kangentic signs in`}
                          testId="ssh-edit-signin-method"
                        />
                        {editSignInMethod === 'keep' ? null : (
                          <SignInFields
                            prefix="ssh-edit"
                            method={editSignInMethod}
                            keyFilePath={editKeyFilePath}
                            onKeyFilePathChange={setEditKeyFilePath}
                            onChooseKeyFile={() => void chooseEditKeyFile()}
                            password={editPassword}
                            onPasswordChange={setEditPassword}
                            onSubmit={() => {
                              if (canSaveEdit) void saveEdit();
                            }}
                          />
                        )}
                        {editNeedsSignIn ? (
                          <p className="text-xs text-fg-faint" data-testid="ssh-edit-needs-signin">
                            <Trans>The key Kangentic made was added to the old address, so choose how to sign in to the new one.</Trans>
                          </p>
                        ) : null}

                        {editProbe ? (
                          <div className="rounded-md border border-edge bg-surface-hover/40 px-3 py-2.5 space-y-1.5" data-testid="ssh-edit-trust">
                            <p className="text-sm font-medium text-fg"><Trans>This is the key {editProbe.hostname} presents.</Trans></p>
                            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
                              <dt className="text-fg-faint"><Trans>Type</Trans></dt>
                              <dd className="font-mono text-fg-secondary">{editProbe.keyType}</dd>
                              <dt className="text-fg-faint"><Trans>Fingerprint</Trans></dt>
                              <dd className="font-mono text-fg select-text [overflow-wrap:anywhere]" data-testid="ssh-edit-fingerprint">{editProbe.fingerprint}</dd>
                            </dl>
                          </div>
                        ) : null}

                        {editError ? <ReportedError error={editError} testId="ssh-edit-error" /> : null}

                        <div className="flex gap-2">
                          <button
                            type="button"
                            className="inline-flex items-center gap-1.5 rounded-md border border-edge bg-surface-hover px-3 py-1.5 text-sm text-fg hover:bg-surface-hover/70 transition-colors disabled:opacity-50"
                            disabled={!canSaveEdit}
                            data-testid="ssh-edit-save"
                            onClick={() => void saveEdit()}
                          >
                            {editBusy ? <Loader2 size={14} className="animate-spin" /> : null}
                            {editAddressChanged && !editProbe ? <Trans>Continue</Trans> : editProbe ? <Trans>Trust this key and save</Trans> : <Trans>Save</Trans>}
                          </button>
                          <button
                            type="button"
                            className="rounded-md px-3 py-1.5 text-sm text-fg-muted hover:text-fg hover:bg-surface-hover transition-colors"
                            data-testid="ssh-edit-cancel"
                            onClick={closeEdit}
                          >
                            <Trans>Cancel</Trans>
                          </button>
                        </div>
                      </div>
                    ) : (
                      // The address on its own line, so up to four icons never squeeze the name. A long one is cut
                      // here and its whole value is in the tip.
                      <div className="min-w-0 -mt-1.5">
                        <Tooltip label={host.destination}>
                          <span className="inline-flex max-w-full min-w-0">
                            <Pill size="sm" className="max-w-full truncate bg-surface-hover/60 text-fg-faint font-mono" data-testid="ssh-host-destination">
                              {host.destination}
                            </Pill>
                          </span>
                        </Tooltip>
                      </div>
                    )}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-edge pt-2.5 text-xs text-fg-faint">
                      <span className="flex items-center gap-2">
                        <span className={`flex items-center gap-1 font-medium ${connection.className}`} data-testid="ssh-host-connection">
                          {connection.icon}
                          {connection.label}
                        </span>
                        {status.since ? (
                          <Tooltip label={formatDateTime(status.since)}>
                            <span data-testid="ssh-host-connection-since"><Trans>since {since}</Trans></span>
                          </Tooltip>
                        ) : null}
                      </span>
                      <span className={FACT_CELL_CLASS} data-testid="ssh-host-project-count">
                        {plural(projectCount, { one: '# project', other: '# projects' })}
                      </span>
                      {status.state === 'connected' ? <HostProgramLine hostId={host.id} /> : null}
                      {/* Beside the project count it acts on. Not shown with no projects: there is nothing to clear. */}
                      {projectCount > 0 ? (
                        <button
                          type="button"
                          className="ml-auto rounded-md border border-danger/60 px-2.5 py-0.5 text-xs text-danger hover:bg-danger/10 transition-colors"
                          data-testid="ssh-host-clear-data"
                          onClick={() => setClearTarget(status)}
                        >
                          <Trans>Clear data</Trans>
                        </button>
                      ) : null}
                    </div>
                    {detail ? (
                      <div>
                        <ReportedError error={detail} testId="ssh-host-error" />
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
                    <HostAddressInput
                      value={destination}
                      onChange={setDestination}
                      onEnter={() => {
                        if (canContinue) void handleContinue();
                      }}
                      suggestions={configHosts}
                      placeholder={DESTINATION_EXAMPLE}
                      testId="ssh-add-destination"
                      readOnly={busy}
                    />
                  </label>
                  <p className="text-xs text-fg-faint">
                    <Trans>A name from your SSH config works too, which is how a jump host or a port is set.</Trans>
                  </p>
                </>
              ) : null}

              {step === 'trust' && probe ? (
                <div className="space-y-3" data-testid="ssh-add-trust">
                  <p className="text-sm font-medium text-fg">
                    <Trans>This is the key {probe.hostname} presents.</Trans>
                  </p>
                  <div className="rounded-md border border-edge bg-surface-hover/40 px-3 py-2.5">
                    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-xs">
                      <dt className="text-fg-faint"><Trans>Type</Trans></dt>
                      <dd className="font-mono text-fg-secondary">{probe.keyType}</dd>
                      <dt className="text-fg-faint"><Trans>Fingerprint</Trans></dt>
                      <dd className="font-mono text-fg select-text [overflow-wrap:anywhere]" data-testid="ssh-add-fingerprint">{probe.fingerprint}</dd>
                    </dl>
                  </div>
                  <p className="text-xs text-fg-faint">
                    <Trans>Trust it only if it matches the host. Kangentic records it once, and refuses the host if its key ever changes.</Trans>
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
                  <SignInFields
                    prefix="ssh-add"
                    method={signInMethod}
                    keyFilePath={keyFilePath}
                    onKeyFilePathChange={setKeyFilePath}
                    onChooseKeyFile={() => void chooseKeyFile()}
                    password={password}
                    onPasswordChange={setPassword}
                    onSubmit={() => {
                      if (canAdd) void handleAdd();
                    }}
                  />
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

      {trustTarget ? (
        <NewHostKeyDialog
          probe={trustTarget.probe}
          busy={trustBusy}
          onConfirm={() => void confirmTrustNewKey()}
          onClose={() => setTrustTarget(null)}
        />
      ) : null}

      {removeTarget ? (
        <ConfirmDialog
          title={t`Remove host`}
          message={removeMessage}
          confirmLabel={t`Remove`}
          // Not a warning: nothing is deleted, so the button is the accent colour and the icon is the host's.
          variant="default"
          icon={<Server size={20} className="text-accent-fg" />}
          testId="ssh-remove-host-confirm"
          onConfirm={() => {
            const target = removeTarget;
            setRemoveTarget(null);
            void runRowAction(target.host.id, () => removeHost(target.host.id));
          }}
          onCancel={() => setRemoveTarget(null)}
        />
      ) : null}

      {clearTarget ? (
        <ConfirmDialog
          title={t`Clear data`}
          message={clearMessage}
          confirmLabel={t`Clear data`}
          variant="danger"
          testId="ssh-clear-data-confirm"
          onConfirm={() => {
            const target = clearTarget;
            setClearTarget(null);
            void runRowAction(target.host.id, () => clearHostData(target.host.id));
          }}
          onCancel={() => setClearTarget(null)}
        />
      ) : null}
    </div>
  );
}

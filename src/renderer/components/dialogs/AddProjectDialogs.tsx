import { useState, type ReactNode } from 'react';
import { CircleAlert, Laptop, Loader2, Server } from 'lucide-react';
import { Trans, useLingui } from '@lingui/react/macro';
import type { SshHostConnectionState } from '../../../shared/types';
import { useAddProject } from '../../hooks/useAddProject';
import { useProjectStore } from '../../stores/project-store';
import { useSshStore } from '../../stores/ssh-store';
import { ReportedError } from '../settings/shared';
import { FIELD_CONTROL_CLASS, Field } from '../Field';
import { BaseDialog } from './BaseDialog';

/**
 * Add project, once a host exists (#913). The chooser lists This computer first, then each host with
 * where its connection stands. This computer goes to the folder picker as it always has, and a host opens
 * a small form with the host chosen and a folder field. With no host configured neither dialog is ever
 * shown: Add project opens the folder picker directly.
 *
 * Mounted once in AppLayout's overlay block, driven by `useSshStore.addProjectDialog`, so the sidebar
 * button, the collapsed rail and the welcome screen all reach the same two dialogs.
 */

function lastPathSegment(folderPath: string): string {
  const segments = folderPath.trim().split('/').filter((segment) => segment.length > 0 && segment !== '~');
  return segments[segments.length - 1] ?? '';
}

function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']*': (?:Error: )?/, '');
}

function useStateLabel(): (state: SshHostConnectionState) => string {
  const { t } = useLingui();
  return (state) => {
    switch (state) {
      case 'connected': return t`Connected`;
      case 'connecting': return t`Connecting…`;
      case 'reconnecting': return t`Reconnecting…`;
      case 'unreachable': return t`Unreachable`;
      case 'stopped': return t`Stopped`;
    }
  };
}

function ChooserRow({ icon, name, detail, testId, onClick }: { icon: ReactNode; name: string; detail: ReactNode; testId: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="flex w-full items-center gap-3 rounded-md border border-edge bg-surface-hover/30 px-3 py-2.5 text-left transition-colors hover:bg-surface-hover/60"
    >
      <span className="flex-shrink-0 text-fg-muted" aria-hidden="true">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm text-fg">{name}</span>
        <span className="block truncate text-xs text-fg-faint">{detail}</span>
      </span>
    </button>
  );
}

function AddProjectChooser() {
  const { t } = useLingui();
  const hosts = useSshStore((state) => state.hosts);
  const closeAddProjectDialog = useSshStore((state) => state.closeAddProjectDialog);
  const openAddRemoteProject = useSshStore((state) => state.openAddRemoteProject);
  const stateLabel = useStateLabel();
  const { startLocalAddProject } = useAddProject();

  return (
    <BaseDialog onClose={closeAddProjectDialog} title={t`Add project`} testId="add-project-chooser">
      <div className="space-y-2">
        <ChooserRow
          icon={<Laptop size={16} />}
          name={t`This computer`}
          detail={t`Choose a folder on this machine`}
          testId="add-project-this-computer"
          onClick={() => {
            closeAddProjectDialog();
            void startLocalAddProject();
          }}
        />
        {hosts.map((status) => (
          <ChooserRow
            key={status.host.id}
            icon={status.state === 'unreachable' ? <CircleAlert size={16} className="text-danger" /> : <Server size={16} />}
            name={status.host.name}
            detail={stateLabel(status.state)}
            testId="add-project-host"
            onClick={() => openAddRemoteProject(status.host.id)}
          />
        ))}
      </div>
    </BaseDialog>
  );
}

function AddRemoteProjectForm({ hostId }: { hostId: string }) {
  const { t } = useLingui();
  const host = useSshStore((state) => state.hosts.find((status) => status.host.id === hostId));
  const probeRemoteFolder = useSshStore((state) => state.probeRemoteFolder);
  const closeAddProjectDialog = useSshStore((state) => state.closeAddProjectDialog);
  const createProject = useProjectStore((state) => state.createProject);
  const openProject = useProjectStore((state) => state.openProject);
  const stateLabel = useStateLabel();

  const [folder, setFolder] = useState('');
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const name = nameDraft ?? lastPathSegment(folder);
  const canAdd = folder.trim().length > 0 && name.trim().length > 0 && !busy;

  async function handleAdd(): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      // The folder is checked on the host first, so a typo reads as one, and a host that cannot be
      // reached reads as that (its own words), never as a missing folder.
      const probe = await probeRemoteFolder(hostId, folder);
      if (!probe.exists) {
        setError(t`${probe.path} does not exist on ${host?.host.name ?? ''}.`);
        setBusy(false);
        return;
      }
      const project = await createProject({ name: name.trim(), path: '', remote: { hostId, path: probe.path } });
      closeAddProjectDialog();
      await openProject(project.id);
    } catch (caught) {
      setError(errorText(caught));
      setBusy(false);
    }
  }

  return (
    <BaseDialog
      onClose={closeAddProjectDialog}
      title={t`Add project on ${host?.host.name ?? ''}`}
      testId="add-remote-project"
      footer={
        <div className="flex justify-end gap-3">
          <button
            type="button"
            onClick={closeAddProjectDialog}
            className="px-4 py-1.5 text-xs text-fg-muted hover:text-fg-secondary border border-edge-input hover:border-fg-faint rounded transition-colors"
            data-testid="add-remote-project-cancel"
          >
            <Trans>Cancel</Trans>
          </button>
          <button
            type="button"
            disabled={!canAdd}
            onClick={() => void handleAdd()}
            className="inline-flex items-center gap-1.5 px-4 py-1.5 text-xs rounded transition-colors bg-accent-emphasis hover:bg-accent text-accent-on disabled:opacity-50"
            data-testid="add-remote-project-submit"
          >
            {busy ? <Loader2 size={12} className="animate-spin" /> : null}
            <Trans>Add project</Trans>
          </button>
        </div>
      }
    >
      <div className="space-y-3">
        {host ? (
          <p className="text-xs text-fg-faint" data-testid="add-remote-project-state">
            {stateLabel(host.state)}
          </p>
        ) : null}
        <Field label={t`Folder on the host`} hint={t`An absolute path, or one starting with ~/`}>
          <input
            type="text"
            autoFocus
            className={`${FIELD_CONTROL_CLASS} font-mono`}
            value={folder}
            spellCheck={false}
            autoCapitalize="off"
            data-testid="add-remote-project-folder"
            onChange={(event) => setFolder(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && canAdd) void handleAdd();
            }}
          />
        </Field>
        <Field label={t`Name`}>
          <input
            type="text"
            className={FIELD_CONTROL_CLASS}
            value={name}
            data-testid="add-remote-project-name"
            onChange={(event) => setNameDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && canAdd) void handleAdd();
            }}
          />
        </Field>
        {error ? <ReportedError error={error} testId="add-remote-project-error" /> : null}
      </div>
    </BaseDialog>
  );
}

export function AddProjectDialogs() {
  const dialog = useSshStore((state) => state.addProjectDialog);
  if (dialog.kind === 'chooser') return <AddProjectChooser />;
  if (dialog.kind === 'remote') return <AddRemoteProjectForm key={dialog.hostId} hostId={dialog.hostId} />;
  return null;
}
